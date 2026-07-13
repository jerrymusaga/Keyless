// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AuthorizedPayPolicy} from "../AuthorizedPayPolicy.sol";
import {ITeePayments} from "../interfaces/ITeePayments.sol";
import {IAssetManager, RedemptionRequestInfo} from "../interfaces/IAssetManager.sol";

/// @title KeylessRedemptionPolicy
/// @notice THE FLAGSHIP. A policy that lets a PMW-controlled XRPL account pay FAssets redemptions
///         — and nothing else, ever.
///
/// @dev How it makes an FAssets agent trustless:
///      The XRPL account controlled here is the agent's registered underlying address. This policy
///      is its authorization address. The ONLY way to move funds is `payRedemption(id)`, which:
///        1. reads the redemption straight from the AssetManager (ground truth),
///        2. requires status == ACTIVE (and the read itself reverts once confirmed → replay guard),
///        3. forces recipient == the redeemer's paymentAddress,
///        4. forces amount == valueUBA - feeUBA (the exact protocol-mandated payout),
///        5. forces the XRPL memo == the redemption's paymentReference.
///
///      There is no function that pays the operator, no withdrawal path, no "admin transfer".
///      The operator can run this all day and cannot direct a single drop of XRP anywhere the
///      FAssets protocol didn't already mandate. That is what makes the agent safe to fund
///      without trusting whoever runs it.
///
///      GOING LIVE: this contract compiles, deploys, and its guard fires against real
///      redemptionRequestInfo() reads today. It becomes a *live* agent only once the controlled
///      account is (a) registered as an FAssets agent's underlying address (governance whitelist,
///      see docs/OPEN_ITEMS.md #3) and (b) bound as the PMW authorization address (OPEN_ITEMS #2).
///      Until then it is a real, on-chain, verifiable policy demonstrated against real reads.
contract KeylessRedemptionPolicy is AuthorizedPayPolicy {
    /// @notice The FAssets AssetManager whose redemptions this policy honors.
    IAssetManager public immutable assetManager;

    /// @notice XRPL tokenId to pay in (empty bytes = native XRP for testXRP source).
    bytes internal xrpTokenId;

    /// @notice Max XRPL fee the policy will let PMW spend per redemption payment.
    uint256 public immutable maxFee;

    event RedemptionPaid(uint256 indexed redemptionRequestId, uint64 indexed paymentId, uint256 amount);

    error RedemptionNotActive(uint256 id);
    error AmountMismatch(uint256 expected, uint256 provided);

    constructor(
        ITeePayments _teePayments,
        bytes32 _sourceId,
        string memory _accountAddress,
        address _claimBackAddress,
        IAssetManager _assetManager,
        bytes memory _xrpTokenId,
        uint256 _maxFee
    ) AuthorizedPayPolicy(_teePayments, _sourceId, _accountAddress, _claimBackAddress) {
        assetManager = _assetManager;
        xrpTokenId = _xrpTokenId;
        maxFee = _maxFee;
    }

    /// @notice Pay a specific FAssets redemption. The ONLY way this account can spend.
    /// @param redemptionRequestId The redemption to fulfill.
    /// @return paymentId PMW handle for the authorized payment.
    /// @dev Permissionless by design: anyone may trigger the payment, because every parameter is
    ///      forced from protocol state — a caller cannot redirect funds. (The agent/operator will
    ///      normally call it, but there is no harm if someone else does.)
    function payRedemption(uint256 redemptionRequestId) external returns (uint64 paymentId) {
        // Ground truth. Reverts if the redemption was already confirmed (→ free replay protection).
        RedemptionRequestInfo.Data memory r = assetManager.redemptionRequestInfo(redemptionRequestId);

        if (r.status != RedemptionRequestInfo.Status.ACTIVE) {
            revert RedemptionNotActive(redemptionRequestId);
        }

        // Protocol-mandated payout = value burned minus the redemption fee retained by the agent.
        uint256 payoutAmount = uint256(r.valueUBA) - uint256(r.feeUBA);

        paymentId = _authorizedPay(
            r.paymentAddress, // recipient forced to the redeemer's XRPL address
            xrpTokenId,
            payoutAmount, // amount forced to exact protocol payout
            maxFee,
            r.paymentReference // memo forced to the redemption reference
        );

        emit RedemptionPaid(redemptionRequestId, paymentId, payoutAmount);
    }

    /// @notice Policy hook. For the redemption policy the binding of recipient/amount/reference to
    ///         protocol state is enforced in payRedemption(); this hook is a defense-in-depth
    ///         backstop that simply rejects any zero-amount payment.
    /// @dev Kept intentionally tiny. All meaningful constraints live in payRedemption(), which is
    ///      the only caller of _authorizedPay in this contract.
    function _checkPolicy(string memory, uint256 amount, bytes32) internal pure override {
        if (amount == 0) revert PolicyRejected("zero amount");
    }
}
