// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title SubscriptionRule
/// @notice A pull-payment plan: one fixed merchant may pull up to `maxPerPeriod` per `period` from the
///         wallet, and nothing else can. The owner can cancel at any time.
///
/// @dev This is the "subscription" template. XRPL has no native recurring/pull payments a payer can
///      cap and revoke — a Check or Payment Channel still needs the payer to act or pre-sign each time.
///      Here the merchant triggers `pay` themselves, but the rule guarantees they can only ever take up
///      to the cap per window, only to their own address, and only until the owner cancels. The
///      merchant provably cannot overcharge.
contract SubscriptionRule is KeylessRuleBase {
    struct Plan {
        bytes32 merchant; // keccak(recipient) the plan pays
        uint256 maxPerPeriod; // drops
        uint64 period; // seconds
        uint64 windowStart;
        uint256 pulledInWindow;
        bool active;
    }

    /// @notice walletId => its subscription plan.
    mapping(bytes32 => Plan) public planOf;

    event PlanConfigured(bytes32 indexed walletId, string merchant, uint256 maxPerPeriod, uint64 period);
    event PlanCancelled(bytes32 indexed walletId);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    /// @notice Create/replace the plan for a wallet.
    function configure(bytes32 walletId, string calldata merchant, uint256 maxPerPeriod, uint64 period)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (period == 0) revert Rejected("period is zero");
        planOf[walletId] = Plan({
            merchant: keccak256(bytes(merchant)),
            maxPerPeriod: maxPerPeriod,
            period: period,
            windowStart: uint64(block.timestamp),
            pulledInWindow: 0,
            active: true
        });
        emit PlanConfigured(walletId, merchant, maxPerPeriod, period);
    }

    /// @notice Stop the subscription. The merchant can pull nothing further. (Blocked once the wallet is
    ///         locked — locking a subscription makes it permanent, so lock only accounts you won't cancel.)
    function cancel(bytes32 walletId) external onlyWalletOwner(walletId) notLocked(walletId) {
        planOf[walletId].active = false;
        emit PlanCancelled(walletId);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");

        Plan storage p = planOf[walletId];
        if (!p.active) revert Rejected("no active subscription");
        if (keccak256(bytes(recipient)) != p.merchant) revert Rejected("recipient is not the merchant");

        if (block.timestamp >= p.windowStart + p.period) {
            p.windowStart = uint64(block.timestamp);
            p.pulledInWindow = 0;
        }

        if (p.pulledInWindow + amount > p.maxPerPeriod) revert Rejected("over subscription cap");
        p.pulledInWindow += amount;
    }
}
