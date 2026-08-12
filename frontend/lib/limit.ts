import { publicClient } from "./clients";
import { RULES, RULE_ABIS } from "./keyless";

/**
 * The live state of a spending limit, read from the rule itself.
 *
 * Lives here rather than inside the config panel because two places need the same answer and they must not
 * disagree: the panel that shows the allowance, and the spend form, which was printing the XRPL balance as
 * the ceiling ("this account can send 95 XRP") on an account whose policy allowed 7. The number next to a
 * payment button has to be the number the rule will actually enforce.
 */
export type LimitState = {
  cap: bigint;
  /** Drops already spent in the CURRENT window — zero once a stale window is accounted for. */
  spent: bigint;
  /** Drops still spendable under the policy right now. */
  left: bigint;
  /** Unix seconds when the allowance refills; 0 for a one-off budget, or a rolling window that lapsed. */
  resetAt: number;
  /** 0 rolling · 1 calendar · 2 until-a-date */
  mode: number;
  /** Unix seconds a one-off budget closes; 0 otherwise. */
  endsAt: number;
  /**
   * The stored `spent` belongs to a window that has already ended.
   *
   * RateLimitRule rolls the window LAZILY, inside authorize() — so after a period elapses with no payment
   * the chain still holds the old figure and only zeroes it on the next payment. Read literally it claims
   * less is available than really is, so treat it as full.
   */
  stale: boolean;
};

export async function readLimit(walletId: `0x${string}`): Promise<LimitState | null> {
  const l = (await publicClient.readContract({
    address: RULES.rateLimit as `0x${string}`,
    abi: RULE_ABIS.rateLimit as never,
    functionName: "limitOf",
    args: [walletId],
  })) as readonly [boolean, number, boolean, bigint, bigint, bigint, bigint, bigint];

  const [configured, mode, , cap, spent, , windowStart, param] = l;
  if (!configured) return null;

  const t = Math.floor(Date.now() / 1000);
  const d = new Date();

  // Mirrors RateLimitRule: rolling adds the period to the window start; calendar rolls to the next real
  // boundary; "until a date" is a one-off budget that never refills.
  let resetAt = 0, endsAt = 0, stale = false;
  if (mode === 0) {
    resetAt = Number(windowStart) + Number(param);
    stale = t >= resetAt;
  } else if (mode === 1) {
    const unit = Number(param); // 0 day, 1 week, 2 month
    let start: number;
    if (unit === 0) {
      start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      resetAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000;
    } else if (unit === 1) {
      const dow = (d.getUTCDay() + 6) % 7;
      start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) / 1000;
      resetAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (7 - dow)) / 1000;
    } else {
      start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
      resetAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
    }
    stale = Number(windowStart) < start; // the spend belongs to a period that has already ended
  } else {
    endsAt = Number(param); // one-off budget; never refills
  }

  const effSpent = stale ? 0n : spent;
  return {
    cap,
    spent: effSpent,
    left: cap > effSpent ? cap - effSpent : 0n,
    resetAt,
    mode,
    endsAt,
    stale,
  };
}

/**
 * "in 4h 12m" — a wait said the way people think about it.
 *
 * Deliberately never shows seconds: callers re-read on a 15s tick, and a seconds display that only moves
 * every 15s reads as broken. Under a minute it just says so.
 */
export function fmtIn(ts: number, now: number): string {
  const s = ts - now;
  if (s <= 0) return "now";
  if (s < 60) return "in under a minute";
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `in ${d} day${d > 1 ? "s" : ""}${h % 24 ? ` ${h % 24}h` : ""}`;
  if (h >= 1) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `in ${m} min`;
}
