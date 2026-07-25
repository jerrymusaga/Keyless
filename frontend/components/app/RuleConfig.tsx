"use client";

import { useState, useEffect, useCallback } from "react";
import { keccak256, toBytes } from "viem";
import { useKeyless } from "./KeylessProvider";
import { Button, Field, Input, NumberInput, Notice, Copy } from "./ui";
import { publicClient } from "@/lib/clients";
import { RULES, RULE_ABIS, XRPL_ADDRESS_RE, addr, formatDrops, type RuleKey } from "@/lib/keyless";

const XRP = 1_000_000n;
function xrpToDrops(s: string): bigint {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error("enter an amount in XRP");
  return BigInt(Math.round(n * 1e6));
}
function assertXrpl(a: string) {
  if (!XRPL_ADDRESS_RE.test(a.trim())) throw new Error("that isn't a valid XRPL r-address");
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
  return <EscrowConfig walletId={walletId} />;
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
        <Field label="Currently approved" hint="Live on-chain — the only addresses this account can pay. Remove any to revoke it.">
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
        label="Add recipients"
        hint="This account can only ever pay these addresses. Add a destination tag for a centralized-exchange deposit; leave it blank for a normal address (a friend, your own wallet)."
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

      <Field label="Max per transaction (optional)" hint="Cap the size of any single payment. Leave blank for no limit.">
        <NumberInput value={maxTx} onValueChange={setMaxTx} decimal placeholder="no limit" />
      </Field>

      <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save policy"}</Button>
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

type Limit = { mode: number; cap: string; param: string; maxPerTx: string; allowlistOnly: boolean };
type RuleConfigResponse = {
  recipients?: SavedRecipient[];
  capDrops?: string;
  limit?: Limit;
};

const CAL_LABEL = ["day", "week", "month"]; // calendar unit index -> label
/** Human summary of a spending limit, per its duration mode. */
function formatLimit(l: Limit): string {
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
    <Field label="Currently approved" hint="Live on-chain — the only addresses this account can pay. Remove any to revoke it.">
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
    const ok = await run(RULES.rateLimit as `0x${string}`, RULE_ABIS.rateLimit, "allow", [walletId, addr.trim()], "Recipient allowlisted.");
    if (ok) { setAddr(""); setRefreshKey((k) => k + 1); }
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
    if (ok) setRefreshKey((k) => k + 1);
  };

  const selectCls = "rounded-lg border hairline bg-ink-950 px-3 py-2.5 text-sm text-mist-100 outline-none focus:border-signal-500/60";
  return (
    <div className="space-y-4">
      <SavedRecipients ruleKey="rateLimit" walletId={walletId} refreshKey={refreshKey} />

      <Field label="Who can it pay?" hint="Approved-only bounds it to a list you name; Anyone lets it pay any address — still capped by the allowance below.">
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
        <Field label="Approved recipients" hint="It can only pay these — even within the allowance.">
          <div className="flex gap-2">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="rDestination…" />
            <Button variant="ghost" onClick={allow} disabled={busy}>Allow</Button>
          </div>
        </Field>
      )}

      <Field label="Amount" hint="The cap — per window for a rolling/calendar limit, or the total for an ‘until a date’ budget.">
        <div className="flex items-center gap-2">
          <NumberInput value={cap} onValueChange={setCap} decimal placeholder="10" className="w-28" />
          <span className="text-[13px] text-mist-500">XRP</span>
        </div>
      </Field>

      <Field label="How is the limit measured?" hint="Rolling resets a fixed length after you set it; Calendar resets on real boundaries; Until a date is a one-time budget that hard-stops. Resets and dates use UTC (on-chain time), not your local timezone.">
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
              <span>every</span>
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

      <Button onClick={setLimit} disabled={busy}>{busy ? "Saving…" : "Set limit"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function EscrowConfig({ walletId }: { walletId: `0x${string}` }) {
  const [recipient, setRecipient] = useState("");
  const [cap, setCap] = useState("");
  const [condition, setCondition] = useState("");
  const [escrow, setEscrow] = useState<{ recipient: string; maxAmount: string; conditionHash: string; released: boolean } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { busy, msg, run } = useConfigAction();

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/rule-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: "escrow", walletId }), cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!stop) setEscrow(body.escrow ?? null);
      } catch { /* keep last */ }
    };
    load();
    const t = refreshKey > 0 ? setTimeout(load, 4500) : undefined;
    return () => { stop = true; if (t) clearTimeout(t); };
  }, [walletId, refreshKey]);

  const configure = async () => {
    let drops: bigint;
    try {
      assertXrpl(recipient);
      drops = xrpToDrops(cap);
      if (!condition.trim()) throw new Error("describe the release condition");
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    const conditionHash = keccak256(toBytes(condition.trim()));
    const ok = await run(RULES.escrow as `0x${string}`, RULE_ABIS.escrow, "configure", [walletId, recipient.trim(), drops, conditionHash], "Escrow set. Funds unlock only once the condition is FDC-attested.");
    if (ok) { setRecipient(""); setCap(""); setCondition(""); setRefreshKey((k) => k + 1); }
  };
  return (
    <div className="space-y-4">
      {escrow && (
        <Notice tone="ok">
          Escrow set: up to <span className="text-mist-100">{formatDrops(BigInt(escrow.maxAmount))}</span> to{" "}
          <span className="font-mono text-mist-200">{addr(escrow.recipient)}</span> —{" "}
          {escrow.released ? "condition proven, released ✓" : "locked until the condition is FDC-attested"}.
        </Notice>
      )}
      <Notice tone="info">
        Set the payee, cap, and condition here. Funds stay locked until someone submits a Flare Data
        Connector proof of the condition (proof submission is an advanced step, done outside this form).
      </Notice>
      <Field label="Payee"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="rSupplier…" /></Field>
      <Field label="Cap"><NumberInput value={cap} onValueChange={setCap} decimal placeholder="100" /></Field>
      <Field label="Release condition" hint="Hashed on-chain. Unlocks when Flare's Data Connector attests it.">
        <Input value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="delivery == true" />
      </Field>
      <Button onClick={configure} disabled={busy}>{busy ? "…" : "Set escrow"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
