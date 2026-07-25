// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title RateLimitRule
/// @notice A configurable spending limit: a cap on how much can leave per rolling window, with two
///         optional extra bounds — an allowlist of recipients, and a ceiling on any single payment.
///
/// @dev The "spending limit" template, deliberately flexible so one rule covers many needs:
///      - **Window budget** (required): no more than `maxPerPeriod` total in any `period` seconds. The
///        period is raw seconds, so the UI can offer any window (6 hours, 2 weeks, 3 months…).
///      - **Allowlist** (optional): if `allowlistOnly` is true, payments may only go to allowlisted
///        recipients (an agent/bot bounded to known addresses). If false, it may pay anyone within the
///        cap (a personal allowance, a kid's spending money).
///      - **Per-payment cap** (optional): if `maxPerTx` != 0, no single payment may exceed it, limiting
///        blast radius per transaction ("1000/day, but never more than 100 at once").
///      Even a fully compromised key can't exceed these. This is the state-recording rule — `authorize`
///      mutates the window counter, which is why the interface is not `view`.
contract RateLimitRule is KeylessRuleBase {
    struct Limit {
        uint256 maxPerPeriod; // drops per window
        uint64 period; // seconds
        uint64 windowStart; // unix time the current window opened
        uint256 spentInWindow; // drops spent since windowStart
        uint256 maxPerTx; // drops; 0 = no per-payment cap
        bool allowlistOnly; // if true, recipient must be allowlisted; if false, anyone is allowed
    }

    /// @notice walletId => keccak(recipient) => allowed.
    mapping(bytes32 => mapping(bytes32 => bool)) public allowed;
    /// @notice walletId => its spending limit.
    mapping(bytes32 => Limit) public limitOf;

    event RecipientAllowed(bytes32 indexed walletId, string recipient);
    event RecipientRemoved(bytes32 indexed walletId, string recipient);
    event LimitConfigured(bytes32 indexed walletId, uint256 maxPerPeriod, uint64 period, uint256 maxPerTx, bool allowlistOnly);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    function allow(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        allowed[walletId][keccak256(bytes(recipient))] = true;
        emit RecipientAllowed(walletId, recipient);
    }

    function allowMany(bytes32 walletId, string[] calldata recipients)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        for (uint256 i = 0; i < recipients.length; i++) {
            allowed[walletId][keccak256(bytes(recipients[i]))] = true;
            emit RecipientAllowed(walletId, recipients[i]);
        }
    }

    function remove(bytes32 walletId, string calldata recipient)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        allowed[walletId][keccak256(bytes(recipient))] = false;
        emit RecipientRemoved(walletId, recipient);
    }

    /// @notice Set the window budget, optional per-payment cap, and allowlist mode. Resets the window.
    /// @param maxPerPeriod  drops allowed to leave per window
    /// @param period        window length in seconds (must be > 0)
    /// @param maxPerTx      max drops per single payment; 0 for no per-payment cap
    /// @param allowlistOnly true to restrict to allowlisted recipients; false to allow any recipient
    function configure(bytes32 walletId, uint256 maxPerPeriod, uint64 period, uint256 maxPerTx, bool allowlistOnly)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (period == 0) revert Rejected("period is zero");
        Limit storage l = limitOf[walletId];
        l.maxPerPeriod = maxPerPeriod;
        l.period = period;
        l.maxPerTx = maxPerTx;
        l.allowlistOnly = allowlistOnly;
        l.windowStart = uint64(block.timestamp);
        l.spentInWindow = 0;
        emit LimitConfigured(walletId, maxPerPeriod, period, maxPerTx, allowlistOnly);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");

        Limit storage l = limitOf[walletId];
        if (l.period == 0) revert Rejected("no limit configured");

        if (l.allowlistOnly && !allowed[walletId][keccak256(bytes(recipient))]) revert Rejected("recipient not allowed");
        if (l.maxPerTx != 0 && amount > l.maxPerTx) revert Rejected("over per-tx limit");

        // Roll the window forward if it has elapsed.
        if (block.timestamp >= l.windowStart + l.period) {
            l.windowStart = uint64(block.timestamp);
            l.spentInWindow = 0;
        }

        if (l.spentInWindow + amount > l.maxPerPeriod) revert Rejected("rate limit exceeded");
        l.spentInWindow += amount;
    }
}
