// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IFlareTeeManager} from "./interfaces/IFlareTeeManager.sol";

/// @title AuthorizedPayPolicy
/// @author Keyless
/// @notice Abstract base for a contract that is the *instructions sender* of a Flare Confidential
///         Compute (FCE) extension whose TEE machines hold an XRPL key.
///
/// @dev The Keyless thesis in one contract:
///
///      An FCE extension's TEE machines will only accept instructions from ONE address — the
///      extension's registered `instructionsSender` (enforced in Flare's InstructionsFacet:
///      `require(msg.sender == getExtensionInstructionsSender(extensionId))`). Make that address a
///      CONTRACT, and the XRPL key sealed inside the enclave can only ever sign what the contract's
///      on-chain policy permits. The operator runs the machine but holds no key and can order
///      nothing the policy forbids — hence "Keyless".
///
///      Two independent guarantees stack here, and both are auditable from chain state:
///        1. WHAT can be signed  — this contract. The enclave takes orders from nobody else.
///        2. WHAT CODE signs it  — `addTeeVersion` pins the enclave's code hash on-chain. A machine
///           may only join the extension by attesting to that hash, so the operator cannot swap in
///           a modified image that ignores the policy.
///
///      This base owns all the FCE plumbing (the wallet handle, the instruction encoding, the fee).
///      Subclasses implement exactly one function — `_checkPolicy` — which decides whether a given
///      (recipient, amount, reference) is allowed. Everything a subclass forbids is unreachable, by
///      construction, for everyone including the operator.
///
///      Trust boundary: instead of "trust the operator", the guarantee is "read this contract and
///      the registered code hash". That is the whole product.
///
///      NOTE: an earlier version of this contract drove Flare's Protocol Managed Wallets
///      (`TeePayments.pay`). That path is unusable by anyone but Flare — binding a policy contract
///      as a PMW account's authorization address requires the wallet's project to sit on extension
///      id 0, the governance-owned system extension. Running our own extension is permissionless.
abstract contract AuthorizedPayPolicy {
    /// @notice Flare's TEE manager diamond (Coston2: 0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F).
    IFlareTeeManager public immutable teeManager;

    /// @notice Our FCE extension. Its machines obey this contract and nothing else.
    uint256 public immutable extensionId;

    /// @notice The wallet whose XRPL key lives inside the enclave.
    bytes32 public immutable walletId;

    /// @notice The XRPL account that wallet controls. Informational — the enclave derives the real
    ///         one from its sealed key; this is here so readers can verify what they're looking at.
    string public xrplAccount;

    /// @notice Where unspent instruction fees are refunded.
    address public immutable claimBackAddress;

    /// @notice Keyless's own operation family. Deliberately NOT a system opType — those are reserved
    ///         for extension 0 and `sendInstructions` rejects them from non-system callers.
    bytes32 public constant OP_TYPE = bytes32("KEYLESS_XRP");

    /// @notice The only command this policy ever issues: sign and submit one XRPL payment.
    bytes32 public constant OP_PAY = bytes32("PAY");

    /// @notice The payload handed to the enclave. We define this format because we also write the
    ///         enclave that reads it.
    /// @dev The enclave MUST refuse to sign anything whose fields it did not receive here, and MUST
    ///      re-check that the instruction came from this contract via the on-chain instruction id.
    struct XrplPayment {
        bytes32 walletId;
        string recipient;
        uint256 amount; // XRPL drops
        bytes32 paymentReference; // becomes the XRPL memo
    }

    /// @notice Emitted for every payment this policy authorizes.
    event PaymentAuthorized(
        bytes32 indexed instructionId, string recipient, uint256 amount, bytes32 paymentReference
    );

    error PolicyRejected(string reason);
    error NoTeeMachines();
    error InsufficientFee(uint256 required, uint256 provided);

    /// @param _teeManager       Flare's TEE manager diamond.
    /// @param _extensionId      Our registered extension (see script/BootstrapExtension.s.sol).
    /// @param _walletId         The wallet whose XRPL key the enclave holds.
    /// @param _xrplAccount      That wallet's XRPL address (informational).
    /// @param _claimBackAddress Fee refund address.
    constructor(
        IFlareTeeManager _teeManager,
        uint256 _extensionId,
        bytes32 _walletId,
        string memory _xrplAccount,
        address _claimBackAddress
    ) {
        teeManager = _teeManager;
        extensionId = _extensionId;
        walletId = _walletId;
        xrplAccount = _xrplAccount;
        claimBackAddress = _claimBackAddress;
    }

    /// @notice True once Flare has registered THIS contract as the extension's instructions sender.
    /// @dev Until this is true, the enclave will not take orders from this policy — and once it is,
    ///      it will take orders from nothing else. Bind with BootstrapExtension.s.sol:BindPolicy.
    function isBound() public view returns (bool) {
        return teeManager.getTeeExtensionInstructionsSender(extensionId) == address(this);
    }

    /// @notice The TEE machines currently serving our extension.
    function teeMachines() public view returns (address[] memory) {
        return teeManager.getActiveTeeMachines(extensionId);
    }

    /// @notice What a caller must send with a payment to cover the TEE instruction fee.
    function quotePayFee() public view returns (uint256) {
        return teeManager.calculateFeeByTeeIds(OP_TYPE, OP_PAY, teeMachines());
    }

    // ---------------------------------------------------------------------
    // Policy hook — subclasses implement this and nothing else.
    // ---------------------------------------------------------------------

    /// @notice Decide whether a payment is permitted. MUST revert (ideally with PolicyRejected)
    ///         if not. Return normally to allow.
    /// @dev This is the entire security surface of a Keyless policy. Keep it small and readable —
    ///      a judge (or an auditor, or a collateral provider) should be able to read it and know
    ///      exactly what the account can and cannot do.
    function _checkPolicy(string memory recipient, uint256 amount, bytes32 paymentReference)
        internal
        view
        virtual;

    // ---------------------------------------------------------------------
    // Core: the only path from this contract to a signature
    // ---------------------------------------------------------------------

    /// @notice Run the policy check, then instruct the enclave to sign exactly this payment.
    /// @dev Internal so each subclass exposes its own entrypoint with the right access control and
    ///      argument shape (a redemption id vs. a raw recipient). There is no other way out of here.
    function _authorizedPay(string memory recipient, uint256 amount, bytes32 paymentReference)
        internal
        returns (bytes32 instructionId)
    {
        _checkPolicy(recipient, amount, paymentReference);

        address[] memory machines = teeManager.getActiveTeeMachines(extensionId);
        if (machines.length == 0) revert NoTeeMachines();

        uint256 fee = teeManager.calculateFeeByTeeIds(OP_TYPE, OP_PAY, machines);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        IFlareTeeManager.TeeInstructionParams memory params = IFlareTeeManager.TeeInstructionParams({
            opType: OP_TYPE,
            opCommand: OP_PAY,
            message: abi.encode(
                XrplPayment({
                    walletId: walletId,
                    recipient: recipient,
                    amount: amount,
                    paymentReference: paymentReference
                })
            ),
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: claimBackAddress
        });

        instructionId = teeManager.sendInstructions{value: msg.value}(machines, params);
        emit PaymentAuthorized(instructionId, recipient, amount, paymentReference);
    }
}
