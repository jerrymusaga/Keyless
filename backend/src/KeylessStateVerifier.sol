// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title KeylessStateVerifier  (SKELETON — finish when FCC guides expose the verifier interface)
/// @notice The on-chain contract that receives and verifies the ATTESTED responses of our TEE machines,
///         and writes the verified result to KeylessAccounts. It is the answer to the #1 confidential-
///         compute question — "what is verified on-chain?" — replacing the trusted `enclaveReporter`
///         relayer with a contract that only accepts a result the TEE actually attested to.
///
/// @dev Registered as the extension's `_teeExtensionStateVerifier` via the diamond's
///      `register(ITeeExtensionStateVerifier,address)` / `setExtensionContracts(extensionId,verifier,sender)`
///      and read back with `getTeeExtensionStateVerifier(65645)`. Today `KEYLESS_VERIFIER = address(0)`
///      and a trusted relayer writes the r-address; this contract makes that trustless.
///
///      NEW BASELINE (2026-07-23, verified live): diamond = 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE,
///      ext 65645, machine 0xD47F3c4E…dD646 (production, code hash 0x194844cf…, governance 0xc99e27a5…).
///
///      WHAT IS KNOWN (filled in below):
///        - The result we care about: the INIT result = the enclave-generated XRPL r-address for a
///          walletId (the enclave returns the address as a string; see enclave processInit / stateHandler).
///        - The write path: this contract is set as KeylessAccounts.enclaveReporter, so after verifying
///          it calls `reportXrplAddress(walletId, addr)` — reusing the existing, idempotent writeback.
///        - The wiring point is REAL on the new baseline: `ITeeExtensionStateVerifier` is the type the
///          registry's `register`/`setExtensionContracts` accept, so a deployed verifier can be bound.
///
///      THE TWO CONCRETE BLOCKERS (do not guess past these — write nothing that fakes a check):
///        1. INTERFACE: the exact callback `ITeeExtensionStateVerifier` exposes (what the diamond invokes,
///           with which args + attestation proof) is NOT in the Go bindings, fce-sign `skills/references`,
///           or the module cache. Need Flare's `ITeeExtensionStateVerifier.sol` (ask the Flare team / flare
///           contracts repo) before the entry point below can be made real.
///        2. ATTESTED STATE SOURCE: our enclave currently emits walletId→r-address only via the custom
///           HTTP `GET /state` (extension.go stateHandler) — NOT through tee-node's attested on-chain
///           `systemState` channel (it was `0x` in /info). The enclave must publish the mapping through
///           the attested state path so there is a signed on-chain state for this contract to verify.
contract KeylessStateVerifier {
    /// @notice KeylessAccounts — this verifier is set as its `enclaveReporter`, so it may write addresses.
    IKeylessWriteback public immutable accounts;
    /// @notice Flare's TEE manager diamond (Coston2: 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE). The
    ///         only address allowed to deliver attested results here. TODO: confirm this is the caller.
    address public immutable teeManager;

    /// @notice extension whose machines this verifier serves.
    uint256 public immutable extensionId;

    event XrplAddressVerified(bytes32 indexed walletId, string xrplAddress);

    error NotTeeManager();
    error AttestationInvalid();
    error UnexpectedResult();

    constructor(address _accounts, address _teeManager, uint256 _extensionId) {
        accounts = IKeylessWriteback(_accounts);
        teeManager = _teeManager;
        extensionId = _extensionId;
    }

    modifier onlyTeeManager() {
        if (msg.sender != teeManager) revert NotTeeManager(); // TODO: confirm the delivery caller
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // ENTRY POINT — the shape Flare's attestation delivery calls. SIGNATURE IS A PLACEHOLDER.
    // TODO(guides): replace with the exact function name + args the tee-proxy/manager invokes.
    // ---------------------------------------------------------------------------------------------

    /// @param walletId       The account the INIT result belongs to. TODO: confirm how it's supplied.
    /// @param resultPayload  The enclave's attested ActionResult (for INIT: abi.encode(string r-address)).
    /// @param attestation    The proof/signature that the TEE actually produced `resultPayload`.
    function receiveAttestedInit(bytes32 walletId, bytes calldata resultPayload, bytes calldata attestation)
        external
        onlyTeeManager
    {
        // 1. VERIFY the attestation on-chain. TODO(guides): the real check — e.g. recover the machine's
        //    signature over keccak(resultPayload) and confirm the machine attests the registered code
        //    hash / governance hash for `extensionId` (likely via a manager view). Until then, we refuse.
        if (!_verify(resultPayload, attestation)) revert AttestationInvalid();

        // 2. DECODE the INIT result — the enclave returns the r-address as an ABI-encoded string.
        string memory xrplAddress = abi.decode(resultPayload, (string));
        if (bytes(xrplAddress).length == 0) revert UnexpectedResult();

        // 3. WRITE via the existing idempotent path (this contract is the enclaveReporter).
        accounts.reportXrplAddress(walletId, xrplAddress);
        emit XrplAddressVerified(walletId, xrplAddress);
    }

    /// @dev Placeholder. Returns false so nothing is trusted until the real verification is implemented.
    /// TODO(guides): implement per the FCC attestation model (machine signature vs registered code hash).
    function _verify(bytes calldata, /*resultPayload*/ bytes calldata /*attestation*/ )
        internal
        pure
        returns (bool)
    {
        return false; // fail-closed until the real check lands
    }
}

/// @dev Minimal slice of KeylessAccounts this verifier needs. This verifier is its `enclaveReporter`.
interface IKeylessWriteback {
    function reportXrplAddress(bytes32 walletId, string calldata xrplAddress) external;
}
