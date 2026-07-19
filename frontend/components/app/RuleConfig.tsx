"use client";

import { useState } from "react";
import { keccak256, toBytes } from "viem";
import { useKeyless } from "./KeylessProvider";
import { Button, Field, Input, Notice } from "./ui";
import { RULES, RULE_ABIS, XRPL_ADDRESS_RE, type RuleKey } from "@/lib/keyless";

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
  if (ruleKey === "allowlist") return <AllowlistConfig walletId={walletId} />;
  if (ruleKey === "rateLimit") return <RateLimitConfig walletId={walletId} />;
  if (ruleKey === "subscription") return <SubscriptionConfig walletId={walletId} />;
  return <EscrowConfig walletId={walletId} />;
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
    try {
      assertXrpl(addr);
    } catch (e) {
      return alert(e instanceof Error ? e.message : String(e));
    }
    const ok = await run(RULES.allowlist as `0x${string}`, RULE_ABIS.allowlist, "allow", [walletId, addr.trim()], "Address allowlisted. The account can now pay it — and nowhere else.");
    if (ok) setAddr("");
  };
  return (
    <div className="space-y-4">
      <Field label="Allow a recipient" hint="The account may only ever pay addresses on this list.">
        <div className="flex gap-2">
          <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="rExchangeDeposit…" />
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
          <Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="10" inputMode="decimal" />
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
          <Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="9.99" inputMode="decimal" />
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
      <Notice tone="info">Conditional payouts ship with the next deploy — this is a preview of the setup.</Notice>
      <Field label="Payee"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="rSupplier…" /></Field>
      <Field label="Cap"><Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="100" inputMode="decimal" /></Field>
      <Field label="Release condition" hint="Hashed on-chain. Unlocks when Flare's Data Connector attests it.">
        <Input value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="delivery == true" />
      </Field>
      <Button onClick={configure} disabled={busy}>{busy ? "…" : "Set escrow"}</Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
