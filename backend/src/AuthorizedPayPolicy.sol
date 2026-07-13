// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITeePayments} from "./interfaces/ITeePayments.sol";
import {PMWTypes} from "./interfaces/PMWTypes.sol";

/// @title AuthorizedPayPolicy
/// @author Keyless
/// @notice Abstract base for a contract that is the *authorization address* of a Flare PMW account.
///
/// @dev The Keyless thesis in one contract:
///      A PMW-managed XRPL account can only be spent by its registered authorization address.
///      Make that address a CONTRACT, and the account can only ever pay what the contract's
///      on-chain policy permits. The operator runs the machine but holds no key and can sign
///      nothing the policy forbids — hence "Keyless".
///
///      This base owns all the PMW plumbing (the account handle, the pay() call, reissue()).
///      Subclasses implement exactly one function — `_checkPolicy` — which decides whether a
///      given (recipient, amount, reference) is allowed. Everything a subclass forbids is
///      unreachable, by construction, for everyone including the operator.
///
///      Trust boundary: instead of "trust the operator" or "trust this Docker image hash",
///      the guarantee is "read this contract". That is the whole product.
abstract contract AuthorizedPayPolicy {
    /// @notice Flare's deployed PMW payments contract.
    ITeePayments public immutable teePayments;

    /// @notice The PMW account this policy authorizes (sourceId + XRPL address).
    PMWTypes.Account internal account;

    /// @notice Where clawed-back funds / change are returned on the Flare side.
    address public immutable claimBackAddress;

    /// @notice Emitted for every payment this policy authorizes.
    event PaymentAuthorized(
        uint64 indexed paymentId, string recipient, uint256 amount, bytes32 paymentReference
    );

    /// @notice Emitted when a stalled payment is reissued with bumped fees.
    event PaymentReissued(uint64 indexed paymentId, bool finalized);

    error PolicyRejected(string reason);
    error NotAuthorizationAddress(address expected, address actual);

    /// @param _teePayments      Flare PMW TeePayments contract for the relevant source (e.g. F_XRP).
    /// @param _sourceId         Registered source id (e.g. testXRP).
    /// @param _accountAddress   The XRPL account address this policy controls.
    /// @param _claimBackAddress Flare-side address for clawback / change.
    constructor(
        ITeePayments _teePayments,
        bytes32 _sourceId,
        string memory _accountAddress,
        address _claimBackAddress
    ) {
        teePayments = _teePayments;
        account.sourceId = _sourceId;
        account.accountAddress = _accountAddress;
        claimBackAddress = _claimBackAddress;
    }

    /// @notice The account handle this policy controls.
    function getAccount() external view returns (PMWTypes.Account memory) {
        return account;
    }

    /// @notice True once PMW has registered THIS contract as the account's authorization address.
    /// @dev Until this returns true, pay() will revert with OnlyAuthorizationAddress on the PMW side.
    ///      Binding happens via TeePayments.addPMWMultisigAccount(...) — see docs/OPEN_ITEMS.md #2.
    function isBound() public view returns (bool) {
        return teePayments.getAuthorizationAddress(account) == address(this);
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
    // Core: authorized payment path
    // ---------------------------------------------------------------------

    /// @notice Run the policy check, then authorize the payment via PMW.
    /// @dev Internal so each subclass can expose its own external entrypoint with the right access
    ///      control and argument shape (e.g. a redemption id vs. a raw recipient).
    function _authorizedPay(
        string memory recipient,
        bytes memory tokenId,
        uint256 amount,
        uint256 maxFee,
        bytes32 paymentReference
    ) internal returns (uint64 paymentId) {
        _checkPolicy(recipient, amount, paymentReference);

        PMWTypes.PaymentInstruction memory instruction = PMWTypes.PaymentInstruction({
            recipientAddress: recipient,
            tokenId: tokenId,
            amount: amount,
            maxFee: maxFee,
            paymentReference: paymentReference
        });

        paymentId = teePayments.pay(account, instruction, claimBackAddress);
        emit PaymentAuthorized(paymentId, recipient, amount, paymentReference);
    }

    /// @notice Reissue a stalled payment with bumped fees. Exposed for a keeper / operator.
    /// @dev Reissuing does not bypass policy: PMW only lets the authorization address reissue an
    ///      existing paymentId, and that payment already passed _checkPolicy when first authorized.
    function _reissue(
        uint64 paymentId,
        PMWTypes.PaymentInstruction[] memory instructions,
        PMWTypes.ReissueFeeParams memory feeParams
    ) internal returns (bool finalized) {
        finalized = teePayments.reissue(account, paymentId, instructions, feeParams, claimBackAddress);
        emit PaymentReissued(paymentId, finalized);
    }
}
