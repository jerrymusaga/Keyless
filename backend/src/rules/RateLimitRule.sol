// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title RateLimitRule
/// @notice Allowlist + a spending cap per rolling period. A wallet may pay allowlisted addresses, but
///         no more than `maxPerPeriod` total in any `period`.
///
/// @dev This is the "agent / bot" template. You want to give software — an AI agent, a trading bot, a
///      keeper — an XRP account it can spend from autonomously. But an agent can be prompt-injected,
///      hallucinate, or be hijacked. This rule bounds the blast radius: even a fully compromised agent
///      can only pay addresses you named, and only up to the cap per window. It can spend; it can't
///      drain. This is the state-recording rule — `authorize` mutates the window counter, which is why
///      the rule interface is not `view`.
contract RateLimitRule is KeylessRuleBase {
    struct Limit {
        uint256 maxPerPeriod; // drops
        uint64 period; // seconds
        uint64 windowStart; // unix time the current window opened
        uint256 spentInWindow; // drops spent since windowStart
    }

    /// @notice walletId => keccak(recipient) => allowed.
    mapping(bytes32 => mapping(bytes32 => bool)) public allowed;
    /// @notice walletId => its rate limit.
    mapping(bytes32 => Limit) public limitOf;

    event RecipientAllowed(bytes32 indexed walletId, string recipient);
    event RecipientRemoved(bytes32 indexed walletId, string recipient);
    event LimitConfigured(bytes32 indexed walletId, uint256 maxPerPeriod, uint64 period);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    function allow(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        allowed[walletId][keccak256(bytes(recipient))] = true;
        emit RecipientAllowed(walletId, recipient);
    }

    function remove(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        allowed[walletId][keccak256(bytes(recipient))] = false;
        emit RecipientRemoved(walletId, recipient);
    }

    /// @notice Set the cap and window. Resets the current window.
    function configure(bytes32 walletId, uint256 maxPerPeriod, uint64 period)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (period == 0) revert Rejected("period is zero");
        Limit storage l = limitOf[walletId];
        l.maxPerPeriod = maxPerPeriod;
        l.period = period;
        l.windowStart = uint64(block.timestamp);
        l.spentInWindow = 0;
        emit LimitConfigured(walletId, maxPerPeriod, period);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        if (!allowed[walletId][keccak256(bytes(recipient))]) revert Rejected("recipient not allowed");

        Limit storage l = limitOf[walletId];
        if (l.period == 0) revert Rejected("no limit configured");

        // Roll the window forward if it has elapsed.
        if (block.timestamp >= l.windowStart + l.period) {
            l.windowStart = uint64(block.timestamp);
            l.spentInWindow = 0;
        }

        if (l.spentInWindow + amount > l.maxPerPeriod) revert Rejected("rate limit exceeded");
        l.spentInWindow += amount;
    }
}
