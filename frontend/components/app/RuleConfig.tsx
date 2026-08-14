"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { useKeyless } from "./KeylessProvider";
import { Button, Field, Input, NumberInput, Notice, Copy, AddressLabel, NameThisAddress } from "./ui";
import { readLimit, fmtIn, type LimitState } from "@/lib/limit";
import { publicClient } from "@/lib/clients";
import { getXrplBalance } from "@/lib/xrpl";
import { ADDRESSES, ACCOUNTS_ABI, CONDITION_TEMPLATES, EXPECTED_TRUE, FSA_READER_ABI, FIRELIGHT_VAULT_ABI, INIT_FEE, RULES, RULE_ABIS, VAULT_TYPE_NAME, XRPL_ADDRESS_RE, ZERO_ADDRESS, addr, explorerTx, formatDrops, scheduleEnd, type ConditionKey, type RuleKey } from "@/lib/keyless";

/** The exact FAssets direct-minting memo (0x4642505266410018 · 0000 · recipient) — mirrors FxrpMintRule.mintMemo. */
const fxrpMintMemo = (flareAddr: `0x${string}`) => `0x464250526641001800000000${flareAddr.slice(2)}` as `0x${string}`;

function xrpToDrops(s: string): bigint {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error("enter an amount in XRP");
  return BigInt(Math.round(n * 1e6));
}
function assertXrpl(a: string) {
  if (!XRPL_ADDRESS_RE.test(a.trim())) throw new Error("that isn't a valid XRPL r-address");
}
/** The same test as a predicate, for UI that reacts to a half-typed address instead of rejecting it. */
const isXrpl = (a: string) => XRPL_ADDRESS_RE.test(a.trim());

/** Nudge the account page's "can & can't" card (a sibling component) to refetch the live config — now, and
 *  again after the explorer has had a few seconds to index the change — so the user needn't refresh. */
function signalConfigChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("kl:config-changed"));
  setTimeout(() => window.dispatchEvent(new Event("kl:config-changed")), 6000);
}

// Window units. The RateLimitRule takes `period` as raw seconds, so any count × unit works — the UI just
// composes them. Order matters: periodLabel picks the largest unit that divides a stored period evenly.
const UNITS: { label: string; seconds: number }[] = [
  { label: "minutes", seconds: 60 },
  { label: "hours", seconds: 3_600 },
  { label: "days", seconds: 86_400 },
  { label: "weeks", seconds: 604_800 },
  { label: "months", seconds: 2_592_000 }, // 30 days
];

/** Rule-specific configuration. Every call here is onlyWalletOwner on-chain — signed by the control key. */
export function RuleConfig({ walletId, ruleKey }: { walletId: `0x${string}`; ruleKey: RuleKey }) {
  if (ruleKey === "exchange") return <ExchangeConfig walletId={walletId} />;
  if (ruleKey === "rateLimit") return <RateLimitConfig walletId={walletId} />;
  if (ruleKey === "fxrp") return <FxrpConfig walletId={walletId} />;
  if (ruleKey === "scheduled") return <ScheduledConfig walletId={walletId} />;
  return <ConditionalConfig walletId={walletId} />;
}

// Calendar units, matching CalendarLib. `offsetMax` is what keeps a schedule inside its own window —
// day 28 exists in every month, so an offset payday can never spill into the next one.
const CAL = [
  { unit: 0, label: "day", every: "Every day", offsetMax: 0 },
  { unit: 1, label: "week", every: "Every week", offsetMax: 6 },
  { unit: 2, label: "month", every: "Every month", offsetMax: 27 },
] as const;

const ORDINAL = (n: number) => {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** CalendarLib.LAST_DAY — "the last day of the month", whatever length that month happens to be. Payroll
 *  is commonly paid at month end, and no fixed date says that: the 31st is missing from April. */
const LAST_DAY = 255;

/** Everything a line needs before it can be saved. Returns what's missing, in the order it's asked for. */
function lineGaps(l: ScheduleLine): string[] {
  const gaps: string[] = [];
  if (!XRPL_ADDRESS_RE.test(l.recipient.trim())) gaps.push("who to pay");
  if (!(Number(l.amount) > 0)) gaps.push("how much");
  if (!(Number.isInteger(Number(l.runs)) && Number(l.runs) >= 1)) gaps.push("how many payments");
  return gaps;
}

type ScheduleLine = { recipient: string; amount: string; unit: number; offsetDays: number; runs: string; startAt: string };
type SavedLine = {
  amount: bigint; nextDue: number; runsLeft: number; unit: number; offsetDays: number; active: boolean;
};

/** Say a line back as the sentence the user filled in, not as its fields. */
function describeLine(l: { unit: number; offsetDays: number }): string {
  if (l.unit === 0) return "every day";
  if (l.unit === 1) return `every ${DAY_NAMES[l.offsetDays] ?? "Monday"}`;
  if (l.offsetDays === LAST_DAY) return "on the last day of every month";
  return `on the ${ORDINAL(l.offsetDays + 1)} of every month`;
}

/**
 * The XRP price, fetched once and shared. Display only — see /api/price for why the conversion lives at
 * the edge and never inside a rule.
 */
let xrpUsdCache: { at: number; usd: number } | null = null;
function useXrpUsd(): number | null {
  const [usd, setUsd] = useState<number | null>(xrpUsdCache?.usd ?? null);
  useEffect(() => {
    if (xrpUsdCache && Date.now() - xrpUsdCache.at < 60_000) return;
    let stop = false;
    fetch("/api/price")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (stop || !b?.usd) return;
        xrpUsdCache = { at: Date.now(), usd: b.usd };
        setUsd(b.usd);
      })
      .catch(() => { /* the hint just doesn't render */ });
    return () => { stop = true; };
  }, []);
  return usd;
}

/** "≈ $57" beside an amount the contract has already fixed in XRP. Renders nothing if the price is down. */
function UsdHint({ drops, usd }: { drops: bigint; usd: number | null }) {
  if (usd === null) return null;
  const value = (Number(drops) / 1e6) * usd;
  if (!Number.isFinite(value)) return null;
  return (
    <span className="text-mist-500">
      {" "}(about ${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 })})
    </span>
  );
}

const MS_DAY = 86_400_000;
/**
 * When the first payment would land — a mirror of CalendarLib.nextBoundaryAfter, verified against the
 * deployed rule. Showing the actual date is what turns four form fields back into a sentence someone can
 * check before they commit to it.
 */
function firstDue(unit: number, offsetDays: number, startAtISO: string): Date {
  const from = startAtISO ? Date.parse(`${startAtISO}T00:00:00Z`) : Date.now();
  const d = new Date(from);

  // Month end: day 0 of the following month IS the last day of this one, so leap years and 30/31-day
  // months need no special casing — same trick the contract uses.
  if (unit === 2 && offsetDays === LAST_DAY) {
    const endOfThis = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
    return new Date(endOfThis > from ? endOfThis : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  }

  let base: number;
  if (unit === 0) base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  else if (unit === 1) {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * MS_DAY;
  } else base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

  const off = offsetDays * MS_DAY;
  if (base + off > from) return new Date(base + off);
  if (unit === 0) return new Date(base + MS_DAY + off);
  if (unit === 1) return new Date(base + 7 * MS_DAY + off);
  const b = new Date(base);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1) + off);
}

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/**
 * A date AND the time it actually happens, in the reader's own clock.
 *
 * Calendar boundaries here are 00:00 UTC, which a tester met the hard way: they scheduled a payment "for
 * today", nothing had run by 07:50 UTC, and they couldn't tell a wait from a failure. A date alone can't
 * answer that question — and a time in UTC alone still makes the reader do arithmetic — so show theirs,
 * and say which zone it is.
 */
const fmtWhen = (ts: number) => {
  const d = new Date(ts * 1000);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} at ${
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} (${zone})`;
};

function ScheduledConfig({ walletId }: { walletId: `0x${string}` }) {
  const [lines, setLines] = useState<ScheduleLine[]>([
    { recipient: "", amount: "", unit: 2, offsetDays: 0, runs: "", startAt: "" },
  ]);
  const [saved, setSaved] = useState<SavedLine[] | null>(null);
  // The contract stores keccak(recipient), so the readable address comes from the configure events. Index
  // order matches: configure() pushes lines in the order it emits them.
  const [savedPayees, setSavedPayees] = useState<string[]>([]);
  const { address: owner } = useKeyless();
  const [next, setNext] = useState<{ dueAt: number; totalDrops: bigint } | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [runsLeft, setRunsLeft] = useState<number | null>(null);
  const usd = useXrpUsd();
  const { busy, msg, run } = useConfigAction();

  const load = useCallback(async () => {
    const rule = RULES.scheduled as `0x${string}`;
    const abi = RULE_ABIS.scheduled as never;
    try {
      const count = (await publicClient.readContract({ address: rule, abi, functionName: "lineCount", args: [walletId] })) as bigint;
      const rows: SavedLine[] = [];
      for (let i = 0n; i < count; i++) {
        const l = (await publicClient.readContract({ address: rule, abi, functionName: "linesOf", args: [walletId, i] })) as readonly [string, bigint, bigint, number, number, number, boolean];
        rows.push({ amount: l[1], nextDue: Number(l[2]), runsLeft: Number(l[3]), unit: Number(l[4]), offsetDays: Number(l[5]), active: l[6] });
      }
      setSaved(rows);
      try {
        const res = await fetch("/api/rule-config", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rule: "scheduled", walletId }), cache: "no-store",
        });
        const b = await res.json();
        if (Array.isArray(b.lines)) setSavedPayees(b.lines.map((l: { recipient: string }) => l.recipient));
      } catch { /* the row just shows no payee */ }
      const nr = (await publicClient.readContract({ address: rule, abi, functionName: "nextRun", args: [walletId] })) as readonly [bigint, bigint];
      setNext({ dueAt: Number(nr[0]), totalDrops: nr[1] });
      setRunsLeft(Number((await publicClient.readContract({ address: rule, abi, functionName: "runsRemaining", args: [walletId] })) as bigint));
    } catch { /* transient */ }
    // The whole point of knowing the future is being able to warn about it in advance.
    try {
      const xrpl = (await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI as never, functionName: "xrplAddressOf", args: [walletId] })) as string;
      if (xrpl) {
        const b = await getXrplBalance(xrpl);
        setBalance(b.funded ? b.drops : 0n);
      }
    } catch { /* leave the warning off rather than guess */ }
  }, [walletId]);
  useEffect(() => { load(); }, [load]);

  const set = (i: number, patch: Partial<ScheduleLine>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const save = async () => {
    const payload: { recipient: string; amount: bigint; unit: number; offsetDays: number; runs: number; startAt: bigint }[] = [];
    try {
      for (const l of lines) {
        assertXrpl(l.recipient);
        // Required, not optional: an endless schedule on a locked account would be unstoppable, so the
        // rule refuses runs of 0 outright. Ask for the number here rather than let the chain say no.
        const runs = Number(l.runs);
        if (!Number.isInteger(runs) || runs < 1) throw new Error("say how many payments this should make");
        // Blank means "the next one". A date is snapped forward to the next matching slot by the rule,
        // so picking the 3rd for a monthly line still lands on the 1st — the schedule stays calendar-true.
        let startAt = 0n;
        if (l.startAt) {
          const ts = Math.floor(new Date(`${l.startAt}T00:00:00Z`).getTime() / 1000);
          if (!ts) throw new Error("that start date isn't valid");
          if (ts < Math.floor(Date.now() / 1000)) throw new Error("the start date has already passed");
          startAt = BigInt(ts);
        }
        payload.push({ recipient: l.recipient.trim(), amount: xrpToDrops(l.amount), unit: l.unit, offsetDays: l.offsetDays, runs, startAt });
      }
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    const ok = await run(
      RULES.scheduled as `0x${string}`, RULE_ABIS.scheduled, "configure", [walletId, payload],
      `Set. This account can only pay ${payload.length === 1 ? "that payment" : `those ${payload.length} payments`}, on time, and nothing else.`,
    );
    if (ok) { load(); signalConfigChanged(); }
  };

  const cancel = async () => {
    if (!confirm("Stop every scheduled payment on this account?")) return;
    const ok = await run(RULES.scheduled as `0x${string}`, RULE_ABIS.scheduled, "cancel", [walletId], "Stopped. Nothing further can be paid.");
    if (ok) { load(); signalConfigChanged(); }
  };

  const active = (saved ?? []).filter((l) => l.active);
  const incomplete = lines.filter((l) => lineGaps(l).length > 0).length;
  const short = next && balance !== null && next.dueAt > 0 && balance < next.totalDrops;

  return (
    <div className="space-y-4">
      {next && next.dueAt > 0 && (
        <Notice tone={short ? "warn" : "info"}>
          <div className="space-y-1">
            <div>
              <span className="font-medium">Next payment {fmtWhen(next.dueAt)}</span> — {formatDrops(next.totalDrops)}<UsdHint drops={next.totalDrops} usd={usd} />
              {active.length > 1 && <> across {active.length} lines</>}.
            </div>
            {short ? (
              <div>
                This account holds {formatDrops(balance!)}. Top it up before then, or the payment is skipped —
                a missed run isn&rsquo;t paid late, it&rsquo;s simply missed.
              </div>
            ) : (
              balance !== null && <div className="text-mist-400">Funded — this account holds {formatDrops(balance)}.</div>
            )}
          </div>
        </Notice>
      )}

      {runsLeft !== null && runsLeft > 0 && (() => {
        // The count alone can't be judged — 12 is a year, 4 billion is longer than the sun has. Lead with
        // the date, and don't claim locking is safe when the schedule has no end anyone will see.
        const l0 = active[0];
        const end = l0 ? scheduleEnd(l0.unit, l0.offsetDays, l0.nextDue, l0.runsLeft) : null;
        return (
          <Notice tone={end ? "ok" : "warn"}>
            {end ? (
              <>
                <span className="font-medium">{runsLeft} payment{runsLeft === 1 ? "" : "s"} left, ending {fmtDate(Math.floor(end.getTime() / 1000))}.</span>{" "}
                After that it stops for good — so locking this account is safe: that is the most that can ever leave it.
              </>
            ) : (
              <>
                <span className="font-medium">{runsLeft} payments left — far enough out that this schedule never realistically ends.</span>{" "}
                Don&rsquo;t lock this account: locking is permanent, and it would keep paying until the account is empty.
              </>
            )}
          </Notice>
        );
      })()}

      {active.length > 0 && (
        <div className="hairline rounded-xl border">
          {active.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 border-b border-white/5 p-3 last:border-0">
              <span className="text-[13px] text-mist-200">
                {formatDrops(l.amount)}<UsdHint drops={l.amount} usd={usd} /> {describeLine(l)}
                {savedPayees[i] && <> to <AddressLabel owner={owner} address={savedPayees[i]} inline /></>}
              </span>
              <span className="shrink-0 text-[11px] text-mist-500">
                next {fmtWhen(l.nextDue)}
                {l.runsLeft > 0 && <> · {l.runsLeft} left</>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {lines.map((l, i) => {
          const cal = CAL[l.unit];
          return (
            <div key={i} className="hairline space-y-3 rounded-xl border bg-ink-900/40 p-3">
              <Field label="Who gets paid?">
                <div className="flex gap-2">
                  <Input value={l.recipient} onChange={(e) => set(i, { recipient: e.target.value })} placeholder="rAlice…" />
                  <NameThisAddress owner={owner} address={l.recipient} valid={isXrpl} className="w-40 shrink-0" />
                </div>
              </Field>

              {/* A fixed grid, not a wrapping row: with five controls the row broke into ragged lines and
                  "how many payments" ended up orphaned under a field it has nothing to do with. */}
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <Field label="How much, each time?" hint="The exact amount — never more, never less">
                  <div className="flex items-center gap-2">
                    <NumberInput value={l.amount} onValueChange={(v) => set(i, { amount: v })} decimal placeholder="500" className="w-full" />
                    <span className="shrink-0 text-[13px] text-mist-500">XRP</span>
                  </div>
                </Field>

                <Field label="How often?">
                  <select
                    value={l.unit}
                    onChange={(e) => set(i, { unit: Number(e.target.value), offsetDays: 0 })}
                    className="hairline w-full rounded-lg border bg-ink-850 px-3 py-2 text-[13px] text-mist-100"
                  >
                    {CAL.map((c) => <option key={c.unit} value={c.unit}>{c.every}</option>)}
                  </select>
                </Field>

                {cal.offsetMax > 0 && (
                  <Field
                    label={l.unit === 1 ? "On which day?" : "On which date?"}
                    hint={l.unit === 2 ? "Pick a date up to the 28th so it exists in every month, or the last day" : undefined}
                  >
                    <select
                      value={l.offsetDays}
                      onChange={(e) => set(i, { offsetDays: Number(e.target.value) })}
                      className="hairline w-full rounded-lg border bg-ink-850 px-3 py-2 text-[13px] text-mist-100"
                    >
                      {Array.from({ length: cal.offsetMax + 1 }, (_, d) => (
                        <option key={d} value={d}>{l.unit === 1 ? DAY_NAMES[d] : `the ${ORDINAL(d + 1)}`}</option>
                      ))}
                      {l.unit === 2 && <option value={LAST_DAY}>the last day</option>}
                    </select>
                  </Field>
                )}

                <Field label="How many payments?" hint="Then it stops for good">
                  <NumberInput value={l.runs} onValueChange={(v) => set(i, { runs: v })} placeholder="12" className="w-full" />
                </Field>

                <Field label="Start from" hint="Leave blank to start with the next one. Runs land at 00:00 UTC.">
                  <input
                    type="date"
                    value={l.startAt}
                    onChange={(e) => set(i, { startAt: e.target.value })}
                    className="hairline w-full rounded-lg border bg-ink-850 px-3 py-2 text-[13px] text-mist-100"
                  />
                </Field>
              </div>

              {/* Read the whole thing back as one sentence. Four correct fields still don't tell you what
                  you just agreed to; this does, before it's signed. */}
              {lineGaps(l).length === 0 ? (
                <p className="text-[12px] leading-relaxed text-signal-300/90">
                  {formatDrops(xrpToDrops(l.amount))}<UsdHint drops={xrpToDrops(l.amount)} usd={usd} /> to <span className="font-mono">{addr(l.recipient.trim())}</span> {describeLine(l)},{" "}
                  {l.runs} time{Number(l.runs) === 1 ? "" : "s"} — first on{" "}
                  {fmtWhen(Math.floor(firstDue(l.unit, l.offsetDays, l.startAt).getTime() / 1000))}
                  {(() => {
                    const first = Math.floor(firstDue(l.unit, l.offsetDays, l.startAt).getTime() / 1000);
                    const end = scheduleEnd(l.unit, l.offsetDays, first, Number(l.runs));
                    return end ? <>, last on {fmtDate(Math.floor(end.getTime() / 1000))}.</>
                      : <>. <span className="text-warn-500">That many payments never realistically end — don&rsquo;t lock this account.</span></>;
                  })()}
                </p>
              ) : (
                <p className="text-[12px] text-mist-500">Still needed: {lineGaps(l).join(", ")}.</p>
              )}

              {lines.length > 1 && (
                <button type="button" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} className="text-[11px] text-mist-500 hover:text-refuse-500">
                  Remove
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, { recipient: "", amount: "", unit: 2, offsetDays: 0, runs: "", startAt: "" }])}
          className="text-[12px] text-signal-400 hover:text-signal-300"
        >
          + Another payment
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-mist-500">
        Saving replaces the whole schedule. Nothing can be paid early, nothing can be paid twice in the same{" "}
        {CAL[lines[0]?.unit ?? 2].label}, and nobody outside this list can be paid at all — including you.
        Every line ends after the number of payments you set.
      </p>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy || incomplete > 0}>
          {busy ? "Saving…" : incomplete > 0 ? `Finish ${incomplete === lines.length && lines.length === 1 ? "the payment" : `${incomplete} payment${incomplete === 1 ? "" : "s"}`}` : "Save schedule"}
        </Button>
        {active.length > 0 && (
          <button type="button" onClick={cancel} disabled={busy} className="text-[12px] text-mist-500 hover:text-refuse-500">
            Stop everything
          </button>
        )}
      </div>
      {msg && <Notice tone={msg.tone === "ok" ? "ok" : "error"}>{msg.text}</Notice>}
    </div>
  );
}

type SavedRecipient = { address: string; requireTag: boolean; tag: number };

function ExchangeConfig({ walletId }: { walletId: `0x${string}` }) {
  // Exchange keeps its own recipient list rather than using SavedRecipients, because it also shows
  // destination tags — which is exactly why naming was missing here when it worked everywhere else.
  const { write, address: owner } = useKeyless();
  const [rows, setRows] = useState<{ address: string; tag: string }[]>([{ address: "", tag: "" }]);
  const [maxTx, setMaxTx] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saved, setSaved] = useState<SavedRecipient[] | null>(null);
  const [cap, setCap] = useState<bigint | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // The live allowlist + cap, read back from chain so a refresh (or another device) shows what's saved.
  const loadSaved = useCallback(async () => {
    try {
      const [res, capValue] = await Promise.all([
        fetch("/api/rule-config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rule: "exchange", walletId }),
          cache: "no-store",
        }),
        publicClient.readContract({
          address: RULES.exchange as `0x${string}`,
          abi: RULE_ABIS.exchange as never,
          functionName: "maxPerTx",
          args: [walletId],
        }) as Promise<bigint>,
      ]);
      const body = await res.json().catch(() => ({}));
      if (Array.isArray(body.recipients)) setSaved(body.recipients);
      setCap(capValue);
    } catch {
      /* transient — keep whatever we last showed */
    }
  }, [walletId]);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  const addRow = () => setRows((r) => [...r, { address: "", tag: "" }]);
  const removeRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i));
  const setRow = (i: number, field: "address" | "tag", v: string) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [field]: v } : row)));

  const removeRecipient = async (address: string) => {
    setMsg(null);
    setRemoving(address);
    try {
      await write({ address: RULES.exchange as `0x${string}`, abi: RULE_ABIS.exchange as never, functionName: "remove", args: [walletId, address] });
      setSaved((s) => (s ? s.filter((r) => r.address !== address) : s)); // optimistic
      setMsg({ tone: "ok", text: `Removed ${addr(address)}. This account can no longer pay it.` });
      signalConfigChanged(); // nudge the "can & can't" card to refetch (now + after indexing)
      setTimeout(loadSaved, 5000); // reconcile once the explorer indexes the removal
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setRemoving(null);
    }
  };

  const save = async () => {
    setMsg(null);
    const valid = rows.filter((r) => r.address.trim());
    if (valid.length === 0) return setMsg({ tone: "error", text: "Add at least one recipient address." });
    for (const r of valid) {
      if (!XRPL_ADDRESS_RE.test(r.address.trim())) return setMsg({ tone: "error", text: `Not a valid XRPL r-address: ${r.address.trim()}` });
      if (r.tag.trim()) {
        const t = Number(r.tag.trim());
        if (!Number.isInteger(t) || t < 0 || t > 4_294_967_295) return setMsg({ tone: "error", text: "A destination tag must be a whole number 0–4294967295." });
      }
    }
    let capDrops = 0n;
    if (maxTx.trim()) {
      try {
        capDrops = xrpToDrops(maxTx);
      } catch (e) {
        return setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    // Signed by the embedded control key — no wallet popups, so a few sequential txs is fine.
    setBusy(true);
    try {
      for (const r of valid) {
        const a = r.address.trim();
        if (r.tag.trim()) {
          await write({ address: RULES.exchange as `0x${string}`, abi: RULE_ABIS.exchange as never, functionName: "allowWithTag", args: [walletId, a, Number(r.tag.trim())] });
        } else {
          await write({ address: RULES.exchange as `0x${string}`, abi: RULE_ABIS.exchange as never, functionName: "allow", args: [walletId, a] });
        }
      }
      if (capDrops > 0n) {
        await write({ address: RULES.exchange as `0x${string}`, abi: RULE_ABIS.exchange as never, functionName: "setMaxPerTx", args: [walletId, capDrops] });
      }
      // Optimistically reflect what we just saved; the explorer indexes the events a few seconds later.
      setSaved((s) => {
        const m = new Map((s ?? []).map((r) => [r.address, r] as const));
        for (const r of valid) {
          const a = r.address.trim();
          m.set(a, { address: a, requireTag: !!r.tag.trim(), tag: r.tag.trim() ? Number(r.tag.trim()) : 0 });
        }
        return [...m.values()];
      });
      if (capDrops > 0n) setCap(capDrops);
      const capNote = capDrops > 0n ? `, up to ${maxTx} XRP each` : "";
      setRows([{ address: "", tag: "" }]);
      setMaxTx("");
      setMsg({ tone: "ok", text: `Saved. This account can now pay ${valid.length} approved recipient${valid.length > 1 ? "s" : ""}${capNote} — and nowhere else.` });
      signalConfigChanged();
      setTimeout(loadSaved, 5000);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {saved && saved.length > 0 && (
        <Field label="Approved recipients" hint="Remove any to stop this account from paying it.">
          <div className="space-y-2">
            {saved.map((r) => (
              <div key={r.address} className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
                <AddressLabel owner={owner} address={r.address} className="flex-1" />
                {r.requireTag && (
                  <span className="shrink-0 rounded bg-signal-500/10 px-1.5 py-0.5 text-[10px] font-medium text-signal-300">tag {r.tag}</span>
                )}
                <Copy text={r.address} />
                <button
                  type="button"
                  onClick={() => removeRecipient(r.address)}
                  disabled={removing === r.address}
                  className="shrink-0 rounded-md border border-refuse-500/40 px-2 py-1 text-[11px] text-refuse-500 transition-colors hover:bg-refuse-500/10 disabled:opacity-50"
                >
                  {removing === r.address ? "…" : "Remove"}
                </button>
              </div>
            ))}
            {cap != null && cap > 0n && (
              <p className="text-[12px] text-mist-500">Max per transaction: <span className="text-mist-300">{formatDrops(cap)}</span></p>
            )}
          </div>
        </Field>
      )}

      <Field
        label="Who can this account pay?"
        hint="These are the only addresses it can ever pay. For an exchange deposit, add its destination tag; leave it blank otherwise."
      >
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input value={r.address} onChange={(e) => setRow(i, "address", e.target.value)} placeholder="rExchangeDeposit…" />
              <NameThisAddress owner={owner} address={r.address} valid={isXrpl} className="w-32 shrink-0" />
              <input
                value={r.tag}
                onChange={(e) => setRow(i, "tag", e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="tag (optional)"
                inputMode="numeric"
                className="w-36 shrink-0 rounded-lg border hairline bg-ink-950 px-3 font-mono text-sm text-mist-100 outline-none transition-colors placeholder:text-mist-500 focus:border-signal-500/60"
              />
              {rows.length > 1 && (
                <button type="button" onClick={() => removeRow(i)} aria-label="Remove" className="shrink-0 px-2 text-mist-500 transition-colors hover:text-red-300">
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={addRow} className="text-xs font-medium text-signal-400 transition-colors hover:text-signal-300">
            + Add another address
          </button>
        </div>
      </Field>

      <Field label="Most it can send in one payment?" hint="One cap on any single payment — applies to every recipient, not each one separately. Leave blank for no limit.">
        <NumberInput value={maxTx} onValueChange={setMaxTx} decimal placeholder="no limit" />
      </Field>

      <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function useConfigAction() {
  const { write } = useKeyless();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const run = async (address: `0x${string}`, abi: readonly unknown[], functionName: string, args: unknown[], ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await write({ address, abi: abi as never, functionName, args });
      setMsg({ tone: "ok", text: ok });
      return true;
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, run };
}

/** Format a stored period (seconds) into human text: "per day", "every 3 days", "every 6 hours". */
function periodLabel(secondsStr: string) {
  const s = Number(secondsStr);
  if (!Number.isFinite(s) || s <= 0) return "per period";
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const u = UNITS[i];
    if (s % u.seconds === 0) {
      const n = s / u.seconds;
      const singular = u.label.slice(0, -1); // "days" -> "day"
      return n === 1 ? `per ${singular}` : `every ${n} ${u.label}`;
    }
  }
  return `every ${s}s`;
}

export type Limit = { mode: number; cap: string; param: string; maxPerTx: string; allowlistOnly: boolean };
type RuleConfigResponse = {
  recipients?: SavedRecipient[];
  capDrops?: string;
  limit?: Limit;
};

const CAL_LABEL = ["day", "week", "month"]; // calendar unit index -> label
/** Human summary of a spending limit, per its duration mode. */
export function formatLimit(l: Limit): string {
  const cap = formatDrops(BigInt(l.cap));
  if (l.mode === 1) return `${cap} per calendar ${CAL_LABEL[Number(l.param)] ?? "period"}`;
  if (l.mode === 2) return `${cap} total until ${new Date(Number(l.param) * 1000).toLocaleDateString(undefined, { timeZone: "UTC" })} (UTC)`;
  return `${cap} ${periodLabel(l.param)}`; // rolling
}

/**
 * When the allowance refills, and how much is left until then.
 *
 * A tester asked for this outright — "not having to manually note the time would be helpful". They're
 * right that it's the one number a spending limit never told you: the rule knows exactly when the window
 * turns over and how much has gone, and the UI showed neither.
 */
function LimitStatus({ walletId }: { walletId: `0x${string}` }) {
  const [live, setLive] = useState<LimitState | null>(null);
  // Drives the countdown. 15s is fine because fmtIn never shows seconds.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const read = useCallback(async () => {
    try {
      setLive(await readLimit(walletId));
      setNow(Math.floor(Date.now() / 1000));
    } catch { /* transient */ }
  }, [walletId]);

  useEffect(() => {
    read();
    const t = setInterval(read, 30_000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    const onChange = () => read();
    window.addEventListener("kl:config-changed", onChange);
    return () => {
      clearInterval(t); clearInterval(tick);
      window.removeEventListener("kl:config-changed", onChange);
    };
  }, [read]);

  if (!live) return null;
  const left = live.cap > live.spent ? live.cap - live.spent : 0n;
  const pct = live.cap > 0n ? Number((live.spent * 100n) / live.cap) : 0;
  const closed = live.mode === 2 && live.endsAt > 0 && now >= live.endsAt;

  return (
    <div className="rounded-xl border hairline bg-ink-900/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-mist-200">
          <span className="font-medium text-mist-100">{formatDrops(closed ? 0n : left)}</span> left to spend
        </p>
        {/* The countdown answers "when?"; the date underneath answers "when exactly?" — a tester had to
            note the time by hand to work this out. */}
        {/* A stale ROLLING window has no knowable refill time — the next period only starts when the
            account next pays, so showing a date would be a guess. Calendar boundaries are absolute and
            stay correct either way. */}
        {live.resetAt > 0 && !(live.mode === 0 && live.stale) && (
          <p className="text-right text-[12px] text-mist-500">
            <span className="text-mist-300">refills {fmtIn(live.resetAt, now)}</span>
            <br />
            <span className="text-[11px]">{fmtWhen(live.resetAt)}</span>
          </p>
        )}
        {live.mode === 2 && live.endsAt > 0 && (
          <p className="text-right text-[12px] text-mist-500">
            <span className="text-mist-300">{closed ? "budget closed" : `ends ${fmtIn(live.endsAt, now)}`}</span>
            <br />
            <span className="text-[11px]">{fmtWhen(live.endsAt)}</span>
          </p>
        )}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div className="h-full rounded-full bg-signal-500/70" style={{ width: `${closed ? 100 : Math.min(100, pct)}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-mist-500">
        {closed
          ? "This was a one-off budget and its end date has passed. Nothing more can be spent."
          : live.stale
            ? `Full allowance available — the last window ended, so the next payment starts a fresh ${live.mode === 0 ? "period" : "one"}.`
            : live.mode === 2
              ? `${formatDrops(live.spent)} of ${formatDrops(live.cap)} used. This budget doesn${"\u2019"}t refill.`
              : `${formatDrops(live.spent)} of ${formatDrops(live.cap)} used this window.`}
      </p>
    </div>
  );
}

/**
 * "Currently approved" — the live on-chain allowlist for a rule, read back so a refresh (or another
 * device) shows what's saved, with a Remove button per recipient. Used by the multi-recipient rules
 * (allowlist, rateLimit); Exchange has its own richer version with destination tags. `refreshKey` is
 * bumped by the parent after a save so this re-reads once the explorer indexes the change.
 */
function SavedRecipients({ ruleKey, walletId, refreshKey }: { ruleKey: RuleKey; walletId: `0x${string}`; refreshKey: number }) {
  const usd = useXrpUsd();
  // Nicknames are scoped to the control key, so they follow you between accounts but not between people.
  const { write, address: owner } = useKeyless();
  const [data, setData] = useState<RuleConfigResponse | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rule-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: ruleKey, walletId }),
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (Array.isArray(body.recipients)) setData(body);
    } catch { /* transient — keep last */ }
  }, [ruleKey, walletId]);

  useEffect(() => {
    load();
    if (refreshKey > 0) { const t = setTimeout(load, 4500); return () => clearTimeout(t); } // reconcile after indexing
  }, [load, refreshKey]);

  const remove = async (address: string) => {
    setErr(null);
    setRemoving(address);
    try {
      await write({ address: RULES[ruleKey] as `0x${string}`, abi: RULE_ABIS[ruleKey] as never, functionName: "remove", args: [walletId, address] });
      setData((d) => (d ? { ...d, recipients: (d.recipients ?? []).filter((r) => r.address !== address) } : d)); // optimistic
      signalConfigChanged();
      setTimeout(load, 4500);
    } catch (e) {
      setErr(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setRemoving(null);
    }
  };

  const recipients = data?.recipients ?? [];
  if (recipients.length === 0 && !data?.limit) return null;

  return (
    <Field label="Approved recipients" hint="Remove any to stop this account from paying it.">
      <div className="space-y-2">
        {recipients.map((r) => (
          <div key={r.address} className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
            <AddressLabel owner={owner} address={r.address} className="flex-1" />
            <Copy text={r.address} />
            <button
              type="button"
              onClick={() => remove(r.address)}
              disabled={removing === r.address}
              className="shrink-0 rounded-md border border-refuse-500/40 px-2 py-1 text-[11px] text-refuse-500 transition-colors hover:bg-refuse-500/10 disabled:opacity-50"
            >
              {removing === r.address ? "…" : "Remove"}
            </button>
          </div>
        ))}
        {data?.limit && (
          <p className="text-[12px] text-mist-500">
            Allowance: <span className="text-mist-300">{formatLimit(data.limit)}</span>
            <UsdHint drops={BigInt(data.limit.cap)} usd={usd} />
            {data.limit.maxPerTx !== "0" && <> · max <span className="text-mist-300">{formatDrops(BigInt(data.limit.maxPerTx))}</span>/payment</>}
            {" · "}<span className={data.limit.allowlistOnly ? "text-mist-300" : "text-refuse-500"}>{data.limit.allowlistOnly ? "approved recipients only" : "any recipient — open to anyone"}</span>
          </p>
        )}
        {err && <p className="text-[12px] text-refuse-500">{err}</p>}
      </div>
    </Field>
  );
}

type DurationMode = "rolling" | "calendar" | "until";

function RateLimitConfig({ walletId }: { walletId: `0x${string}` }) {
  const { address: owner } = useKeyless();
  const [addr, setAddr] = useState("");
  const [cap, setCap] = useState("");
  const [perTx, setPerTx] = useState("");
  // Always true now — an allowance with no recipient list is payable by anyone. Kept as a named constant
  // rather than inlining `true` at the call site so the configure() argument still reads for itself.
  const allowlistOnly = true;
  const [mode, setMode] = useState<DurationMode>("rolling");
  const [count, setCount] = useState("1"); // rolling
  const [unit, setUnit] = useState("days"); // rolling
  const [calUnit, setCalUnit] = useState("month"); // calendar: day|week|month
  const [until, setUntil] = useState(""); // until: yyyy-mm-dd
  const [refreshKey, setRefreshKey] = useState(0);
  // What the CHAIN currently says, which for accounts saved before this can be false.
  const [savedOpen, setSavedOpen] = useState(false);
  useEffect(() => {
    let stop = false;
    readLimit(walletId)
      .then((l) => { if (!stop && l) setSavedOpen(!l.allowlistOnly); })
      .catch(() => { /* the warning just won't show */ });
    return () => { stop = true; };
  }, [walletId, refreshKey]);

  const { busy, msg, run } = useConfigAction();

  const allow = async () => {
    try {
      assertXrpl(addr);
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    const ok = await run(RULES.rateLimit as `0x${string}`, RULE_ABIS.rateLimit, "allow", [walletId, addr.trim()], "Added to the list.");
    if (ok) { setAddr(""); setRefreshKey((k) => k + 1); signalConfigChanged(); }
  };
  const setLimit = async () => {
    let drops: bigint;
    let perTxDrops: bigint;
    try {
      drops = xrpToDrops(cap);
      perTxDrops = perTx.trim() ? xrpToDrops(perTx) : 0n; // 0 = no per-payment cap
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }

    // mode -> (modeNum, param, human summary)
    let modeNum: number;
    let param: bigint;
    let summary: string;
    if (mode === "rolling") {
      const n = parseInt(count, 10);
      if (!Number.isInteger(n) || n < 1) return alert("Enter a whole number of units (e.g. every 2 weeks).");
      modeNum = 0;
      param = BigInt(n) * BigInt(UNITS.find((u) => u.label === unit)?.seconds ?? 86_400);
      summary = `${cap} XRP ${periodLabel(param.toString())}`;
    } else if (mode === "calendar") {
      modeNum = 1;
      param = BigInt(CAL_LABEL.indexOf(calUnit)); // day 0, week 1, month 2
      summary = `${cap} XRP per calendar ${calUnit}`;
    } else {
      modeNum = 2;
      if (!until) return alert("Pick a date for the budget to run until.");
      const ts = Math.floor(new Date(until).getTime() / 1000);
      if (!ts || ts <= Math.floor(Date.now() / 1000)) return alert("Pick a date in the future.");
      param = BigInt(ts);
      summary = `${cap} XRP total until ${new Date(until).toLocaleDateString(undefined, { timeZone: "UTC" })} (UTC)`;
    }

    const perTxNote = perTxDrops > 0n ? `, max ${perTx} XRP/payment` : "";
    const whoNote = allowlistOnly ? "to approved recipients" : "to anyone";
    const ok = await run(
      RULES.rateLimit as `0x${string}`, RULE_ABIS.rateLimit, "configure",
      [walletId, modeNum, drops, param, perTxDrops, allowlistOnly],
      `Limit set: ${summary}${perTxNote}, ${whoNote}.`,
    );
    if (ok) { setRefreshKey((k) => k + 1); signalConfigChanged(); }
  };

  const selectCls = "rounded-lg border hairline bg-ink-950 px-3 py-2.5 text-sm text-mist-100 outline-none focus:border-signal-500/60";

  // Live plain-English summary of what "Set limit" will apply — closes the amount/window disconnect.
  const preview = (() => {
    if (!cap.trim()) return null;
    let window: string;
    if (mode === "rolling") {
      const n = Math.max(1, parseInt(count, 10) || 1);
      window = n === 1 ? `per ${unit.slice(0, -1)}` : `every ${n} ${unit}`;
    } else if (mode === "calendar") {
      window = `per calendar ${calUnit}`;
    } else {
      window = until ? `total, until ${new Date(until).toLocaleDateString(undefined, { timeZone: "UTC" })} (UTC)` : "total, until a date you pick";
    }
    const who = allowlistOnly ? "to approved recipients" : "to anyone";
    const perTxNote = perTx.trim() ? `, max ${perTx} XRP per payment` : "";
    return `Up to ${cap} XRP ${window} ${who}${perTxNote}.`;
  })();

  return (
    <div className="space-y-4">
      <LimitStatus walletId={walletId} />

      {/* Two groups, labelled. A tester read these as one list and missed that the allowance applies to
          every payee, and that adding an address needs its own button. */}
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-mist-500">Approved recipients</p>

      {/* There used to be an "Anyone" option here. It could not be offered safely.
          `pay()` has no caller check — that's the design, the rule is the gate, not the caller — and a
          walletId is public in the WalletCreated event. So a limit with no recipient list pays its whole
          allowance to whoever asks first, every window, forever. The cap didn't bound the loss; it just
          set the drip rate. Every other rule pins the destination, which is what makes a permissionless
          pay() safe; this was the one that didn't. See SECURITY_NOTES.md. */}
      <Notice tone="info">
        <span className="font-medium">This account can only pay addresses you list.</span> The allowance
        limits how much, not where — and &ldquo;where&rdquo; is what actually protects you, because anyone
        can ask this account to pay. The rule is what refuses them.
      </Notice>

      {allowlistOnly && (
        <Field label="Add approved recipients" hint="It can only pay these — even within the allowance. Each one needs adding before you save.">
          <div className="flex gap-2">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="rDestination…" />
            <NameThisAddress owner={owner} address={addr} valid={isXrpl} className="w-36 shrink-0" />
            <Button onClick={allow} disabled={busy}>Add</Button>
          </div>
        </Field>
      )}

      {allowlistOnly && <SavedRecipients ruleKey="rateLimit" walletId={walletId} refreshKey={refreshKey} />}

      {/* Saved under the old "Anyone" setting, and still live on-chain. The owner is the only one who can
          fix it, so the app has to tell them plainly rather than quietly stop offering the option. */}
      {savedOpen && (
        <Notice tone="error">
          <span className="font-medium">This account can currently pay anyone.</span> It was saved with no
          recipient list, and because anyone can ask a Keyless account to pay, its allowance can be
          collected by a stranger — repeatedly, each window. Add the addresses it should be able to pay
          below and save; that closes it immediately. If you&rsquo;d rather not, move the XRP out first.
        </Notice>
      )}

      <p className="pt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-mist-500">Set spending rules</p>

      <Field label="How much can it spend?" hint="Per window for a rolling/calendar limit, or the total for an ‘until a date’ budget.">
        <div className="flex items-center gap-2">
          <NumberInput value={cap} onValueChange={setCap} decimal placeholder="10" className="w-28" />
          <span className="text-[13px] text-mist-500">XRP</span>
        </div>
      </Field>

      <Field label="Over what period?" hint="Rolling resets a fixed length after you set it; Calendar resets on real boundaries; Until a date is a one-time budget. Times are UTC.">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {([["rolling", "Rolling window"], ["calendar", "Calendar period"], ["until", "Until a date"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setMode(val)}
                className={`flex-1 rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                  mode === val ? "border-signal-500/60 bg-signal-500/5 text-mist-100" : "hairline bg-ink-900/60 text-mist-400 hover:text-mist-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "rolling" && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-mist-500">
              <span>the budget resets every</span>
              <NumberInput value={count} onValueChange={setCount} placeholder="1" className="w-16 text-center" />
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className={selectCls}>
                {UNITS.map((u) => <option key={u.label} value={u.label}>{Number(count) === 1 ? u.label.slice(0, -1) : u.label}</option>)}
              </select>
              <span>from when you set it.</span>
            </div>
          )}

          {mode === "calendar" && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-mist-500">
              <span>resets each</span>
              <select value={calUnit} onChange={(e) => setCalUnit(e.target.value)} className={selectCls}>
                {["day", "week", "month"].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <span>{calUnit === "month" ? "on the 1st" : calUnit === "week" ? "on Monday" : "at midnight"} (UTC).</span>
            </div>
          )}

          {mode === "until" && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-mist-500">
              <span>spend up to the amount until</span>
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className={`${selectCls} [color-scheme:dark]`}
              />
              <span>then it hard-stops at 00:00 UTC.</span>
            </div>
          )}
        </div>
      </Field>

      <Field label="Max per payment (optional)" hint="One cap on any single payment — it applies to every recipient, not to each one separately. On top of the allowance above. Leave blank for none.">
        <NumberInput value={perTx} onValueChange={setPerTx} decimal placeholder="no per-payment cap" className="w-48" />
      </Field>

      {preview && (
        <div className="rounded-lg border border-signal-500/30 bg-signal-500/5 px-4 py-3 text-[13px] text-mist-200">
          <span className="text-mist-400">This limit → </span>{preview}
        </div>
      )}

      <Button onClick={setLimit} disabled={busy}>{busy ? "Saving…" : "Save limit"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

// FSA XRPL provider wallet (Coston2) — every instruction is a payment here, carrying the reference.
const FSA_WALLET = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
const ASSET_MANAGER_FXRP = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA" as const;
const FASSETS_FEE_ABI = [
  { type: "function", name: "getDirectMintingFeeBIPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDirectMintingMinimumFeeUBA", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDirectMintingExecutorFeeUBA", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** What FAssets keeps from a mint: max(rate, floor) plus a flat fee to whoever completes it. */
function mintFeeDrops(xrpDrops: bigint, f: { bips: bigint; minUba: bigint; execUba: bigint }): bigint {
  const rate = (xrpDrops * f.bips) / 10_000n;
  return (rate > f.minUba ? rate : f.minUba) + f.execUba;
}
const FSA_TRIGGER = 100_000n; // 0.1 XRP dust to carry the instruction (the action's value rides in the reference)
const LOT_FXRP = 10; // FAssets redeems in whole lots; lotSize 1e7 AMG × granularity 1 = 1e7 UBA = 10 FXRP.

// Vault instruction ids are TYPE-based: Firelight 0x11/0x12/0x13, Upshift 0x21/0x22/0x23 —
// deposit / start-exit / claim.
const depositInstr = (vaultType: number) => (vaultType === 1 ? 0x11 : 0x21);
const exitInstr = (vaultType: number) => (vaultType === 1 ? 0x12 : 0x22);
const claimInstr = (vaultType: number) => (vaultType === 1 ? 0x13 : 0x23);

/** A withdrawal that has left a vault but isn't claimable yet. */
type PendingExit = { vaultId: bigint; vaultAddress: string; vaultType: number; period: bigint; assets: bigint; claimableAt: number };

/**
 * Find exits that are queued or ready, by reading the vault directly.
 *
 * A redeem files the claim under the period AFTER the one it happened in, and that period must end before
 * anything can be claimed — so the window worth scanning is small and fixed. No indexer, no stored state:
 * if the UI is opened on a different device it finds the same pending exits.
 */
async function readPendingExits(vaults: readonly VaultBalance[], pa: string): Promise<PendingExit[]> {
  const out: PendingExit[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    if (v.vaultType !== 1 || seen.has(v.vaultAddress)) continue; // Firelight only for now
    seen.add(v.vaultAddress);
    try {
      const addr = v.vaultAddress as `0x${string}`;
      const [cur, start, cfg] = await Promise.all([
        publicClient.readContract({ address: addr, abi: FIRELIGHT_VAULT_ABI, functionName: "currentPeriod" }),
        publicClient.readContract({ address: addr, abi: FIRELIGHT_VAULT_ABI, functionName: "currentPeriodStart" }),
        publicClient.readContract({ address: addr, abi: FIRELIGHT_VAULT_ABI, functionName: "currentPeriodConfiguration" }),
      ]);
      const duration = Number(cfg.duration);
      for (let p = cur - 2n; p <= cur + 1n; p++) {
        if (p < 0n) continue;
        const [assets, claimed] = await Promise.all([
          publicClient.readContract({ address: addr, abi: FIRELIGHT_VAULT_ABI, functionName: "withdrawalsOf", args: [p, pa as `0x${string}`] }),
          publicClient.readContract({ address: addr, abi: FIRELIGHT_VAULT_ABI, functionName: "isWithdrawClaimed", args: [p, pa as `0x${string}`] }),
        ]);
        if (assets > 0n && !claimed) {
          // Period p ends — and so becomes claimable — one duration after it begins.
          const claimableAt = Number(start) + (Number(p - cur) + 1) * duration;
          out.push({ vaultId: v.vaultId, vaultAddress: v.vaultAddress, vaultType: v.vaultType, period: p, assets, claimableAt });
        }
      }
    } catch { /* a vault that doesn't speak this interface simply contributes nothing */ }
  }
  return out;
}

/** One FXRP vault position from the FSA ReaderFacet. */
type VaultBalance = { vaultId: bigint; vaultAddress: string; vaultType: number; shares: bigint; assets: bigint };
type Portfolio = {
  natBalance: bigint;
  wNat: { token: string; balance: bigint };
  fXrp: { token: string; balance: bigint };
  vaults: readonly VaultBalance[];
};

/** Build the 32-byte FSA reference, mirroring FxrpRule / PaymentReferenceParser. */
const fsaRef = (id: number, value: bigint, vaultId: number): `0x${string}` =>
  toHex((BigInt(id) << 248n) | (value << 160n) | (BigInt(vaultId) << 128n), { size: 32 });

/**
 * What a field can actually spend, said before it's spent.
 *
 * Every amount input here draws on a balance the user can't be expected to hold in their head — XRP on the
 * ledger for a mint, liquid FXRP for a deposit, whole lots for a redemption. Validating on submit tells
 * people they were wrong after they've committed; this tells them while they type, and offers the largest
 * figure that would work.
 */
function AmountHint({
  available, unit, over, note, onMax,
}: { available: bigint | null; unit: string; over: boolean; note?: string; onMax: () => void }) {
  if (available === null) return null;
  return (
    <p className={`mt-1.5 text-[11px] ${over ? "text-refuse-500" : "text-mist-500"}`}>
      {over ? `That's more than this account has.` : <>You have <span className="text-mist-400">{fmtFxrp(available)} {unit}</span></>}
      {available > 0n && (
        <> · <button type="button" onClick={onMax} className="underline decoration-ink-600 underline-offset-2 hover:text-signal-400">use max</button></>
      )}
      {note && <> · {note}</>}
    </p>
  );
}

/** FXRP amount (6 decimals) as a short human string, e.g. 12500000n -> "12.5". */
const fmtFxrp = (uba: bigint): string => {
  const whole = uba / 1_000_000n;
  const frac = (uba % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/**
 * The unified FXRP panel: the whole XRP↔Flare round-trip in one policy. First mint XRP into FXRP — which
 * lands ONLY in this account's own Flare Smart Account (the rule computes that address on-chain, so nothing
 * to configure and nothing to hijack). Then put that FXRP to work in Flare vaults, withdraw, and bring it
 * home to XRPL. Each verb signs one XRPL payment; Flare's executor completes it. Sending FXRP to any other
 * address is blocked on-chain — even a stolen key can only move value inside your own account or bring it home.
 */
function FxrpConfig({ walletId }: { walletId: `0x${string}` }) {
  const { write, address } = useKeyless();
  const [pa, setPa] = useState<string | null>(null);
  const [coreVault, setCoreVault] = useState("");
  const [notReady, setNotReady] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [mintAmt, setMintAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // A submitted action's staged progress: Submitted → Proving on Flare → balance updated. The FDC round is
  // ~90s but the whole trip measured 129s (mint) and ~200s (vault deposit), so the tracker must not promise
  // a deadline it will blow through — a countdown that hits zero mid-wait reads as a failure.
  const [progress, setProgress] = useState<{ startedAt: number; done: boolean; label: string; expectSec: number; stalled?: boolean; tx?: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  // FAssets charges to mint: a BIPS rate with a floor, plus a flat fee to whoever completes it. Measured
  // 2026-08-07: 50 XRP in, 49.775 FXRP out. Read live so it stays true if Flare retunes it — a user who
  // deposits 50 and receives 49.775 with no explanation is being surprised by their own account.
  const [mintFee, setMintFee] = useState<{ bips: bigint; minUba: bigint; execUba: bigint } | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const [pendingExits, setPendingExits] = useState<PendingExit[]>([]);
  const [xrpBal, setXrpBal] = useState<bigint | null>(null); // XRPL side, for the mint field
  const usd = useXrpUsd(); // FXRP is 1:1 with XRP and shares its 6 decimals, so the XRP price converts both
  const [payees, setPayees] = useState<string[]>([]);
  const [payeeInput, setPayeeInput] = useState("");
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [home, setHome] = useState("");
  const [statusFor, setStatusFor] = useState<"mint" | "deposit" | "redeem" | null>(null); // which action the msg belongs to
  const [, setTick] = useState(0); // 1s heartbeat to re-render the countdown while a step is in flight
  const working = !!progress && !progress.done;

  // Whole FXRP portfolio, from one ReaderFacet.getBalances call.
  const liquid = portfolio ? portfolio.fXrp.balance : null;
  const vaultList = portfolio?.vaults ?? [];
  // What each field may actually spend. XRPL keeps ~1 XRP as an unspendable base reserve, so it is never
  // part of a mintable balance; redemption is in whole lots, so the max is the largest whole number of them.
  const XRPL_RESERVE = 1_000_000n;
  const mintable = xrpBal === null ? null : (xrpBal > XRPL_RESERVE ? xrpBal - XRPL_RESERVE : 0n);
  const redeemableLots = liquid === null ? null : liquid / BigInt(LOT_FXRP * 1e6);
  const parse = (v: string): bigint | null => { try { return xrpToDrops(v); } catch { return null; } };
  const mintWanted = parse(mintAmt);
  const depositWanted = parse(depositAmt);
  const homeWanted = parse(home);
  const mintOver = mintWanted !== null && mintable !== null && mintWanted > mintable;
  const depositOver = depositWanted !== null && liquid !== null && depositWanted > liquid;
  const homeOver = homeWanted !== null && liquid !== null && homeWanted > liquid;

  const positions = vaultList.filter((v) => v.assets > 0n);
  const inVaults = positions.reduce((s, v) => s + v.assets, 0n);
  const total = (liquid ?? 0n) + inVaults;

  const settleBaseline = useRef<bigint | null>(null); // liquid-FXRP snapshot when an action was submitted

  const readBalance = useCallback(async (account: string) => {
    try {
      const p = await publicClient.readContract({ address: ADDRESSES.fsaDiamond, abi: FSA_READER_ABI, functionName: "getBalances", args: [account as `0x${string}`] }) as Portfolio;
      setPortfolio(p);
      // The moment the liquid FXRP balance moves, the pending action has landed on-chain — mark it done.
      readPendingExits(p.vaults, account).then(setPendingExits).catch(() => { /* leave the last list up */ });
      if (settleBaseline.current !== null && p.fXrp.balance !== settleBaseline.current) {
        settleBaseline.current = null;
        setProgress((pr) => (pr ? { ...pr, done: true } : pr));
      }
    } catch { /* transient */ }
  }, []);

  /**
   * The XRPL-side balance, which is what the mint field spends (everything else here spends FXRP).
   *
   * This has to be re-read on a timer, not once on load. It was fetched a single time and then never
   * again: fund the account after opening the panel, or catch a flaky XRPL node that reports unfunded,
   * and `xrpBal` pinned at 0 for the life of the page — so every amount read as "more than this account
   * has" and Mint stayed disabled with no way back but a refresh. A balance the user can change from
   * outside the app is not a value you read once.
   *
   * An unreadable balance stays `null` rather than becoming 0. Null means "unknown", which shows no
   * maximum and blocks nothing; 0 means "definitely empty", which blocks everything. Collapsing the two
   * is what turned a slow node into a dead button.
   */
  const readXrpBalance = useCallback(async () => {
    try {
      const xaddr = await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI as never, functionName: "xrplAddressOf", args: [walletId] }) as string;
      if (!xaddr) return;
      const b = await getXrplBalance(xaddr);
      setXrpBal(b.funded ? b.drops : 0n);
    } catch { /* leave it unknown; the field just won't show a maximum */ }
  }, [walletId]);

  const load = useCallback(async () => {
    try {
      const cv = await publicClient.readContract({ address: RULES.fxrp as `0x${string}`, abi: RULE_ABIS.fxrp as never, functionName: "coreVaultAddress" }) as string;
      setCoreVault(cv);
    } catch { /* transient */ }
    try {
      const [bips, minUba, execUba] = await Promise.all([
        publicClient.readContract({ address: ASSET_MANAGER_FXRP, abi: FASSETS_FEE_ABI, functionName: "getDirectMintingFeeBIPS" }),
        publicClient.readContract({ address: ASSET_MANAGER_FXRP, abi: FASSETS_FEE_ABI, functionName: "getDirectMintingMinimumFeeUBA" }),
        publicClient.readContract({ address: ASSET_MANAGER_FXRP, abi: FASSETS_FEE_ABI, functionName: "getDirectMintingExecutorFeeUBA" }),
      ]) as [bigint, bigint, bigint];
      setMintFee({ bips, minUba, execUba });
    } catch { /* the estimate just doesn't render */ }
    await readXrpBalance();
    try {
      const res = await fetch("/api/rule-config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: "fxrp", walletId }), cache: "no-store",
      });
      const b = await res.json();
      if (Array.isArray(b.payees)) setPayees(b.payees);
    } catch { /* transient */ }
    try {
      const p = await publicClient.readContract({ address: RULES.fxrp as `0x${string}`, abi: RULE_ABIS.fxrp as never, functionName: "personalAccountOf", args: [walletId] }) as string;
      const acct = p && p !== ZERO_ADDRESS ? p : null;
      setPa(acct);
      setNotReady(false);
      if (acct) readBalance(acct);
    } catch {
      // personalAccountOf reverts until the enclave has reported this account's XRPL deposit address.
      setNotReady(true);
    }
  }, [walletId, readBalance]);
  useEffect(() => { load(); }, [load]);

  // The enclave provisions the XRPL address a few seconds after creation; until then personalAccountOf
  // reverts and `pa` is null (Mint disabled). Keep retrying until the Flare account resolves, so the button
  // enables on its own without the user needing to refresh the page.
  useEffect(() => {
    if (pa) return;
    const t = setInterval(() => { load(); }, 5000);
    return () => clearInterval(t);
  }, [pa, load]);

  // Keep the FXRP balance fresh the whole time the panel is open, so a mint/deposit/redeem shows up on its
  // own — a mint can take a minute or two to complete via the executor, and the user shouldn't have to
  // refresh to see it. Polls a little faster while an action is settling.
  useEffect(() => {
    if (!pa) return;
    const t = setInterval(() => {
      readBalance(pa);
      // The XRPL balance moves for the same reasons the FXRP one does — a mint spends it, a redemption
      // returns it — and it also moves when the user funds the account from another wallet mid-session.
      readXrpBalance();
    }, working ? 5000 : 15000);
    return () => clearInterval(t);
  }, [pa, working, readBalance, readXrpBalance]);

  // 1s heartbeat so the "~Ns left" countdown re-renders while an action is in flight.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);

  // Start a submitted action's staged progress. The balance poll marks it done the instant funds move;
  // the timeout is a safety cap (the FDC round + executor can take ~1–2 min).
  /**
   * Track an action until the liquid FXRP balance moves.
   *
   * `expectSec` is per action because they differ a lot — measured 2026-08-07: mint 129s, vault deposit
   * 198s, redeem home 112s. One shared 90s countdown expired mid-wait on all three.
   *
   * The give-up timer used to flip `done: true`, which claimed success at 180s — before a deposit has even
   * happened. A timer running out is not evidence the money moved; it now says so.
   */
  const settle = useCallback((label: string, expectSec: number, tx?: string) => {
    if (!pa) return;
    settleBaseline.current = liquid ?? 0n;
    setProgress({ startedAt: Date.now(), done: false, label, expectSec, tx });
    setTimeout(() => {
      setProgress((p) => (p && !p.done ? { ...p, stalled: true } : p));
    }, expectSec * 2000);
  }, [pa, liquid]);

  // Default the "put to work" vault to a Firelight vault (single-step withdraw) once the registry loads.
  useEffect(() => {
    if (selectedVaultId || vaultList.length === 0) return;
    const fire = vaultList.find((v) => v.vaultType === 1);
    setSelectedVaultId((fire ?? vaultList[0]).vaultId.toString());
  }, [vaultList, selectedVaultId]);

  // Mint = pay the Core Vault a memo crediting THIS account's own FSA personal account (the rule recomputes
  // it and rejects any other target). We build the exact same memo the rule expects.
  const mint = async () => {
    setMsg(null);
    setStatusFor("mint");
    if (!pa) return;
    let drops: bigint;
    try {
      drops = xrpToDrops(mintAmt);
    } catch (e) {
      return setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    }
    setBusy("Mint");
    try {
      // Guard: don't fire a mint the account can't cover — check the XRPL balance, keeping ~1 XRP for the
      // ledger reserve. If we can't read the balance, let it through rather than false-block.
      try {
        const xaddr = await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [walletId] }) as string;
        if (xaddr) {
          const xb = await getXrplBalance(xaddr);
          if (!xb.funded) { setBusy(null); return setMsg({ tone: "error", text: "This account has no XRP yet — send some to the deposit address first." }); }
          if (drops + 1_000_000n > xb.drops) { setBusy(null); return setMsg({ tone: "error", text: `This account holds ${fmtFxrp(xb.drops)} XRP. Mint a little less so ~1 XRP stays for the ledger reserve.` }); }
        }
      } catch { /* balance unreadable — proceed and let the chain be the backstop */ }
      const memo = fxrpMintMemo(pa as `0x${string}`);
      const hash = await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, coreVault, drops, memo], value: INIT_FEE });
      const sent = mintAmt;
      setMintAmt("");
      settle(`Minting ${sent} XRP → FXRP`, 140, hash);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  // value = FXRP amount in UBA (6 decimals). For redeem, FAssets works in whole lots of LOT_FXRP, so the
  // caller passes the lot count in `value` instead (see the redeem row).
  /**
   * `clear` empties the amount field once the instruction is away — mint already did this, these didn't.
   *
   * Leaving the amount in place meant a SUCCESSFUL deposit ended in red: the field still said 300, the
   * liquid balance had just dropped by 300, so the over-balance check fired and the panel reported "that's
   * more than the account has" about money it had correctly just moved.
   */
  const act = async (label: string, ref: `0x${string}`, friendly: string, expectSec: number, clear?: () => void) => {
    setBusy(label);
    setMsg(null);
    try {
      const hash = await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, FSA_WALLET, FSA_TRIGGER, ref], value: INIT_FEE });
      clear?.();
      settle(friendly, expectSec, hash);
    } catch (e) {
      let reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
      if (e instanceof BaseError) {
        const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
        if (rev instanceof ContractFunctionRevertedError) reason = (rev.data?.args?.[0] as string) ?? rev.shortMessage;
      }
      setMsg({ tone: "error", text: `Blocked: ${reason}` });
    } finally {
      setBusy(null);
    }
  };

  const uba = (fxrp: string) => BigInt(Math.round(Number(fxrp) * 1e6));
  // Every action is guarded against its real funding source — no firing a trigger + fee for something the
  // executor can't complete. Deposit/redeem draw from liquid FXRP; withdraw draws from that vault's position.
  const runDeposit = () => {
    setStatusFor("deposit");
    const amt = uba(depositAmt);
    if (!(amt > 0n)) return setMsg({ tone: "error", text: "Enter an amount of FXRP." });
    if (liquid !== null && amt > liquid) return setMsg({ tone: "error", text: `You only have ${fmtFxrp(liquid)} FXRP liquid to put to work.` });
    const v = vaultList.find((x) => x.vaultId.toString() === selectedVaultId);
    if (!v) return setMsg({ tone: "error", text: "Pick a vault to deposit into." });
    act("Deposit", fsaRef(depositInstr(v.vaultType), amt, Number(v.vaultId)), `Putting ${depositAmt} FXRP to work`, 210, () => setDepositAmt(""));
  };
  const runRedeem = () => {
    setStatusFor("redeem");
    const lots = Math.floor(Number(home) / LOT_FXRP);
    if (!(lots >= 1)) return setMsg({ tone: "error", text: `Bringing home works in lots of ${LOT_FXRP} FXRP — enter at least ${LOT_FXRP}.` });
    const need = BigInt(lots) * BigInt(LOT_FXRP) * 1_000_000n;
    if (liquid !== null && need > liquid) return setMsg({ tone: "error", text: `Bringing home ${lots * LOT_FXRP} FXRP needs more than your ${fmtFxrp(liquid)} FXRP liquid.` });
    act("Redeem", fsaRef(0x02, BigInt(lots), 0), `Bringing ${lots * LOT_FXRP} FXRP home`, 130, () => setHome(""));
  };

  const addPayee = async () => {
    try { assertXrpl(payeeInput); } catch (e) { return setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
    setBusy("Payee");
    try {
      await write({ address: RULES.fxrp as `0x${string}`, abi: RULE_ABIS.fxrp as never, functionName: "allowPayee", args: [walletId, payeeInput.trim()] });
      setPayeeInput("");
      setMsg({ tone: "ok", text: "Added. This account can now pay that address — and still nobody else." });
      load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally { setBusy(null); }
  };

  const dropPayee = async (r: string) => {
    setBusy("Payee");
    try {
      await write({ address: RULES.fxrp as `0x${string}`, abi: RULE_ABIS.fxrp as never, functionName: "removePayee", args: [walletId, r] });
      setMsg({ tone: "ok", text: "Removed. This account can no longer pay that address." });
      load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally { setBusy(null); }
  };

  /** Start leaving a vault. Burns the shares now; the FXRP is claimable after the next period ends. */
  const runExit = (v: VaultBalance) => {
    act("Exit", fsaRef(exitInstr(v.vaultType), v.assets, Number(v.vaultId)), `Taking ${fmtFxrp(v.assets)} FXRP out of vault ${v.vaultId}`, 210);
  };

  /** Collect a matured exit. The period number is what identifies which withdrawal to claim. */
  const runClaim = (e: PendingExit) => {
    act("Claim", fsaRef(claimInstr(e.vaultType), e.period, Number(e.vaultId)), `Collecting ${fmtFxrp(e.assets)} FXRP`, 210);
  };

  // A little staged tracker so the ~90s wait reads as progress, not a blank spinner. Shown INLINE under
  // whichever action was triggered, so it's visible where you clicked — no scrolling a long panel.
  const progressSteps = () => {
    if (!progress) return null;
    const elapsed = Math.floor((Date.now() - progress.startedAt) / 1000);
    const remaining = Math.max(0, progress.expectSec - elapsed);
    const done = progress.done;
    const icon = (state: "done" | "active" | "todo") =>
      state === "done" ? <span className="text-allow-500">✓</span>
      : state === "active" ? <span className="inline-block size-3 animate-spin rounded-full border-2 border-signal-500/30 border-t-signal-400 align-[-1px]" />
      : <span className="inline-block size-1.5 rounded-full bg-ink-600" />;
    const rows: [("done" | "active" | "todo"), string][] = [
      ["done", "Submitted"],
      [done ? "done" : "active",
        done ? "Proven on Flare"
        : progress.stalled ? "Still working — longer than usual, but nothing is lost"
        : remaining > 0 ? `Proving on Flare — about ${remaining}s left`
        : "Proving on Flare — nearly there…"],
      [done ? "done" : "todo", done ? "FXRP balance updated" : "FXRP balance updates"],
    ];
    return (
      <div className="mt-2 rounded-lg border hairline bg-ink-950/60 px-3 py-2.5">
        <p className="mb-1.5 text-[12px] font-medium text-mist-200">{progress.label}{done ? " ✓" : "…"}</p>
        {/* Measured: the FXRP moves in ONE transaction at the end — 10 out and 10 vault shares in, same
            second. So during the wait nothing has left, and saying so is both true and the reassuring
            thing. Without it, three minutes of an unchanged balance reads as a failed click. */}
        {progress.tx && (
          <a
            href={explorerTx(progress.tx)} target="_blank" rel="noreferrer"
            className="mb-2 inline-block font-mono text-[11px] text-signal-400 underline decoration-ink-600 underline-offset-4 hover:decoration-signal-500"
          >
            {addr(progress.tx)} ↗
          </a>
        )}
        {!done && (
          <p className="mb-2 text-[11px] leading-relaxed text-mist-500">
            Your balance won&rsquo;t change until this lands — the whole move happens in one transaction at
            the end. Nothing has left your account yet.
          </p>
        )}
        <div className="space-y-1.5">
          {rows.map(([state, label], i) => (
            <div key={i} className="flex items-center gap-2 text-[12px]">
              <span className="grid w-4 shrink-0 place-items-center">{icon(state)}</span>
              <span className={state === "todo" ? "text-mist-500" : "text-mist-300"}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Status shown INLINE right under whichever action was triggered.
  const actionStatus = (key: "mint" | "deposit" | "redeem") =>
    statusFor === key ? (
      <div className="mt-3 space-y-2">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {progressSteps()}
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <Notice tone="info">
        Mint XRP into FXRP, earn in Flare vaults, and bring it home — every step lands in your own account.
        Sending FXRP anywhere else is blocked.
      </Notice>

      {notReady ? (
        <Notice tone="info">
          Setting up your Flare account… it appears here automatically, no refresh needed.
        </Notice>
      ) : (
        <>
          {/* Portfolio header */}
          <div className="rounded-xl border border-signal-500/25 bg-gradient-to-b from-signal-500/[0.05] to-transparent p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[12px] text-mist-500">Your FXRP portfolio</p>
                <p className="mt-0.5 font-mono text-2xl text-mist-100">
                  {portfolio === null ? "…" : `${fmtFxrp(total)} FXRP`}
                  {portfolio !== null && <span className="ml-1 font-sans text-base text-mist-500"><UsdHint drops={total} usd={usd} /></span>}
                </p>
                {portfolio !== null && (
                  <p className="mt-0.5 text-[12px] text-mist-500">
                    <span className="text-mist-300">{fmtFxrp(liquid ?? 0n)}</span> liquid · <span className="text-mist-300">{fmtFxrp(inVaults)}</span> in vaults
                  </p>
                )}
              </div>
              {working && <span className="text-[12px] text-signal-400">⏳ updating…</span>}
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-mist-300">{pa ?? "…"}</code>
              {pa && <Copy text={pa} />}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
              This account&rsquo;s own Flare Smart Account — <span className="text-mist-400">not your control / gas key.</span>{" "}
              Computed on-chain from the enclave key, so nothing (not even a stolen key) can repoint where your FXRP goes. Flare covers its gas.
            </p>
          </div>

          {/* Said HERE, before step ①, because step ④ is where it would otherwise be discovered — after the
              money is already in. Approving an exit address isn't a formality: without one this account can
              cycle XRP and FXRP forever and never let anything out. Better to learn the shape of the round
              trip before minting than to find the last door locked at the end of it. */}
          {payees.length === 0 && (
            <Notice tone="info">
              <span className="font-medium">Decide where it&rsquo;s allowed to cash out.</span> Until you
              approve an address in step ④, this account can mint, earn and bring XRP home — but nothing can
              leave it. You can do it now or later; nothing can be cashed out until you do.
            </Notice>
          )}

          {/* ① Mint */}
          <div className="rounded-xl border hairline bg-ink-900/60 p-4">
            <p className="text-[14px] font-medium text-mist-100">① Mint FXRP</p>
            <p className="mt-0.5 text-[12px] text-mist-500">
              Turn XRP from this account into FXRP{coreVault ? <> (via the FAssets Core Vault <code className="font-mono text-mist-400">{addr(coreVault)}</code>)</> : null}. Lands in your Flare account above, about two minutes later.
            </p>
            {/* Say what arrives before they commit. FAssets keeps a cut, and finding that out afterwards —
                from a balance that's smaller than the number you typed — is the wrong way to learn it. */}
            {mintFee && (() => {
              let drops: bigint;
              try { drops = xrpToDrops(mintAmt); } catch { return null; }
              const fee = mintFeeDrops(drops, mintFee);
              if (fee >= drops) return <p className="mt-2 text-[12px] text-warn-500">That&rsquo;s below the minting fee ({fmtFxrp(fee)} FXRP) — you&rsquo;d receive nothing.</p>;
              return (
                <p className="mt-2 text-[12px] text-mist-500">
                  You&rsquo;ll receive about <span className="text-mist-300">{fmtFxrp(drops - fee)} FXRP</span> — FAssets keeps{" "}
                  {fmtFxrp(fee)} ({Number(mintFee.bips) / 100}% plus a {fmtFxrp(mintFee.execUba)} completion fee).
                </p>
              );
            })()}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <NumberInput value={mintAmt} onValueChange={setMintAmt} decimal placeholder="20" className="w-28" />
              <span className="text-[13px] text-mist-500">XRP</span>
              <Button onClick={mint} disabled={!pa || !!busy || mintOver}>{busy === "Mint" ? "Minting…" : "Mint FXRP"}</Button>
            </div>
            <AmountHint
              available={mintable} unit="XRP" over={mintOver}
              note="1 XRP stays as the ledger reserve"
              onMax={() => setMintAmt(String(Number(mintable ?? 0n) / 1e6))}
            />
            {actionStatus("mint")}
          </div>

          {/* ② Put to work — vault selector */}
          <div className="rounded-xl border hairline bg-ink-900/60 p-4">
            <p className="text-[14px] font-medium text-mist-100">② 🌱 Put FXRP to work</p>
            <p className="mt-0.5 text-[12px] text-mist-500">
              Deposit liquid FXRP into a Flare yield vault to earn — <span className="text-mist-400">Firelight and Upshift are yield protocols on Flare; the number is which vault.</span> You have <span className="text-mist-300">{fmtFxrp(liquid ?? 0n)} FXRP</span> available. Takes about three minutes to show in the vault.{" "}
              <span className="text-mist-400">Note: pulling it back out is a two-step claim we&rsquo;re still finishing.</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={selectedVaultId}
                onChange={(e) => setSelectedVaultId(e.target.value)}
                className="rounded-lg border hairline bg-ink-950 px-3 py-2.5 text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60"
              >
                {vaultList.length === 0 && <option value="">…</option>}
                {vaultList.map((v) => (
                  <option key={v.vaultId.toString()} value={v.vaultId.toString()}>
                    {VAULT_TYPE_NAME[v.vaultType] ?? "Vault"} yield vault #{v.vaultId.toString()}
                  </option>
                ))}
              </select>
              <NumberInput value={depositAmt} onValueChange={setDepositAmt} decimal placeholder="0" className="w-24" />
              <span className="text-[12px] text-mist-500">FXRP</span>
              <Button variant="ghost" onClick={runDeposit} disabled={!!busy || depositOver}>{busy === "Deposit" ? "…" : "Put to work"}</Button>
            </div>
            <AmountHint
              available={liquid} unit="FXRP" over={depositOver}
              onMax={() => setDepositAmt(String(Number(liquid ?? 0n) / 1e6))}
            />
            {actionStatus("deposit")}
          </div>

          {/* Borrow — coming soon. FXRP is the umbrella for putting your XRP to work on Flare; yield is live,
              lending (and more DeFi) come next, each kept undrainable. */}
          <div className="rounded-xl border hairline bg-ink-900/40 p-4 opacity-80">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[14px] font-medium text-mist-100">🏛️ Borrow against your FXRP</p>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200/90">Soon</span>
            </div>
            <p className="mt-0.5 text-[12px] text-mist-500">
              Unlock cash from your FXRP as collateral — and a stolen key still can&rsquo;t take it. More ways to put
              your XRP to work on Flare are coming, each kept undrainable.
            </p>
          </div>

          {/* Positions (view-only for now — see the note) */}
          {(positions.length > 0 || pendingExits.length > 0) && (
            <div className="rounded-xl border hairline bg-ink-900/60 p-4">
              <p className="text-[14px] font-medium text-mist-100">Your positions</p>
              <div className="mt-3 space-y-2">
                {positions.map((v) => {
                  const key = v.vaultId.toString();
                  const canExit = v.vaultType === 1; // Firelight; Upshift's exit path isn't verified yet
                  return (
                    <div key={key} className="flex flex-wrap items-center justify-between gap-2 border-t hairline pt-2 first:border-t-0 first:pt-0">
                      <div className="min-w-0">
                        <p className="text-[13px] text-mist-200">{VAULT_TYPE_NAME[v.vaultType] ?? "Vault"} yield vault <span className="text-mist-500">#{key}</span></p>
                        {/* Shares are what the vault owes you; value is what they're worth right now. Showing
                            both makes the mechanism visible — the share count holds still while the value
                            moves, which is the thing "earning" was asserting without ever evidencing. */}
                        <p className="mt-0.5 text-[11px] text-mist-500">{fmtFxrp(v.shares)} shares</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <p className="text-right text-[12px]">
                          <span className="font-mono text-allow-500">{fmtFxrp(v.assets)} FXRP</span>
                          <span className="text-mist-500"><UsdHint drops={v.assets} usd={usd} /></span>
                          <span className="block text-[10px] text-mist-500">worth now</span>
                        </p>
                        {canExit && (
                          <Button variant="ghost" onClick={() => runExit(v)} disabled={!!busy}>{busy === "Exit" ? "…" : "Take it out"}</Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Said plainly, because the alternative is implying a number we don't have. The app never
                  recorded what you deposited — the amount lives in the XRPL payment reference, which
                  PaymentAuthorized doesn't emit — so there is no basis to subtract and no honest "you have
                  earned X" to show. What IS true is that this figure comes from the vault, not from us. */}
              <p className="mt-3 border-t hairline pt-2 text-[11px] leading-relaxed text-mist-500">
                Value is read live from the vault and rises as it accrues — Firelight settles each period,
                so it steps up rather than ticking. Keyless doesn&rsquo;t record what you put in, so it
                can&rsquo;t tell you your gain; the vault&rsquo;s own page can.
              </p>

              {/* Exits that have left the vault but aren't collectable yet. Read straight from the vault,
                  so this survives a refresh, a different device, and us not being here. */}
              {pendingExits.length > 0 && (
                <div className="mt-4 space-y-2 border-t hairline pt-3">
                  <p className="text-[12px] font-medium text-mist-200">On its way out</p>
                  {pendingExits.map((e) => {
                    const ready = Date.now() / 1000 >= e.claimableAt;
                    return (
                      <div key={`${e.vaultId}-${e.period}`} className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[12px] text-mist-400">
                          <span className="font-mono text-mist-200">{fmtFxrp(e.assets)} FXRP</span>{" "}
                          {ready ? "is ready to collect" : <>unlocks {new Date(e.claimableAt * 1000).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}</>}
                        </p>
                        <Button variant="ghost" onClick={() => runClaim(e)} disabled={!ready || !!busy}>
                          {busy === "Claim" ? "…" : ready ? "Collect" : "Locked"}
                        </Button>
                      </div>
                    );
                  })}
                  <p className="text-[11px] leading-relaxed text-mist-500">
                    Leaving a vault takes two steps: your shares are given up straight away, and the FXRP
                    becomes collectable once the vault&rsquo;s next period ends. Nothing is lost in between —
                    it just can&rsquo;t be moved yet.
                  </p>
                </div>
              )}

              {positions.some((v) => v.vaultType !== 1) && (
                <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
                  Upshift vaults use a different exit path we haven&rsquo;t verified end to end, so
                  &ldquo;take it out&rdquo; is only offered on Firelight for now.
                </p>
              )}
            </div>
          )}

          {/* ③ Bring home */}
          <div className="rounded-xl border hairline bg-ink-900/60 p-4">
            <p className="text-[14px] font-medium text-mist-100">③ 🏠 Bring home to XRPL</p>
            <p className="mt-0.5 text-[12px] text-mist-500">
              Redeem liquid FXRP back to XRP on this account (in lots of {LOT_FXRP} FXRP). Arrives in about two
              minutes, minus a redemption fee — measured at roughly 0.5%, so {LOT_FXRP * 2} FXRP came home as 19.9 XRP.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <NumberInput value={home} onValueChange={setHome} decimal placeholder={String(LOT_FXRP)} className="w-24" />
              <span className="text-[12px] text-mist-500">FXRP</span>
              <Button variant="ghost" onClick={runRedeem} disabled={!!busy || homeOver || (redeemableLots !== null && redeemableLots === 0n)}>{busy === "Redeem" ? "…" : "Bring home"}</Button>
            </div>
            <AmountHint
              available={liquid} unit="FXRP" over={homeOver}
              note={redeemableLots !== null
                ? (redeemableLots === 0n ? `not enough for one ${LOT_FXRP} FXRP lot yet` : `${redeemableLots} lot${redeemableLots === 1n ? "" : "s"} available`)
                : undefined}
              onMax={() => setHome(String(Number(redeemableLots ?? 0n) * LOT_FXRP))}
            />
            {actionStatus("redeem")}
          </div>

          {/* ④ Cash out — the step whose absence made this policy one-way */}
          <div className="rounded-xl border hairline bg-ink-900/60 p-4">
            <p className="text-[14px] font-medium text-mist-100">④ 💸 Where it can cash out</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-mist-500">
              XRP you&rsquo;ve brought home can be sent to addresses you approve here — an exchange, your own
              wallet — and to nobody else. <span className="text-mist-400">FXRP itself still can&rsquo;t be
              transferred to anyone; bring it home first, which this account can prove it did.</span>
            </p>
            {/* The address field gets its own row until there's room for one. `flex-1` alone let it
                shrink to a sliver on a phone — the nickname box and the button hold their widths, so
                everything left over went to the field you actually have to read 30-odd characters in. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input value={payeeInput} onChange={(e) => setPayeeInput(e.target.value)} placeholder="rExchangeDeposit…" className="min-w-0 basis-full sm:basis-auto sm:flex-1" />
              <NameThisAddress owner={address} address={payeeInput} valid={isXrpl} className="w-36 shrink-0" />
              {/* Approving costs gas and a wallet round-trip, so an address that can't be valid should
                  never get that far. addPayee still asserts — this only stops the trip being wasted. */}
              <Button onClick={addPayee} disabled={!!busy || !isXrpl(payeeInput)}>{busy === "Payee" ? "…" : "Approve"}</Button>
            </div>
            {payeeInput.trim() !== "" && !isXrpl(payeeInput) && (
              <p className="mt-1.5 text-[11px] text-refuse-500">
                That doesn&rsquo;t look like an XRPL address — they start with <code className="font-mono">r</code> and are 25–35 characters.
              </p>
            )}
            {payees.length > 0 && (
              <div className="mt-3 space-y-2">
                {payees.map((r) => (
                  <div key={r} className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
                    <AddressLabel owner={address ?? null} address={r} className="flex-1" />
                    <Copy text={r} />
                    <button
                      type="button" onClick={() => dropPayee(r)} disabled={!!busy}
                      className="shrink-0 rounded-md border border-refuse-500/40 px-2 py-1 text-[11px] text-refuse-500 transition-colors hover:bg-refuse-500/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {payees.length === 0 && (
              <p className="mt-2 text-[11px] text-mist-500">
                Nothing approved yet, so nothing can leave this account except back into XRP.
              </p>
            )}
          </div>
        </>
      )}

      {/* Errors that aren't tied to a specific action (e.g. before setup) still surface here. */}
      {statusFor === null && msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

/**
 * Conditional: the account can't pay until something in the real world is proven true. The user picks a
 * condition template and fills in one value; the request that decides it is pinned on-chain, and Flare's
 * Data Connector is what flips the gate. A live readout shows what the world says *right now* (free — the
 * verifier previews the exact answer it would attest), so the wait is legible rather than mysterious.
 */
function ConditionalConfig({ walletId }: { walletId: `0x${string}` }) {
  const [recipient, setRecipient] = useState("");
  const [cap, setCap] = useState("");
  const [kind, setKind] = useState<ConditionKey>("xrpPrice");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [live, setLive] = useState<{ ok: boolean; error?: string } | null>(null);
  const [deadline, setDeadline] = useState(""); // yyyy-mm-dd; blank = waits forever (expires 23:59:59 UTC)
  const [fallback, setFallback] = useState("");
  const [checking, setChecking] = useState(false);
  const [onchain, setOnchain] = useState<{ maxAmount: bigint; released: boolean; active: boolean } | null>(null);
  const [saved, setSaved] = useState<{ condition?: string; recipient?: string; request?: Record<string, string>; provenTx?: string; provenRound?: string } | null>(null);
  // Tagged with the request it was read for, so a reading can never be shown against a condition it
  // wasn't taken from (e.g. right after the condition is replaced).
  const [savedLive, setSavedLive] = useState<{ key: string; ok: boolean } | null>(null);
  const { address: condOwner } = useKeyless();
  const { busy, msg, run } = useConfigAction();
  const tpl = CONDITION_TEMPLATES[kind];

  const load = useCallback(async () => {
    try {
      const c = await publicClient.readContract({ address: RULES.escrow as `0x${string}`, abi: RULE_ABIS.escrow as never, functionName: "conditionOf", args: [walletId] }) as readonly [string, bigint, string, string, bigint, string, bigint, boolean, boolean];
      // Tuple order: recipient, maxAmount, requestHash, expectedHash, deadline, fallbackRecipient,
      // spent, released, active. (Reading the pre-deadline indices here rendered `spent` as "active",
      // which leaked a stray "0" into the panel.)
      setOnchain({ maxAmount: c[1], released: c[7], active: c[8] });
    } catch { /* transient */ }
    // The chain holds hashes, not words. The words (and the pinned request we keep re-checking) come from
    // the configure event, which carries both in full.
    try {
      const res = await fetch("/api/rule-config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: "escrow", walletId }),
      });
      const b = await res.json();
      setSaved(b.escrow ? { condition: b.escrow.condition, recipient: b.escrow.recipient, request: b.escrow.request, provenTx: b.escrow.provenTx, provenRound: b.escrow.provenRound } : null);
    } catch { /* transient */ }
  }, [walletId]);
  useEffect(() => { load(); }, [load]);

  // Keep asking the world about the *saved* condition, not just the one being composed. Otherwise a live
  // account can only say "waiting" — it can't tell you whether it's waiting on the weather or on Flare,
  // which is the difference between "nothing is happening" and "your payout is seconds away".
  useEffect(() => {
    const req = saved?.request;
    if (!req || !onchain?.active || onchain.released) return;
    const key = JSON.stringify(req);
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/condition", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req }),
        });
        const b = await res.json();
        if (!stop && res.ok) setSavedLive({ key, ok: !!b.ok });
      } catch { /* leave the last reading up */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [saved?.request, onchain?.active, onchain?.released]);

  // The release happens off-screen — a watcher proves the condition a minute or two later — so poll while
  // we're still waiting. Without this the panel sits on "Waiting on proof" forever and the user has to
  // refresh to discover the payout unlocked, which is the whole moment.
  useEffect(() => {
    if (!onchain?.active || onchain.released) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [onchain?.active, onchain?.released, load]);

  // Ask the verifier what it would attest for the condition being composed — free, and the same
  // fetch + transform the real attestation runs, so it's a faithful preview and not a guess.
  const check = useCallback(async (v: Record<string, string>) => {
    const res = await fetch("/api/condition", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: tpl.build(v) }),
    });
    const b = await res.json();
    return res.ok ? { ok: !!b.ok } : { ok: false, error: b.error ?? "couldn't reach that API" };
  }, [tpl]);

  // Check as they type (debounced) so the readout is just *there* — nobody should have to know to press
  // a button to avoid locking funds against a condition that can never resolve.
  // Seed any select with its first option, so "complete" doesn't wait on a control nobody touched.
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const f of tpl.fields) if (f.kind === "select" && !vals[f.key]) seed[f.key] = f.options?.[0]?.value ?? "";
    if (Object.keys(seed).length) setVals((m) => ({ ...seed, ...m }));
  }, [tpl, vals]);

  const complete = tpl.fields.every((f) => (vals[f.key] ?? "").trim());

  useEffect(() => {
    if (!complete) { setLive(null); return; }
    setChecking(true);
    const t = setTimeout(async () => {
      try { setLive(await check(vals)); }
      catch (e) { setLive({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
      finally { setChecking(false); }
    }, 700);
    return () => { clearTimeout(t); setChecking(false); };
  }, [vals, complete, check]);

  const configure = async () => {
    let drops: bigint;
    try {
      assertXrpl(recipient);
      drops = xrpToDrops(cap);
      if (!complete) throw new Error("fill in every part of the condition");
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    // A deadline needs somewhere for the money to go, or expiry would strand the account.
    let deadlineTs = 0n;
    if (deadline) {
      const ts = Math.floor(new Date(`${deadline}T23:59:59Z`).getTime() / 1000);
      if (!ts || ts <= Math.floor(Date.now() / 1000)) return alert("Pick a deadline in the future.");
      deadlineTs = BigInt(ts);
      try { assertXrpl(fallback); } catch { return alert("Add the address to return the funds to if the condition never happens."); }
    }
    // Never let someone lock funds against a condition that can't be read — that would strand the account
    // with no way to ever unlock it. A condition that's merely *false* is fine: that's the whole point.
    try {
      const v = await check(vals);
      if (v.error) {
        setLive(v);
        return alert(`That condition can't be read: ${v.error}\n\nCheck the details — saving it would lock this account against something that can never be proven.`);
      }
      setLive(v);
    } catch {
      return alert("Couldn't verify that condition just now. Try again in a moment.");
    }
    const ok = await run(
      RULES.escrow as `0x${string}`, RULE_ABIS.escrow, "configure",
      [walletId, recipient.trim(), drops, tpl.build(vals), EXPECTED_TRUE, deadlineTs, deadlineTs === 0n ? "" : fallback.trim()],
      `Set. This account can't pay until ${tpl.describe(vals)} — proven on-chain by Flare.`,
    );
    if (ok) { load(); signalConfigChanged(); }
  };

  return (
    <div className="space-y-4">
      {onchain?.active && (
        <Notice tone={onchain.released ? "ok" : "info"}>
          {onchain.released ? (
            <div className="space-y-1.5">
              <div><span className="font-medium">Proven ✓</span> — the condition was met and attested on-chain. This account can now pay its payee, up to {formatDrops(onchain.maxAmount)}.</div>
              {saved?.provenTx && (
                <div className="text-[12px] text-mist-400">
                  Attested in Flare voting round <span className="font-mono text-mist-300">{saved.provenRound}</span> —{" "}
                  <a href={explorerTx(saved.provenTx)} target="_blank" rel="noreferrer" className="font-mono text-signal-400 underline decoration-ink-600 underline-offset-4 hover:decoration-signal-500">
                    {addr(saved.provenTx)} ↗
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <span className="flex items-center gap-2">
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-signal-500/30 border-t-signal-400" />
                <span><span className="font-medium">Locked until it&rsquo;s proven.</span> This account can&rsquo;t pay anyone — not the payee, not you — until Flare attests the condition.</span>
              </span>
              {saved?.recipient && (
                <div className="text-[12px] text-mist-400">
                  Pays <AddressLabel owner={condOwner} address={saved.recipient} inline />
                </div>
              )}
              {saved?.condition && (
                <div className="space-y-1 border-l border-white/10 pl-3 text-[13px] text-mist-400">
                  <div>Watching <span className="text-mist-200">{saved.condition}</span></div>
                  {/* Two very different silences look identical without this: waiting on the world, and
                      waiting on Flare. Say which one it is. */}
                  <div>
                    Right now:{" "}
                    {savedLive?.key !== JSON.stringify(saved.request) ? <span className="text-mist-500">checking…</span>
                      : savedLive.ok ? <span className="text-signal-300">that&rsquo;s true — Flare is attesting it, usually a couple of minutes</span>
                      : <span className="text-mist-300">not true yet — nothing can move until it is</span>}
                  </div>
                </div>
              )}
            </div>
          )}
        </Notice>
      )}

      <Field label="Pay who?">
        <div className="flex gap-2">
          <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="rSupplier…" />
          <NameThisAddress owner={condOwner} address={recipient} valid={isXrpl} className="w-40 shrink-0" />
        </div>
      </Field>
      <Field label="Up to how much?">
        <div className="flex items-center gap-2">
          <NumberInput value={cap} onValueChange={setCap} decimal placeholder="100" className="w-28" />
          <span className="text-[13px] text-mist-500">XRP</span>
        </div>
      </Field>

      <Field label="Only pay once this is true" hint="Flare's Data Connector checks this live API and proves the answer on-chain. Nothing can pay before it does.">
        <div className="flex flex-wrap gap-2">
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as ConditionKey); setVals({}); setLive(null); }}
            className="rounded-lg border hairline bg-ink-950 px-3 py-2.5 text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60"
          >
            {(Object.keys(CONDITION_TEMPLATES) as ConditionKey[]).map((k) => (
              <option key={k} value={k}>{CONDITION_TEMPLATES[k].name}</option>
            ))}
          </select>

          {/* One labelled control per value the template needs, rather than asking someone to encode
              everything into a single cryptic string. */}
          {tpl.fields.map((f) => {
            const w = f.width === "lg" ? "w-52" : f.width === "md" ? "w-44" : "w-24";
            const set = (x: string) => setVals((m) => ({ ...m, [f.key]: x }));
            return (
              <span key={f.key} className="flex items-center gap-1.5">
                {f.kind === "select" ? (
                  <select
                    value={vals[f.key] ?? f.options?.[0]?.value ?? ""}
                    onChange={(e) => set(e.target.value)}
                    className={`${w} rounded-lg border hairline bg-ink-950 px-3 py-2.5 text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60`}
                  >
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <Input
                    value={vals[f.key] ?? ""}
                    onChange={(e) => set(e.target.value)}
                    placeholder={f.placeholder}
                    inputMode={f.kind === "number" ? "decimal" : undefined}
                    className={w}
                  />
                )}
                {f.label && <span className="text-[12px] text-mist-500">{f.label}</span>}
              </span>
            );
          })}
        </div>
      </Field>

      {(checking || live) && (
        <Notice tone={checking ? "info" : live?.error ? "warn" : live?.ok ? "ok" : "info"}>
          {checking ? "Checking that condition…"
            : live?.error ? <><span className="font-medium">That condition can&rsquo;t be read</span> — {live.error}. Fix it before saving, or the account would be locked against something that can never be proven.</>
            : live?.ok ? <>Right now that&rsquo;s <span className="font-medium">true</span> — save it and the account unlocks within a couple of minutes.</>
            : <>Right now that&rsquo;s <span className="font-medium">not true yet</span> — which is fine. Save it and the account stays locked, then unlocks by itself the moment it becomes true.</>}
        </Notice>
      )}

      <Field
        label="And if it never happens?"
        hint="Optional. Without a deadline this account waits forever — and since it may pay nobody but the payee, a condition that never comes true would leave the funds stuck."
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="rounded-lg border hairline bg-ink-950 px-3 py-2.5 font-mono text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60"
          />
          {deadline && (
            <>
              <span className="text-[12px] text-mist-500">then release the funds back to</span>
              <Input value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="your own r-address" className="w-56" />
              <NameThisAddress owner={condOwner} address={fallback} valid={isXrpl} className="w-36" />
            </>
          )}
        </div>
      </Field>

      <Button onClick={configure} disabled={busy}>{busy ? "…" : "Save"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
