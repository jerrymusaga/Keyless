// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {AuthorizedPayPolicy} from "../AuthorizedPayPolicy.sol";
import {IFlareTeeManager} from "../interfaces/IFlareTeeManager.sol";
import {IAssetManager, RedemptionRequestInfo} from "../interfaces/IAssetManager.sol";

/// @title KeylessRedemptionPolicy
/// @notice THE FLAGSHIP. A policy that lets a TEE-held XRPL key pay FAssets redemptions — and
///         nothing else, ever.
///
/// @dev How it makes an FAssets agent trustless:
///      The XRPL account whose key is sealed in our enclave is the agent's registered underlying
///      address. This contract is the extension's instructions sender, so the enclave signs only
///      what this contract orders. The ONLY order it can produce is `payRedemption(id)`, which:
///        1. reads the redemption straight from the AssetManager (ground truth),
///        2. requires status == ACTIVE (and the read itself reverts once confirmed),
///        3. forces recipient == the redeemer's paymentAddress,
///        4. forces amount == valueUBA - feeUBA (the exact protocol-mandated payout),
///        5. forces the XRPL memo == the redemption's paymentReference.
///
///      There is no function that pays the operator, no withdrawal path, no "admin transfer". The
///      operator can run this all day and cannot direct a single drop of XRP anywhere the FAssets
///      protocol didn't already mandate. That is what makes the agent safe to fund without trusting
///      whoever runs it — which is the point: FAssets agent capacity is the bottleneck on FXRP
///      supply, and it is bottlenecked on trust, not on capital.
contract KeylessRedemptionPolicy is AuthorizedPayPolicy {
    /// @notice The FAssets AssetManager whose redemptions this policy honors.
    IAssetManager public immutable assetManager;

    /// @notice Redemptions this policy has already authorized.
    /// @dev NOT redundant with the AssetManager's revert-on-confirm. That only fires once the XRPL
    ///      payment is CONFIRMED back on Flare, which is minutes after we authorize it. In that
    ///      window the request is still ACTIVE, so without this guard `payRedemption` — which is
    ///      permissionless — could be called repeatedly and the enclave would dutifully sign the
    ///      same payout N times, draining the agent's reserve. One mapping closes the window.
    mapping(uint256 => bool) public redemptionPaid;

    event RedemptionPaid(
        uint256 indexed redemptionRequestId, bytes32 indexed instructionId, uint256 amount
    );

    error RedemptionNotActive(uint256 id);
    error RedemptionAlreadyPaid(uint256 id);

    constructor(
        IFlareTeeManager _teeManager,
        uint256 _extensionId,
        bytes32 _walletId,
        string memory _xrplAccount,
        address _claimBackAddress,
        IAssetManager _assetManager
    ) AuthorizedPayPolicy(_teeManager, _extensionId, _walletId, _xrplAccount, _claimBackAddress) {
        assetManager = _assetManager;
    }

    /// @notice Pay a specific FAssets redemption. The ONLY way this account can spend.
    /// @param redemptionRequestId The redemption to fulfill.
    /// @return instructionId Handle for the TEE instruction we just authorized.
    /// @dev Permissionless by design: anyone may trigger the payment, because every parameter is
    ///      forced from protocol state — a caller cannot redirect funds, only cause a payment the
    ///      protocol already mandated. Callers attach the TEE instruction fee (see quotePayFee()).
    function payRedemption(uint256 redemptionRequestId) external payable returns (bytes32 instructionId) {
        if (redemptionPaid[redemptionRequestId]) revert RedemptionAlreadyPaid(redemptionRequestId);

        // Ground truth. Reverts if the redemption was already confirmed and deleted.
        RedemptionRequestInfo.Data memory r = assetManager.redemptionRequestInfo(redemptionRequestId);

        if (r.status != RedemptionRequestInfo.Status.ACTIVE) {
            revert RedemptionNotActive(redemptionRequestId);
        }

        // Effects before the external call: this redemption can never be authorized twice.
        redemptionPaid[redemptionRequestId] = true;

        // Protocol-mandated payout = value burned minus the redemption fee retained by the agent.
        uint256 payoutAmount = uint256(r.valueUBA) - uint256(r.feeUBA);

        instructionId = _authorizedPay(
            r.paymentAddress, // recipient forced to the redeemer's XRPL address
            payoutAmount, // amount forced to exact protocol payout
            r.paymentReference // memo forced to the redemption reference
        );

        emit RedemptionPaid(redemptionRequestId, instructionId, payoutAmount);
    }

    /// @notice Policy hook. For the redemption policy, the binding of recipient/amount/reference to
    ///         protocol state is enforced in payRedemption(); this hook is a defense-in-depth
    ///         backstop that rejects any zero-amount payment.
    /// @dev Kept intentionally tiny. All meaningful constraints live in payRedemption(), which is
    ///      the only caller of _authorizedPay in this contract.
    function _checkPolicy(string memory, uint256 amount, bytes32) internal pure override {
        if (amount == 0) revert PolicyRejected("zero amount");
    }
}
