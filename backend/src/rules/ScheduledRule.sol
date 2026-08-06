// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {KeylessRuleBase} from "./KeylessRuleBase.sol";
import {CalendarLib} from "../lib/CalendarLib.sol";

/// @title ScheduledRule
/// @notice A standing order the account cannot be talked out of — and cannot be talked into. Each line
///         names one payee, one exact amount, and one calendar slot: the 1st of the month, a Monday,
///         a day. Nothing else can be paid, nothing can be paid early, and no more than one run's worth
///         can ever come out of a single slot.
///
/// @dev This is the tightest policy in the set, which is the opposite of how automation usually reads.
///      Every other rule permits a range — any allowed address, anything under the cap. This one permits
///      a point. `pay` is permissionless by design, so anyone may trigger a due line (an employee can
///      release their own salary); since payee, amount and timing are all pinned, the trigger has no
///      discretion whatsoever. The worst a hostile caller can do is run your payroll on time.
///
///      Two decisions carry the security argument:
///
///      1. **Skip, never accrue.** On payment, `nextDue` advances to the next boundary AFTER now, not by
///         one period. Writing `nextDue += period` would leave a long-idle line still in the past, so a
///         watcher that had been down for three months would fire three times on the way back up. Damage
///         from any outage is capped at one run, permanently.
///      2. **Exact amounts.** A cap would let whoever triggers the line take the maximum every period.
///         Pinning the amount means a fully compromised trigger can only do the thing you already asked
///         for.
///
///      Known sharp edge, shared with RateLimitRule: `authorize` advances `nextDue` before the enclave
///      submits, so an underfunded payment burns its slot. That fails in the safe direction — a missed
///      run, never a double one — and is handled off-chain by not triggering a line the account can't
///      cover. `dueAt`/`linesOf` exist so the UI can warn ahead of time.
contract ScheduledRule is KeylessRuleBase {
    using CalendarLib for uint64;

    /// @notice Cap on lines per wallet. `authorize` loops, so an unbounded schedule would be a way to
    ///         push the account past the block gas limit and stop it paying anyone at all.
    uint256 public constant MAX_LINES = 64;

    struct Line {
        bytes32 payee; // keccak(recipient) — mappings stay non-enumerable, as in every other rule
        uint256 amount; // drops, EXACT
        uint64 nextDue; // unix seconds; nothing authorizes before this
        uint32 runsLeft; // payments remaining; 0 = unlimited
        uint8 unit; // CalendarLib.CAL_DAY | CAL_WEEK | CAL_MONTH
        uint8 offsetDays; // into the window: 14 + CAL_MONTH = the 15th
        bool active;
    }

    /// @notice What the owner submits. Recipients arrive as strings so the event can carry them in the
    ///         clear for the UI to replay, exactly like the other rules.
    struct LineInput {
        string recipient;
        uint256 amount;
        uint8 unit;
        uint8 offsetDays;
        uint32 runs; // 0 = unlimited
        uint64 startAt; // 0 = the next boundary from now; otherwise snapped forward to a boundary
    }

    /// @notice walletId => its schedule.
    mapping(bytes32 => Line[]) public linesOf;

    event ScheduleConfigured(bytes32 indexed walletId, uint256 lineCount);
    event LineAdded(
        bytes32 indexed walletId,
        uint256 indexed index,
        string recipient,
        uint256 amount,
        uint8 unit,
        uint8 offsetDays,
        uint32 runs,
        uint64 firstDue
    );
    event LinePaid(bytes32 indexed walletId, uint256 indexed index, uint256 amount, uint64 nextDue);
    event ScheduleCancelled(bytes32 indexed walletId);

    constructor(address _accounts) KeylessRuleBase(_accounts) {}

    /// @notice Create or replace the whole schedule for a wallet.
    function configure(bytes32 walletId, LineInput[] calldata lines)
        external
        onlyWalletOwner(walletId)
        notLocked(walletId)
    {
        if (lines.length > MAX_LINES) revert Rejected("too many scheduled payments");

        delete linesOf[walletId];
        for (uint256 i = 0; i < lines.length; ++i) {
            LineInput calldata in_ = lines[i];
            if (in_.amount == 0) revert Rejected("amount is zero");
            if (bytes(in_.recipient).length == 0) revert Rejected("recipient is empty");
            if (in_.unit > CalendarLib.CAL_MONTH) revert Rejected("bad schedule unit");
            // Bounded so an offset can never spill into the next window — see CalendarLib.
            uint8 maxOffset = in_.unit == CalendarLib.CAL_MONTH ? 27 : (in_.unit == CalendarLib.CAL_WEEK ? 6 : 0);
            if (in_.offsetDays > maxOffset) revert Rejected("offset outside the window");

            uint64 from = in_.startAt == 0 ? uint64(block.timestamp) : in_.startAt;
            if (from < block.timestamp) revert Rejected("start date is in the past");
            uint64 firstDue = from.nextBoundaryAfter(in_.unit, in_.offsetDays);

            linesOf[walletId].push(
                Line({
                    payee: keccak256(bytes(in_.recipient)),
                    amount: in_.amount,
                    nextDue: firstDue,
                    runsLeft: in_.runs,
                    unit: in_.unit,
                    offsetDays: in_.offsetDays,
                    active: true
                })
            );
            emit LineAdded(walletId, i, in_.recipient, in_.amount, in_.unit, in_.offsetDays, in_.runs, firstDue);
        }
        emit ScheduleConfigured(walletId, lines.length);
    }

    /// @notice Stop everything. Nothing further can be paid. (Blocked once the wallet is locked — see
    ///         `hasUnlimitedLine`, which is why the UI must refuse to lock an endless schedule.)
    function cancel(bytes32 walletId) external onlyWalletOwner(walletId) notLocked(walletId) {
        delete linesOf[walletId];
        emit ScheduleCancelled(walletId);
    }

    /// @notice The rule check. Reverts unless this exact payment is a scheduled one that has come due.
    function authorize(bytes32 walletId, string calldata recipient, uint256 amount, bytes32)
        external
        override
        onlyAccounts
    {
        bytes32 payee = keccak256(bytes(recipient));
        Line[] storage ls = linesOf[walletId];

        for (uint256 i = 0; i < ls.length; ++i) {
            Line storage l = ls[i];
            if (!l.active || l.payee != payee || l.amount != amount) continue;
            if (block.timestamp < l.nextDue) continue;

            // Skip, never accrue. See the contract notes — `nextDue += period` here would turn every
            // outage into a burst of back-payments the moment a trigger came back online.
            l.nextDue = uint64(block.timestamp).nextBoundaryAfter(l.unit, l.offsetDays);

            if (l.runsLeft != 0) {
                unchecked {
                    l.runsLeft -= 1;
                }
                if (l.runsLeft == 0) l.active = false;
            }
            emit LinePaid(walletId, i, amount, l.nextDue);
            return;
        }
        revert Rejected("nothing scheduled is due for that recipient and amount");
    }

    // --- views for the UI ---------------------------------------------------------------------------

    function lineCount(bytes32 walletId) external view returns (uint256) {
        return linesOf[walletId].length;
    }

    /// @notice True while any line would run forever. Locking such a schedule makes it an irrevocable
    ///         standing order that empties the account, and the rule cannot prevent that on its own:
    ///         `configure`/`cancel` are already `notLocked`, and `lock()` lives in KeylessAccounts, which
    ///         knows nothing about lines. So the refusal belongs in the UI, and this is the fact it reads.
    function hasUnlimitedLine(bytes32 walletId) external view returns (bool) {
        Line[] storage ls = linesOf[walletId];
        for (uint256 i = 0; i < ls.length; ++i) {
            if (ls[i].active && ls[i].runsLeft == 0) return true;
        }
        return false;
    }

    /// @notice The soonest moment anything is payable, and how much the account needs by then. Lets the
    ///         account page say "you'll need 500 XRP on 1 September" instead of reporting a miss after it
    ///         has already happened.
    function nextRun(bytes32 walletId) external view returns (uint64 dueAt, uint256 totalDrops) {
        Line[] storage ls = linesOf[walletId];
        for (uint256 i = 0; i < ls.length; ++i) {
            if (!ls[i].active) continue;
            if (dueAt == 0 || ls[i].nextDue < dueAt) dueAt = ls[i].nextDue;
        }
        if (dueAt == 0) return (0, 0);
        for (uint256 i = 0; i < ls.length; ++i) {
            if (ls[i].active && ls[i].nextDue == dueAt) totalDrops += ls[i].amount;
        }
    }
}
