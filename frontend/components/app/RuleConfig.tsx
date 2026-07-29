"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { keccak256, toBytes, toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { useKeyless } from "./KeylessProvider";
import { Button, Field, Input, NumberInput, Notice, Copy } from "./ui";
import { publicClient } from "@/lib/clients";
import { getXrplBalance } from "@/lib/xrpl";
import { ADDRESSES, ACCOUNTS_ABI, FSA_READER_ABI, INIT_FEE, RULES, RULE_ABIS, VAULT_TYPE_NAME, XRPL_ADDRESS_RE, ZERO_ADDRESS, addr, formatDrops, type RuleKey } from "@/lib/keyless";

/** The exact FAssets direct-minting memo (0x4642505266410018 · 0000 · recipient) — mirrors FxrpMintRule.mintMemo. */
const fxrpMintMemo = (flareAddr: `0x${string}`) => `0x464250526641001800000000${flareAddr.slice(2)}` as `0x${string}`;

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
  if (ruleKey === "fxrp") return <FxrpConfig walletId={walletId} />;
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

      <Button onClick={setLimit} disabled={busy}>{busy ? "Saving…" : "Set limit"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

// FSA XRPL provider wallet (Coston2) — every instruction is a payment here, carrying the reference.
const FSA_WALLET = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
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
  const [settling, setSettling] = useState(false); // an executor is completing a submitted action off-chain
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [home, setHome] = useState("");

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
      // The moment the liquid FXRP balance moves, the pending action has landed on-chain — stop "settling".
      if (settleBaseline.current !== null && p.fXrp.balance !== settleBaseline.current) {
        settleBaseline.current = null;
        setSettling(false);
      }
    } catch { /* transient */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const cv = await publicClient.readContract({ address: RULES.fxrp as `0x${string}`, abi: RULE_ABIS.fxrp as never, functionName: "coreVaultAddress" }) as string;
      setCoreVault(cv);
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
    const t = setInterval(() => readBalance(pa), settling ? 6000 : 15000);
    return () => clearInterval(t);
  }, [pa, settling, readBalance]);

  // Flag that we're waiting for a submitted action to land. The poll above clears it the instant the
  // balance moves; the timeout is just a safety cap (mint via the FDC executor can take ~1–2 min).
  const settle = useCallback(() => {
    if (!pa) return;
    settleBaseline.current = liquid ?? 0n;
    setSettling(true);
    setTimeout(() => { settleBaseline.current = null; setSettling(false); }, 180_000);
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
      setMsg({ tone: "ok", text: `Sent ${sent} XRP to mint FXRP. It lands in your Flare account (shown above) in ~1–2 min — the balance updates on its own, no refresh needed.` });
      settle();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  // value = FXRP amount in UBA (6 decimals). For redeem, FAssets works in whole lots of LOT_FXRP, so the
  // caller passes the lot count in `value` instead (see the redeem row).
  const act = async (label: string, ref: `0x${string}`) => {
    setBusy(label);
    setMsg(null);
    try {
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, FSA_WALLET, FSA_TRIGGER, ref], value: INIT_FEE });
      setMsg({ tone: "info", text: `${label} submitted — Flare's executor completes it on-chain in a moment.` });
      settle();
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
    const amt = uba(depositAmt);
    if (!(amt > 0n)) return setMsg({ tone: "error", text: "Enter an amount of FXRP." });
    if (liquid !== null && amt > liquid) return setMsg({ tone: "error", text: `You only have ${fmtFxrp(liquid)} FXRP liquid to put to work.` });
    const v = vaultList.find((x) => x.vaultId.toString() === selectedVaultId);
    if (!v) return setMsg({ tone: "error", text: "Pick a vault to deposit into." });
    act("Deposit", fsaRef(depositInstr(v.vaultType), amt, Number(v.vaultId)));
  };
  const runRedeem = () => {
    const lots = Math.floor(Number(home) / LOT_FXRP);
    if (!(lots >= 1)) return setMsg({ tone: "error", text: `Bringing home works in lots of ${LOT_FXRP} FXRP — enter at least ${LOT_FXRP}.` });
    const need = BigInt(lots) * BigInt(LOT_FXRP) * 1_000_000n;
    if (liquid !== null && need > liquid) return setMsg({ tone: "error", text: `Bringing home ${lots * LOT_FXRP} FXRP needs more than your ${fmtFxrp(liquid)} FXRP liquid.` });
    act("Redeem", fsaRef(0x02, BigInt(lots), 0));
  };

  return (
    <div className="space-y-4">
      <Notice tone="info">
        The full round-trip, locked to your own account. Mint XRP into FXRP, put it to work in Flare vaults,
        and bring it home — every step lands in this account&rsquo;s own Flare account. Sending FXRP to anyone
        else is blocked on-chain.
      </Notice>

      {notReady ? (
        <Notice tone="info">
          Setting up your Flare account… it appears here automatically a few seconds after the account is
          created. No need to refresh.
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
              {settling && <span className="text-[12px] text-signal-400">⏳ updating (up to ~2 min)…</span>}
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
              Turn XRP from this account into FXRP{coreVault ? <> (via the FAssets Core Vault <code className="font-mono text-mist-400">{addr(coreVault)}</code>)</> : null}. Lands in your Flare account above, ~1–2 min later.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <NumberInput value={mintAmt} onValueChange={setMintAmt} decimal placeholder="20" className="w-28" />
              <span className="text-[13px] text-mist-500">XRP</span>
              <Button onClick={mint} disabled={!pa || !!busy}>{busy === "Mint" ? "Minting…" : "Mint FXRP"}</Button>
            </div>
          </div>

          {/* ② Put to work — vault selector */}
          <div className="rounded-xl border hairline bg-ink-900/60 p-4">
            <p className="text-[14px] font-medium text-mist-100">② 🌱 Put FXRP to work</p>
            <p className="mt-0.5 text-[12px] text-mist-500">
              Deposit liquid FXRP into a Flare yield vault to earn — <span className="text-mist-400">Firelight and Upshift are yield protocols on Flare; the number is which vault.</span> You have <span className="text-mist-300">{fmtFxrp(liquid ?? 0n)} FXRP</span> available.{" "}
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
            <p className="mt-0.5 text-[12px] text-mist-500">Redeem liquid FXRP back to XRP on this account (in lots of {LOT_FXRP} FXRP).</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <NumberInput value={home} onValueChange={setHome} decimal placeholder={String(LOT_FXRP)} className="w-24 text-right" />
              <span className="text-[12px] text-mist-500">FXRP</span>
              <Button variant="ghost" onClick={runRedeem} disabled={!!busy}>{busy === "Redeem" ? "…" : "Bring home"}</Button>
            </div>
          </div>
        </>
      )}

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
