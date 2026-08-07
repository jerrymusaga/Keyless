// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title CalendarLib
/// @notice Real calendar boundaries in pure integer arithmetic — the 1st of the month, Monday, midnight,
///         all at 00:00 UTC. "Monthly" has to mean the 1st, not "every 30 days", or a schedule drifts a
///         day earlier every quarter and payroll lands on the wrong side of a month end.
///
/// @dev Howard Hinnant's days<->civil algorithms, exact for all post-1970 dates. Lifted verbatim from
///      RateLimitRule, which carries its own copy; that rule is deployed and left untouched, and can
///      adopt this library whenever it is next redeployed.
library CalendarLib {
    uint8 internal constant CAL_DAY = 0;
    uint8 internal constant CAL_WEEK = 1;
    uint8 internal constant CAL_MONTH = 2;

    /// @notice `offsetDays` sentinel meaning "the last day of the month", whatever length that month is.
    ///         Payroll is commonly paid at month end, and no fixed offset expresses that: the 31st doesn't
    ///         exist in April, and the 28th isn't month end except in a non-leap February. 255 is safe as a
    ///         sentinel because real offsets are bounded well below it (<=27 for months).
    uint8 internal constant LAST_DAY = 255;

    /// @notice Start of the calendar window containing `ts`, at 00:00 UTC.
    function boundaryAtOrBefore(uint64 ts, uint8 unit) internal pure returns (uint64) {
        uint256 dayIdx = uint256(ts) / 86400;
        if (unit == CAL_DAY) return uint64(dayIdx * 86400);
        if (unit == CAL_WEEK) {
            uint256 dow = (dayIdx + 3) % 7; // unix day 0 = Thursday; Monday = 0
            return uint64((dayIdx - dow) * 86400);
        }
        (uint256 y, uint256 m) = _yearMonth(dayIdx);
        return uint64(daysFromCivil(y, m, 1) * 86400);
    }

    /// @notice The first boundary strictly after `ts`, offset into the window by `offsetDays`.
    ///
    /// @dev The offset is applied AFTER stepping, and the caller is responsible for keeping it inside the
    ///      shortest possible window (see ScheduledRule's bounds: <=27 for months, <=6 for weeks). That
    ///      restriction is what lets this skip end-of-month clamping entirely — day 28 exists in every
    ///      month, so an offset schedule can never spill into the following one.
    function nextBoundaryAfter(uint64 ts, uint8 unit, uint8 offsetDays) internal pure returns (uint64) {
        if (unit == CAL_MONTH && offsetDays == LAST_DAY) {
            (uint256 ly, uint256 lm) = _yearMonth(uint256(ts) / 86400);
            uint64 endOfThis = _lastDayOf(ly, lm);
            if (endOfThis > ts) return endOfThis;
            if (lm == 12) {
                ly += 1;
                lm = 1;
            } else {
                lm += 1;
            }
            return _lastDayOf(ly, lm);
        }

        uint64 base = boundaryAtOrBefore(ts, unit);
        uint64 offset = uint64(offsetDays) * 86400;

        // Landing later in the current window still counts as ahead of `ts`.
        if (base + offset > ts) return base + offset;

        if (unit == CAL_DAY) return base + 86400 + offset;
        if (unit == CAL_WEEK) return base + 7 days + offset;

        (uint256 y, uint256 m) = _yearMonth(uint256(base) / 86400);
        if (m == 12) {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
        return uint64(daysFromCivil(y, m, 1) * 86400) + offset;
    }

    /// @notice 00:00 UTC on the final day of month `m` — derived as the day before the next month starts,
    ///         so leap years and 30/31-day months need no table and no special cases.
    function _lastDayOf(uint256 y, uint256 m) private pure returns (uint64) {
        uint256 ny = m == 12 ? y + 1 : y;
        uint256 nm = m == 12 ? 1 : m + 1;
        return uint64((daysFromCivil(ny, nm, 1) - 1) * 86400);
    }

    function _yearMonth(uint256 dayIdx) private pure returns (uint256 y, uint256 m) {
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

    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        uint256 yy = m <= 2 ? y - 1 : y;
        uint256 era = yy / 400;
        uint256 yoe = yy - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
