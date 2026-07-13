// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {PMWTypes} from "./PMWTypes.sol";

/// @title ITeePayments
/// @notice Minimal interface to Flare's deployed Protocol Managed Wallet (PMW) payments contract.
/// @dev Signatures verified against the live `TeePayments` ABI on Coston2:
///        TeePayments_F_XRP  0xD02384dcbA8bBb42E4E8b417b8542410AE0CF484
///      `pay` is gated by OnlyAuthorizationAddress() — only the account's registered
///      authorization address may call it. In Keyless, that address IS the policy contract.
///
///      OPEN ITEM (see docs/OPEN_ITEMS.md #1): `pay` returns a uint64 paymentId, which strongly
///      suggests PMW is ASYNCHRONOUS — pay() records an authorized intent on Flare and TEE
///      machines submit + sign the XRPL transaction out of band. If confirmed, a keeper must
///      observe results and drive reissue() on stalls. Trace one live pay() to settle this
///      before finalizing the off-chain design.
interface ITeePayments {
    /// @notice Authorize a payment from a PMW account. Only the account's authorization address may call.
    /// @return _paymentId Handle used to track / reissue this payment.
    function pay(
        PMWTypes.Account calldata _account,
        PMWTypes.PaymentInstruction calldata _paymentInstruction,
        address _claimBackAddress
    ) external returns (uint64 _paymentId);

    /// @notice Reissue a stalled payment with bumped fees. Only the authorization address may call.
    function reissue(
        PMWTypes.Account calldata _account,
        uint64 _paymentId,
        PMWTypes.PaymentInstruction[] calldata _paymentInstructions,
        PMWTypes.ReissueFeeParams calldata _reissueFeeParams,
        address _claimBackAddress
    ) external returns (bool _finalized);

    /// @notice The address currently authorized to spend from this account (0x0 if unregistered).
    function getAuthorizationAddress(PMWTypes.Account calldata _account)
        external
        view
        returns (address _authorizationAddress);

    /// @notice First nonce for the account.
    function getInitialNonce(PMWTypes.Account calldata _account) external view returns (uint64 _initialNonce);

    /// @notice Next payment id that pay() will assign for this account.
    function getNextPaymentId(PMWTypes.Account calldata _account) external view returns (uint64 _nextPaymentId);

    /// @notice Fee quoted for an operation on this account.
    function getPaymentFee(PMWTypes.Account calldata _account, bytes32 _opCommand)
        external
        view
        returns (uint256 _fee);

    /// @notice Hash committing to a specific payment id (useful for off-chain tracking).
    function getPaymentHash(PMWTypes.Account calldata _account, uint64 _paymentId)
        external
        view
        returns (bytes32 _paymentHash);
}
