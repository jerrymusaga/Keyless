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

const WINDOWS: Record<string, bigint> = { "per day": 86_400n, "per week": 604_800n, "per 30 days": 2_592_000n };

/** Rule-specific configuration. Every call here is onlyWalletOwner on-chain — signed by the control key. */
export function RuleConfig({ walletId, ruleKey }: { walletId: `0x${string}`; ruleKey: RuleKey }) {
  if (ruleKey === "exchange") return <ExchangeConfig walletId={walletId} />;
  if (ruleKey === "allowlist") return <AllowlistConfig walletId={walletId} />;
  if (ruleKey === "rateLimit") return <RateLimitConfig walletId={walletId} />;
  if (ruleKey === "subscription") return <SubscriptionConfig walletId={walletId} />;
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
        fetch("/api/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletId }),
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

function AllowlistConfig({ walletId }: { walletId: `0x${string}` }) {
  const [addr, setAddr] = useState("");
  const { busy, msg, run } = useConfigAction();
  const add = async () => {
    const list = addr.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return alert("Enter at least one XRPL r-address.");
    const bad = list.find((a) => !XRPL_ADDRESS_RE.test(a));
    if (bad) return alert(`Not a valid XRPL r-address: ${bad}`);
    const ok =
      list.length === 1
        ? await run(RULES.allowlist as `0x${string}`, RULE_ABIS.allowlist, "allow", [walletId, list[0]], "Address allowlisted. The account can now pay it — and nowhere else.")
        : await run(RULES.allowlist as `0x${string}`, RULE_ABIS.allowlist, "allowMany", [walletId, list], `${list.length} addresses allowlisted in one transaction.`);
    if (ok) setAddr("");
  };
  return (
    <div className="space-y-4">
      <Field
        label="Allow recipients"
        hint="The account may only ever pay addresses on this list. Paste several — one per line or comma-separated — to add them in a single transaction."
      >
        <textarea
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          rows={3}
          placeholder={"rExchangeDeposit…\nrAnotherDeposit…"}
          className="w-full rounded-lg border hairline bg-ink-950 px-3.5 py-2.5 font-mono text-sm text-mist-100 outline-none transition-colors placeholder:text-mist-500 focus:border-signal-500/60"
        />
        <div className="mt-2">
          <Button onClick={add} disabled={busy}>{busy ? "…" : "Allow"}</Button>
        </div>
      </Field>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function RateLimitConfig({ walletId }: { walletId: `0x${string}` }) {
  const [addr, setAddr] = useState("");
  const [cap, setCap] = useState("");
  const [window, setWindow] = useState("per day");
  const { busy, msg, run } = useConfigAction();

  const allow = async () => {
    try {
      assertXrpl(addr);
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    const ok = await run(RULES.rateLimit as `0x${string}`, RULE_ABIS.rateLimit, "allow", [walletId, addr.trim()], "Recipient allowlisted.");
    if (ok) setAddr("");
  };
  const setLimit = async () => {
    let drops: bigint;
    try {
      drops = xrpToDrops(cap);
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    await run(RULES.rateLimit as `0x${string}`, RULE_ABIS.rateLimit, "configure", [walletId, drops, WINDOWS[window]], `Allowance set: ${cap} XRP ${window}.`);
  };
  return (
    <div className="space-y-4">
      <Field label="Allowlist the agent's recipients" hint="Even within the allowance, it can only pay these.">
        <div className="flex gap-2">
          <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="rDestination…" />
          <Button variant="ghost" onClick={allow} disabled={busy}>Allow</Button>
        </div>
      </Field>
      <Field label="Spending allowance" hint="The most it can spend per window. It can never exceed this, however it's hijacked.">
        <div className="flex gap-2">
          <NumberInput value={cap} onValueChange={setCap} decimal placeholder="10" />
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            className="rounded-lg border hairline bg-ink-950 px-3 text-sm text-mist-100 outline-none focus:border-signal-500/60"
          >
            {Object.keys(WINDOWS).map((w) => <option key={w}>{w}</option>)}
          </select>
          <Button onClick={setLimit} disabled={busy}>{busy ? "…" : "Set"}</Button>
        </div>
      </Field>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function SubscriptionConfig({ walletId }: { walletId: `0x${string}` }) {
  const [merchant, setMerchant] = useState("");
  const [cap, setCap] = useState("");
  const [period, setPeriod] = useState("per 30 days");
  const { busy, msg, run } = useConfigAction();

  const configure = async () => {
    let drops: bigint;
    try {
      assertXrpl(merchant);
      drops = xrpToDrops(cap);
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    await run(RULES.subscription as `0x${string}`, RULE_ABIS.subscription, "configure", [walletId, merchant.trim(), drops, WINDOWS[period]], `Subscription set: up to ${cap} XRP ${period} to that merchant. Cancel anytime.`);
  };
  const cancel = () => run(RULES.subscription as `0x${string}`, RULE_ABIS.subscription, "cancel", [walletId], "Subscription cancelled. The merchant can pull nothing further.");
  return (
    <div className="space-y-4">
      <Field label="Merchant address"><Input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="rMerchant…" /></Field>
      <Field label="Cap per period" hint="The merchant can pull up to this — never more, never elsewhere.">
        <div className="flex gap-2">
          <NumberInput value={cap} onValueChange={setCap} decimal placeholder="9.99" />
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-lg border hairline bg-ink-950 px-3 text-sm text-mist-100 outline-none focus:border-signal-500/60">
            {Object.keys(WINDOWS).map((w) => <option key={w}>{w}</option>)}
          </select>
        </div>
      </Field>
      <div className="flex gap-2">
        <Button onClick={configure} disabled={busy}>{busy ? "…" : "Set subscription"}</Button>
        <Button variant="danger" onClick={cancel} disabled={busy}>Cancel subscription</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function EscrowConfig({ walletId }: { walletId: `0x${string}` }) {
  const [recipient, setRecipient] = useState("");
  const [cap, setCap] = useState("");
  const [condition, setCondition] = useState("");
  const { busy, msg, run } = useConfigAction();
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
    await run(RULES.escrow as `0x${string}`, RULE_ABIS.escrow, "configure", [walletId, recipient.trim(), drops, conditionHash], "Escrow set. Funds unlock only once the condition is FDC-attested.");
  };
  return (
    <div className="space-y-4">
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
