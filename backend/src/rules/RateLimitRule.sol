// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";

/// @title RateLimitRule
/// @notice A fully configurable spending limit. A wallet may spend up to `cap` drops per window, with two
///         optional bounds — an allowlist and a per-payment cap — and the owner picks how the window is
///         measured:
///           - MODE_ROLLING  (0): a rolling window of `param` seconds, resetting `param` after setup.
///           - MODE_CALENDAR (1): resets on real calendar boundaries — `param` = 0 day / 1 week (Monday) /
///                                 2 month (the 1st), all at 00:00 UTC. What people mean by "monthly budget".
///           - MODE_UNTIL    (2): a one-time budget of `cap` total that hard-stops at the date `param`
///                                 (unix seconds). No reset; after the date, nothing more can be spent.
///
/// @dev The "spending limit" template. Even a fully compromised key can't exceed these bounds. This rule
///      records state (window counters), so `authorize` is not `view`. Calendar math uses Howard Hinnant's
///      days<->civil algorithm (pure integer, exact for all post-1970 dates).
contract RateLimitRule is KeylessRuleBase {
    uint8 constant MODE_ROLLING = 0;
    uint8 constant MODE_CALENDAR = 1;
    uint8 constant MODE_UNTIL = 2;
    uint8 constant CAL_DAY = 0;
    uint8 constant CAL_WEEK = 1;
    uint8 constant CAL_MONTH = 2;

    struct Limit {
        bool configured;
        uint8 mode; // MODE_*
        bool allowlistOnly; // if true, recipient must be allowlisted
        uint256 cap; // drops per window (rolling/calendar) or total budget (until)
        uint256 spent; // drops spent in the current window
        uint256 maxPerTx; // drops; 0 = no per-payment cap
        uint64 windowStart; // start of the current window (unix seconds)
        uint256 param; // rolling: period secs | calendar: CAL_* | until: expiry unix secs
    }

    /// @notice walletId => keccak(recipient) => allowed.
    mapping(bytes32 => mapping(bytes32 => bool)) public allowed;
    /// @notice walletId => its spending limit.
    mapping(bytes32 => Limit) public limitOf;

    event RecipientAllowed(bytes32 indexed walletId, string recipient);
    event RecipientRemoved(bytes32 indexed walletId, string recipient);
    event LimitConfigured(bytes32 indexed walletId, uint8 mode, uint256 cap, uint256 param, uint256 maxPerTx, bool allowlistOnly);

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

    /// @notice Configure the spending limit. Resets the current window.
    /// @param mode          MODE_ROLLING | MODE_CALENDAR | MODE_UNTIL
    /// @param cap           drops per window (rolling/calendar) or total until the date (until)
    /// @param param         rolling: window seconds; calendar: CAL_DAY/WEEK/MONTH; until: expiry unix secs
    /// @param maxPerTx      max drops per single payment; 0 for no per-payment cap
    /// @param allowlistOnly true to restrict to allowlisted recipients; false to allow any recipient
    function configure(bytes32 walletId, uint8 mode, uint256 cap, uint256 param, uint256 maxPerTx, bool allowlistOnly)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (cap == 0) revert Rejected("cap is zero");
        Limit storage l = limitOf[walletId];
        l.configured = true;
        l.mode = mode;
        l.cap = cap;
        l.param = param;
        l.maxPerTx = maxPerTx;
        l.allowlistOnly = allowlistOnly;
        l.spent = 0;

        if (mode == MODE_ROLLING) {
            if (param == 0) revert Rejected("period is zero");
            l.windowStart = uint64(block.timestamp);
        } else if (mode == MODE_CALENDAR) {
            if (param > CAL_MONTH) revert Rejected("bad calendar unit");
            l.windowStart = _calendarStart(uint64(block.timestamp), uint8(param));
        } else if (mode == MODE_UNTIL) {
            if (param <= block.timestamp) revert Rejected("date must be in the future");
            l.windowStart = uint64(block.timestamp);
        } else {
            revert Rejected("bad mode");
        }
        emit LimitConfigured(walletId, mode, cap, param, maxPerTx, allowlistOnly);
    }

    /// @notice The rule check. Reverts if this payment is not permitted for the wallet.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        if (amount == 0) revert Rejected("zero amount");
        Limit storage l = limitOf[walletId];
        if (!l.configured) revert Rejected("no limit configured");

        if (l.allowlistOnly && !allowed[walletId][keccak256(bytes(recipient))]) revert Rejected("recipient not allowed");
        if (l.maxPerTx != 0 && amount > l.maxPerTx) revert Rejected("over per-tx limit");

        if (l.mode == MODE_ROLLING) {
            if (block.timestamp >= l.windowStart + uint64(l.param)) {
                l.windowStart = uint64(block.timestamp);
                l.spent = 0;
            }
        } else if (l.mode == MODE_CALENDAR) {
            uint64 b = _calendarStart(uint64(block.timestamp), uint8(l.param));
            if (l.windowStart < b) {
                l.windowStart = b;
                l.spent = 0;
            }
        } else {
            // MODE_UNTIL: one-time budget, no reset; blocked once the date passes.
            if (block.timestamp >= l.param) revert Rejected("budget period ended");
        }

        if (l.spent + amount > l.cap) revert Rejected("limit exceeded");
        l.spent += amount;
    }

    // --- calendar math (Howard Hinnant, exact for post-1970 dates) ------------------------------------

    /// @notice Start of the calendar window containing `ts`, at 00:00 UTC. unit: 0 day, 1 week (Mon), 2 month.
    ///         Exposed for the UI to preview the next reset.
    function calendarStart(uint64 ts, uint8 unit) external pure returns (uint64) {
        return _calendarStart(ts, unit);
    }

    function _calendarStart(uint64 ts, uint8 unit) internal pure returns (uint64) {
        uint256 dayIdx = uint256(ts) / 86400;
        if (unit == CAL_DAY) return uint64(dayIdx * 86400);
        if (unit == CAL_WEEK) {
            uint256 dow = (dayIdx + 3) % 7; // unix day 0 = Thursday; Monday = 0
            return uint64((dayIdx - dow) * 86400);
        }
        // month: the 1st, 00:00 UTC
        (uint256 y, uint256 m) = _yearMonth(dayIdx);
        return uint64(_daysFromCivil(y, m, 1) * 86400);
    }

    function _yearMonth(uint256 dayIdx) internal pure returns (uint256 y, uint256 m) {
        uint256 z = dayIdx + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    function _daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        uint256 yy = m <= 2 ? y - 1 : y;
        uint256 era = yy / 400;
        uint256 yoe = yy - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
