"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { useKeyless } from "./KeylessProvider";
import { Button, Field, Input, NumberInput, Notice, Copy } from "./ui";
import { publicClient } from "@/lib/clients";
import { getXrplBalance } from "@/lib/xrpl";
import { ADDRESSES, ACCOUNTS_ABI, CONDITION_TEMPLATES, EXPECTED_TRUE, FSA_READER_ABI, INIT_FEE, RULES, RULE_ABIS, VAULT_TYPE_NAME, XRPL_ADDRESS_RE, ZERO_ADDRESS, addr, formatDrops, scheduleEnd, type ConditionKey, type RuleKey } from "@/lib/keyless";

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

function ScheduledConfig({ walletId }: { walletId: `0x${string}` }) {
  const [lines, setLines] = useState<ScheduleLine[]>([
    { recipient: "", amount: "", unit: 2, offsetDays: 0, runs: "", startAt: "" },
  ]);
  const [saved, setSaved] = useState<SavedLine[] | null>(null);
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
              <span className="font-medium">Next payment {fmtDate(next.dueAt)}</span> — {formatDrops(next.totalDrops)}<UsdHint drops={next.totalDrops} usd={usd} />
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
              </span>
              <span className="shrink-0 text-[11px] text-mist-500">
                next {fmtDate(l.nextDue)}
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
                <Input value={l.recipient} onChange={(e) => set(i, { recipient: e.target.value })} placeholder="rAlice…" />
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

                <Field label="Start from" hint="Leave blank to start with the next one">
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
                  {fmtDate(Math.floor(firstDue(l.unit, l.offsetDays, l.startAt).getTime() / 1000))}
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
  const { write } = useKeyless();
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
        <Field label="Already allowed" hint="Remove any to stop this account from paying it.">
          <div className="space-y-2">
            {saved.map((r) => (
              <div key={r.address} className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-mist-200">{r.address}</code>
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
 * "Currently approved" — the live on-chain allowlist for a rule, read back so a refresh (or another
 * device) shows what's saved, with a Remove button per recipient. Used by the multi-recipient rules
 * (allowlist, rateLimit); Exchange has its own richer version with destination tags. `refreshKey` is
 * bumped by the parent after a save so this re-reads once the explorer indexes the change.
 */
function SavedRecipients({ ruleKey, walletId, refreshKey }: { ruleKey: RuleKey; walletId: `0x${string}`; refreshKey: number }) {
  const usd = useXrpUsd();
  const { write } = useKeyless();
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
    <Field label="Already allowed" hint="Remove any to stop this account from paying it.">
      <div className="space-y-2">
        {recipients.map((r) => (
          <div key={r.address} className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-mist-200">{r.address}</code>
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
            {" · "}<span className="text-mist-300">{data.limit.allowlistOnly ? "approved recipients only" : "any recipient"}</span>
          </p>
        )}
        {err && <p className="text-[12px] text-refuse-500">{err}</p>}
      </div>
    </Field>
  );
}

type DurationMode = "rolling" | "calendar" | "until";

function RateLimitConfig({ walletId }: { walletId: `0x${string}` }) {
  const [addr, setAddr] = useState("");
  const [cap, setCap] = useState("");
  const [perTx, setPerTx] = useState("");
  const [allowlistOnly, setAllowlistOnly] = useState(true);
  const [mode, setMode] = useState<DurationMode>("rolling");
  const [count, setCount] = useState("1"); // rolling
  const [unit, setUnit] = useState("days"); // rolling
  const [calUnit, setCalUnit] = useState("month"); // calendar: day|week|month
  const [until, setUntil] = useState(""); // until: yyyy-mm-dd
  const [refreshKey, setRefreshKey] = useState(0);
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
      <SavedRecipients ruleKey="rateLimit" walletId={walletId} refreshKey={refreshKey} />

      <Field label="Who can it pay?" hint="A named list, or anyone — either way it&rsquo;s capped by the allowance below.">
        <div className="flex gap-2">
          {([[true, "Approved recipients only"], [false, "Anyone"]] as const).map(([val, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setAllowlistOnly(val)}
              className={`flex-1 rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                allowlistOnly === val ? "border-signal-500/60 bg-signal-500/5 text-mist-100" : "hairline bg-ink-900/60 text-mist-400 hover:text-mist-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>

      {allowlistOnly && (
        <Field label="Who's on the list?" hint="It can only pay these — even within the allowance.">
          <div className="flex gap-2">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="rDestination…" />
            <Button variant="ghost" onClick={allow} disabled={busy}>Add</Button>
          </div>
        </Field>
      )}

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

      <Field label="Max per payment (optional)" hint="Also cap each single payment, on top of the budget. Leave blank for no per-payment cap.">
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

// Vault deposit instruction id is TYPE-based (VaultType 1=Firelight, 2=Upshift). Withdrawing back out is a
// two-step redeem→claim whose claim params (period/date) aren't readable on-chain and aren't returned to the
// frontend (async execution) — verified live: a redeem parks FXRP in a pending state with no auto-claim — so
// vault withdrawal isn't wired here yet; positions are view-only.
const depositInstr = (vaultType: number) => (vaultType === 1 ? 0x11 : 0x21);

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
  const { write } = useKeyless();
  const [pa, setPa] = useState<string | null>(null);
  const [coreVault, setCoreVault] = useState("");
  const [notReady, setNotReady] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [mintAmt, setMintAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // A submitted action's staged progress: Submitted → Proving on Flare → balance updated. The FDC round is
  // ~90s but the whole trip measured 129s (mint) and ~200s (vault deposit), so the tracker must not promise
  // a deadline it will blow through — a countdown that hits zero mid-wait reads as a failure.
  const [progress, setProgress] = useState<{ startedAt: number; done: boolean; label: string; expectSec: number; stalled?: boolean } | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  // FAssets charges to mint: a BIPS rate with a floor, plus a flat fee to whoever completes it. Measured
  // 2026-08-07: 50 XRP in, 49.775 FXRP out. Read live so it stays true if Flare retunes it — a user who
  // deposits 50 and receives 49.775 with no explanation is being surprised by their own account.
  const [mintFee, setMintFee] = useState<{ bips: bigint; minUba: bigint; execUba: bigint } | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [home, setHome] = useState("");
  const [statusFor, setStatusFor] = useState<"mint" | "deposit" | "redeem" | null>(null); // which action the msg belongs to
  const [, setTick] = useState(0); // 1s heartbeat to re-render the countdown while a step is in flight
  const working = !!progress && !progress.done;

  // Whole FXRP portfolio, from one ReaderFacet.getBalances call.
  const liquid = portfolio ? portfolio.fXrp.balance : null;
  const vaultList = portfolio?.vaults ?? [];
  const positions = vaultList.filter((v) => v.assets > 0n);
  const inVaults = positions.reduce((s, v) => s + v.assets, 0n);
  const total = (liquid ?? 0n) + inVaults;

  const settleBaseline = useRef<bigint | null>(null); // liquid-FXRP snapshot when an action was submitted

  const readBalance = useCallback(async (account: string) => {
    try {
      const p = await publicClient.readContract({ address: ADDRESSES.fsaDiamond, abi: FSA_READER_ABI, functionName: "getBalances", args: [account as `0x${string}`] }) as Portfolio;
      setPortfolio(p);
      // The moment the liquid FXRP balance moves, the pending action has landed on-chain — mark it done.
      if (settleBaseline.current !== null && p.fXrp.balance !== settleBaseline.current) {
        settleBaseline.current = null;
        setProgress((pr) => (pr ? { ...pr, done: true } : pr));
      }
    } catch { /* transient */ }
  }, []);

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
    const t = setInterval(() => readBalance(pa), working ? 5000 : 15000);
    return () => clearInterval(t);
  }, [pa, working, readBalance]);

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
  const settle = useCallback((label: string, expectSec: number) => {
    if (!pa) return;
    settleBaseline.current = liquid ?? 0n;
    setProgress({ startedAt: Date.now(), done: false, label, expectSec });
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
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, coreVault, drops, memo], value: INIT_FEE });
      const sent = mintAmt;
      setMintAmt("");
      settle(`Minting ${sent} XRP → FXRP`, 140);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  // value = FXRP amount in UBA (6 decimals). For redeem, FAssets works in whole lots of LOT_FXRP, so the
  // caller passes the lot count in `value` instead (see the redeem row).
  const act = async (label: string, ref: `0x${string}`, friendly: string, expectSec: number) => {
    setBusy(label);
    setMsg(null);
    try {
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, FSA_WALLET, FSA_TRIGGER, ref], value: INIT_FEE });
      settle(friendly, expectSec);
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
    act("Deposit", fsaRef(depositInstr(v.vaultType), amt, Number(v.vaultId)), `Putting ${depositAmt} FXRP to work`, 210);
  };
  const runRedeem = () => {
    setStatusFor("redeem");
    const lots = Math.floor(Number(home) / LOT_FXRP);
    if (!(lots >= 1)) return setMsg({ tone: "error", text: `Bringing home works in lots of ${LOT_FXRP} FXRP — enter at least ${LOT_FXRP}.` });
    const need = BigInt(lots) * BigInt(LOT_FXRP) * 1_000_000n;
    if (liquid !== null && need > liquid) return setMsg({ tone: "error", text: `Bringing home ${lots * LOT_FXRP} FXRP needs more than your ${fmtFxrp(liquid)} FXRP liquid.` });
    act("Redeem", fsaRef(0x02, BigInt(lots), 0), `Bringing ${lots * LOT_FXRP} FXRP home`, 130);
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
                <p className="mt-0.5 font-mono text-2xl text-mist-100">{portfolio === null ? "…" : `${fmtFxrp(total)} FXRP`}</p>
                {portfolio !== null && (
                  <p className="mt-0.5 text-[12px] text-mist-500">
                    <span className="text-mist-300">{fmtFxrp(liquid ?? 0n)}</span> liquid · <span className="text-mist-300">{fmtFxrp(inVaults)}</span> earning in vaults
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
              <Button onClick={mint} disabled={!pa || !!busy}>{busy === "Mint" ? "Minting…" : "Mint FXRP"}</Button>
            </div>
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
              <NumberInput value={depositAmt} onValueChange={setDepositAmt} decimal placeholder="0" className="w-24 text-right" />
              <span className="text-[12px] text-mist-500">FXRP</span>
              <Button variant="ghost" onClick={runDeposit} disabled={!!busy}>{busy === "Deposit" ? "…" : "Put to work"}</Button>
            </div>
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
          {positions.length > 0 && (
            <div className="rounded-xl border hairline bg-ink-900/60 p-4">
              <p className="text-[14px] font-medium text-mist-100">Your positions</p>
              <div className="mt-3 space-y-2">
                {positions.map((v) => {
                  const key = v.vaultId.toString();
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 border-t hairline pt-2 first:border-t-0 first:pt-0">
                      <p className="text-[13px] text-mist-200">{VAULT_TYPE_NAME[v.vaultType] ?? "Vault"} yield vault <span className="text-mist-500">#{key}</span></p>
                      <p className="text-[12px]"><span className="font-mono text-allow-500">{fmtFxrp(v.assets)} FXRP</span> <span className="text-mist-500">earning</span></p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
                Pulling FXRP back out of a vault is a two-step claim (redeem → claim after the vault&rsquo;s unlock).
                We&rsquo;re finishing that flow, so withdrawals aren&rsquo;t in the UI yet — your <span className="text-mist-400">liquid</span> FXRP can be brought home any time below.
              </p>
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
              <NumberInput value={home} onValueChange={setHome} decimal placeholder={String(LOT_FXRP)} className="w-24 text-right" />
              <span className="text-[12px] text-mist-500">FXRP</span>
              <Button variant="ghost" onClick={runRedeem} disabled={!!busy}>{busy === "Redeem" ? "…" : "Bring home"}</Button>
            </div>
            {actionStatus("redeem")}
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
  const [deadline, setDeadline] = useState(""); // yyyy-mm-dd; blank = waits forever
  const [fallback, setFallback] = useState("");
  const [checking, setChecking] = useState(false);
  const [onchain, setOnchain] = useState<{ maxAmount: bigint; released: boolean; active: boolean } | null>(null);
  const [saved, setSaved] = useState<{ condition?: string; recipient?: string; request?: Record<string, string> } | null>(null);
  // Tagged with the request it was read for, so a reading can never be shown against a condition it
  // wasn't taken from (e.g. right after the condition is replaced).
  const [savedLive, setSavedLive] = useState<{ key: string; ok: boolean } | null>(null);
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
      setSaved(b.escrow ? { condition: b.escrow.condition, recipient: b.escrow.recipient, request: b.escrow.request } : null);
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
            <><span className="font-medium">Proven ✓</span> — the condition was met and attested on-chain. This account can now pay its payee, up to {formatDrops(onchain.maxAmount)}.</>
          ) : (
            <div className="space-y-2">
              <span className="flex items-center gap-2">
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-signal-500/30 border-t-signal-400" />
                <span><span className="font-medium">Locked until it&rsquo;s proven.</span> This account can&rsquo;t pay anyone — not the payee, not you — until Flare attests the condition.</span>
              </span>
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

      <Field label="Pay who?"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="rSupplier…" /></Field>
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
            </>
          )}
        </div>
      </Field>

      <Button onClick={configure} disabled={busy}>{busy ? "…" : "Save"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
