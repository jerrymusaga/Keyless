"use client";

import { use, useCallback, useEffect, useState } from "react";
import { toHex } from "viem";
import { useKeyless } from "@/components/app/KeylessProvider";
import { RuleConfig } from "@/components/app/RuleConfig";
import { Button, Card, Field, Input, Notice, Spinner } from "@/components/app/ui";
import { publicClient } from "@/lib/clients";
import { getAccount } from "@/lib/accounts";
import { getXrplBalance, getRecentPayments, type XrplTx } from "@/lib/xrpl";
import {
  ADDRESSES,
  ACCOUNTS_ABI,
  RULES,
  RULE_META,
  ZERO_ADDRESS,
  XRPL_ADDRESS_RE,
  addr,
  explorerAddress,
  xrplAccount,
  formatDrops,
  type RuleKey,
} from "@/lib/keyless";

function ruleKeyOf(rule: string): RuleKey | null {
  return (Object.keys(RULES) as RuleKey[]).find((k) => RULES[k].toLowerCase() === rule.toLowerCase()) ?? null;
}

export default function AccountDashboard({ params }: { params: Promise<{ walletId: string }> }) {
  const { walletId } = use(params);
  const wid = walletId as `0x${string}`;
  const { status, address } = useKeyless();

  const [owner, setOwner] = useState<string | null>(null);
  const [rule, setRule] = useState<`0x${string}` | null>(null);
  const [xrpl, setXrpl] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const readChain = useCallback(async () => {
    const [o, r, x] = await Promise.all([
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "ownerOf", args: [wid] }) as Promise<string>,
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "ruleOf", args: [wid] }) as Promise<`0x${string}`>,
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [wid] }) as Promise<string>,
    ]);
    setOwner(o);
    setRule(r);
    setXrpl(x);
    setLoading(false);
  }, [wid]);

  useEffect(() => {
    readChain();
  }, [readChain]);

  // Poll for XRPL address provisioning until it lands on-chain.
  useEffect(() => {
    if (loading || xrpl) return;
    let stop = false;
    const tick = async () => {
      await fetch("/api/provision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletId: wid }) }).catch(() => {});
      const x = (await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [wid] })) as string;
      if (!stop && x) setXrpl(x);
    };
    const t = setInterval(tick, 6000);
    tick();
    return () => { stop = true; clearInterval(t); };
  }, [loading, xrpl, wid]);

  if (status !== "ready") return <Notice tone="info">Open this from <a className="underline" href="/app">your accounts</a>.</Notice>;
  if (loading) return <Spinner label="Reading the account from Coston2…" />;
  if (owner === ZERO_ADDRESS) return <Notice tone="error">No such account.</Notice>;
  if (address && owner && owner.toLowerCase() !== address.toLowerCase()) {
    return <Notice tone="warn">This account is controlled by a different key than the one in this browser.</Notice>;
  }

  const local = address ? getAccount(address, wid) : undefined;
  const rk = rule ? ruleKeyOf(rule) : null;
  const hasRule = rule && rule !== ZERO_ADDRESS;

  return (
    <div className="space-y-6">
      <div>
        <a href="/app" className="text-xs text-mist-500 hover:text-mist-300">← Your accounts</a>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-medium tracking-[-0.02em] text-mist-100">{local?.label ?? "Account"}</h1>
          {hasRule && rk && (
            <span className="rounded-full border border-signal-500/30 bg-signal-500/10 px-2.5 py-0.5 text-[11px] text-signal-300">
              {RULE_META[rk].name}
            </span>
          )}
        </div>
      </div>

      <ReceivePanel xrpl={xrpl} />

      {hasRule && rk ? (
        <>
          <Card>
            <h2 className="text-[15px] font-medium text-mist-100">Rule — {RULE_META[rk].name}</h2>
            <p className="mt-1 text-[13px] text-mist-400">{RULE_META[rk].tagline}</p>
            <p className="mt-1 text-xs text-signal-300/80">Protects against: {RULE_META[rk].protects}</p>
            <div className="mt-5 border-t hairline pt-5">
              <RuleConfig walletId={wid} ruleKey={rk} />
            </div>
          </Card>
          <SpendPanel walletId={wid} xrpl={xrpl} />
        </>
      ) : (
        <Notice tone="warn">This account has no rule yet, so it can&rsquo;t spend. Attach one to activate it.</Notice>
      )}
    </div>
  );
}

function ReceivePanel({ xrpl }: { xrpl: string }) {
  const [bal, setBal] = useState<{ funded: boolean; drops: bigint } | null>(null);
  const [txs, setTxs] = useState<XrplTx[] | null>(null);

  useEffect(() => {
    if (!xrpl) return;
    let stop = false;
    const load = async () => {
      try {
        const [b, t] = await Promise.all([getXrplBalance(xrpl), getRecentPayments(xrpl)]);
        if (!stop) { setBal(b); setTxs(t); }
      } catch { /* transient XRPL RPC */ }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { stop = true; clearInterval(t); };
  }, [xrpl]);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium text-mist-100">Deposit address</h2>
          <p className="mt-1 max-w-md text-[13px] leading-relaxed text-mist-400">
            Send XRP here from anywhere — an exchange, a person, payroll. The signing key was born in the
            enclave and <span className="text-mist-200">cannot be exported</span>, which is exactly why this
            account can&rsquo;t be drained: it can only ever pay where your rule allows.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-mist-500">Balance</div>
          <div className="font-mono text-xl text-mist-100">
            {!xrpl ? "—" : bal === null ? "…" : bal.funded ? formatDrops(bal.drops) : "unfunded"}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border hairline bg-ink-950 px-4 py-3">
        {xrpl ? (
          <a href={xrplAccount(xrpl)} target="_blank" rel="noreferrer" className="break-all font-mono text-sm text-signal-300 hover:text-signal-200">
            {xrpl}
          </a>
        ) : (
          <span className="font-mono text-sm text-amber-200/80">provisioning your XRPL address… (a few seconds)</span>
        )}
      </div>

      {txs && txs.length > 0 && (
        <div className="mt-5">
          <div className="text-xs text-mist-500">Recent payments</div>
          <ul className="mt-2 divide-y divide-ink-800/70">
            {txs.map((t) => (
              <li key={t.hash} className="flex items-center justify-between py-2 font-mono text-[12px]">
                <span className={t.outgoing ? "text-refuse-400" : "text-allow-500"}>
                  {t.outgoing ? "− " : "+ "}{formatDrops(t.amountDrops)}
                </span>
                <span className="text-mist-500">{t.outgoing ? `to ${addr(t.destination)}` : "received"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function SpendPanel({ walletId, xrpl }: { walletId: `0x${string}`; xrpl: string }) {
  const { write, ensureFunded } = useKeyless();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const pay = async () => {
    setMsg(null);
    if (!XRPL_ADDRESS_RE.test(to.trim())) return setMsg({ tone: "error", text: "Enter a valid XRPL r-address." });
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return setMsg({ tone: "error", text: "Enter an amount in XRP." });
    const drops = BigInt(Math.round(n * 1e6));
    setBusy(true);
    try {
      await ensureFunded();
      const fee = (await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "quoteFee", args: [toHex("XRPSEND", { size: 32 })] })) as bigint;
      const ref = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, to.trim(), drops, ref], value: fee });
      setMsg({ tone: "info", text: "Authorized. The enclave is signing and submitting to XRPL — your balance updates in a few seconds." });
      setTo(""); setAmount("");
    } catch (e) {
      // The rule reverted, or the fee was short. Surface the reason.
      const raw = e instanceof Error ? e.message : String(e);
      const reason = /Rejected\("?([^")]+)"?\)/.exec(raw)?.[1] ?? raw.split("\n")[0];
      setMsg({ tone: "error", text: `Refused: ${reason}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-[15px] font-medium text-mist-100">Spend</h2>
      <p className="mt-1 text-[13px] text-mist-400">
        This runs your rule first. If the rule refuses, the enclave never signs — nothing leaves the account.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button onClick={pay} disabled={busy || !xrpl}>{busy ? "…" : "Pay"}</Button>
        </div>
      </div>
      {msg && <div className="mt-3"><Notice tone={msg.tone === "info" ? "info" : msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}
