// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";
import {IWeb2Json, IFdcVerification} from "../interfaces/IFdc.sol";

/// @title ConditionalRule
/// @notice Pay a fixed recipient, up to a cap — but only once a real-world condition has been proven
///         on-chain by Flare's Data Connector (FDC). Until then the account cannot pay at all.
///
/// @dev The "pay when the world says so" template, and the integration play: one payment composes three
///      Flare surfaces — FCC (the enclave holding the XRPL key), FDC (attesting the release condition
///      from a live Web2 API), and XRPL (native settlement). XRPL escrow can only release on a timeout or
///      a hash preimage; it cannot condition on anything happening in the world. Here the condition is an
///      attested API response — a shipment marked delivered, a milestone closed, a price reached. The
///      enclave never changes; this is one contract.
///
///      ## Why this supersedes FdcEscrowRule (three defects, all verified on Coston2)
///      1. **It could never release.** The old rule called `verifyJsonApi`, which does not exist on the
///         live FdcVerification — the function is `verifyWeb2Json`. Every release() reverted.
///      2. **The committed hash could never match.** The UI hashed free text ("delivery == true") while
///         the contract compared `keccak(abiEncodedData)`. Structurally unsatisfiable.
///      3. **⚠️ Anyone could release anyone's escrow.** The old rule verified the proof was genuine and
///         that the *response* matched — but never which request produced it. Conditions are naturally
///         expressed as a jq predicate returning a bool, so every boolean escrow commits to the SAME
///         hash: `keccak(abi.encode(true))` = 0xb10e2d5276…. Demonstrated: an attestation of
///         "github stars > 0" yields exactly that hash, so it would have released a "delivery ==
///         true" escrow. `release()` is permissionless by design (the proof is trusted, not the sender),
///         which made this trivially exploitable by anyone with any API returning true.
///
///      ## The fix: bind the REQUEST, not just the response
///      An escrow commits to `keccak(abi.encode(requestBody))` — the whole request: url, method, headers,
///      queryParams, body, the jq transform AND the abi signature. Only an attestation of *that exact
///      request* returning *that exact value* can release it. Binding the whole struct (rather than the
///      url alone) also closes the same-url/different-queryParams hole — e.g. CoinGecko `/simple/price`
///      with `ids=ripple` vs `ids=bitcoin`.
///
///      Use `requestHashOf()` to compute the commitment: callers should ask the contract rather than
///      re-implement ABI encoding off-chain, so a client can never commit to a hash the rule won't match.
contract ConditionalRule is KeylessRuleBase {
    /// @notice Flare's FdcVerification. The only thing that can flip a condition to proven.
    IFdcVerification public immutable fdc;

    struct Condition {
        bytes32 recipient; // keccak(recipient) this account may pay
        uint256 maxAmount; // drops, total across releases
        bytes32 requestHash; // keccak(abi.encode(requestBody)) — pins the exact API + transform
        bytes32 expectedHash; // keccak(abiEncodedData) that means "condition satisfied"
        uint256 spent; // drops already paid out
        bool released; // condition proven via FDC
        bool active;
    }

    /// @notice walletId => its condition.
    mapping(bytes32 => Condition) public conditionOf;

    /// @dev Emits the FULL request, not just its hash, so the condition is self-describing on-chain:
    ///      anyone can replay this event, rebuild the exact attestation request, and prove the condition.
    ///      That is what keeps `release()` genuinely permissionless — a watcher needs no off-chain
    ///      registry and no privileged knowledge of what a given account is waiting on.
    event ConditionConfigured(
        bytes32 indexed walletId,
        string recipient,
        uint256 maxAmount,
        bytes32 requestHash,
        bytes32 expectedHash,
        IWeb2Json.RequestBody request
    );
    event ConditionProven(bytes32 indexed walletId, uint64 votingRound);
    event ConditionCancelled(bytes32 indexed walletId);

    error AlreadyProven();
    error ProofNotVerified();
    error WrongRequest();
    error ConditionNotMet();

    constructor(address _accounts, address _fdc) KeylessRuleBase(_accounts) {
        fdc = IFdcVerification(_fdc);
    }

    /// @notice The commitment for a request. Call this to build `requestHash` for `configure` — asking the
    ///         contract guarantees the client can never commit to an encoding the rule won't reproduce.
    function requestHashOf(IWeb2Json.RequestBody calldata requestBody) public pure returns (bytes32) {
        return keccak256(abi.encode(requestBody));
    }

    /// @notice Set up the condition: who this account may pay, the total cap, the exact API request that
    ///         decides it, and the attested value that means "satisfied".
    /// @param request      The attestation request to pin — url, method, headers, query, body, the jq
    ///                     transform and the abi signature. The contract hashes it itself, so a client can
    ///                     never commit to an encoding the rule won't reproduce, and emits it in full so
    ///                     the condition is self-describing on-chain.
    /// @param expectedHash keccak of the attested `abiEncodedData` meaning satisfied. For the usual
    ///                     jq-predicate shape (`{ok: (.status == "DELIVERED")}` → bool) that is
    ///                     `keccak(abi.encode(true))`; safe here only because the request is also pinned.
    function configure(
        bytes32 walletId,
        string calldata recipient,
        uint256 maxAmount,
        IWeb2Json.RequestBody calldata request,
        bytes32 expectedHash
    ) external onlyWalletOwner(walletId) notLocked(walletId) {
        if (maxAmount == 0) revert Rejected("zero cap");
        if (bytes(request.url).length == 0) revert Rejected("no request pinned");
        if (expectedHash == bytes32(0)) revert Rejected("no condition");
        bytes32 requestHash = requestHashOf(request);
        conditionOf[walletId] = Condition({
            recipient: keccak256(bytes(recipient)),
            maxAmount: maxAmount,
            requestHash: requestHash,
            expectedHash: expectedHash,
            spent: 0,
            released: false,
            active: true
        });
        emit ConditionConfigured(walletId, recipient, maxAmount, requestHash, expectedHash, request);
    }

    /// @notice Prove the condition. Verifies the attestation against Flare's Merkle root for its voting
    ///         round, that it attests THIS account's pinned request, and that the attested value is the
    ///         one that means satisfied. Anyone may submit — the proof is what's trusted, not the sender.
    function release(bytes32 walletId, IWeb2Json.Proof calldata proof) external {
        Condition storage c = conditionOf[walletId];
        if (!c.active) revert Rejected("no active condition");
        if (c.released) revert AlreadyProven();
        // 1. Flare's validators really attested this.
        if (!fdc.verifyWeb2Json(proof)) revert ProofNotVerified();
        // 2. …of exactly the request this account pinned (closes the forged-proof hole).
        if (requestHashOf(proof.data.requestBody) != c.requestHash) revert WrongRequest();
        // 3. …and the world's answer is the one that means "go".
        if (keccak256(proof.data.responseBody.abiEncodedData) != c.expectedHash) revert ConditionNotMet();
        c.released = true;
        emit ConditionProven(walletId, proof.data.votingRound);
    }

    /// @notice Cancel at any time. The account can pay nothing further under this rule. (Blocked once the
    ///         account is locked.)
    function cancel(bytes32 walletId) external onlyWalletOwner(walletId) notLocked(walletId) {
        conditionOf[walletId].active = false;
        emit ConditionCancelled(walletId);
    }

    /// @notice The rule check. Reverts unless the condition has been proven and this payment is to the
    ///         pinned recipient, within the cap.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        Condition storage c = conditionOf[walletId];
        if (!c.active) revert Rejected("no active condition");
        if (!c.released) revert Rejected("condition not proven yet");
        if (keccak256(bytes(recipient)) != c.recipient) revert Rejected("recipient is not the payee");
        if (c.spent + amount > c.maxAmount) revert Rejected("over the cap");
        c.spent += amount;
    }
}
