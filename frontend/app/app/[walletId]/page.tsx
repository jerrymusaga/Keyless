"use client";

import { use, useCallback, useEffect, useState } from "react";
import { toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { useKeyless } from "@/components/app/KeylessProvider";
import { RuleConfig } from "@/components/app/RuleConfig";
import { Button, Card, Copy, Field, Input, Notice, Spinner } from "@/components/app/ui";
import { publicClient } from "@/lib/clients";
import { getAccount } from "@/lib/accounts";
import { getXrplBalance, getRecentPayments, type XrplTx } from "@/lib/xrpl";
import { dryRunAuthorize } from "@/lib/showcase";
import {
  ADDRESSES,
  ACCOUNTS_ABI,
  INIT_FEE,
  RULES,
  RULE_META,
  ZERO_ADDRESS,
  XRPL_ADDRESS_RE,
  addr,
  explorerAddress,
  xrplAccount,
  xrplTx,
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
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const readChain = useCallback(async () => {
    const [o, r] = await Promise.all([
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "ownerOf", args: [wid] }) as Promise<string>,
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "ruleOf", args: [wid] }) as Promise<`0x${string}`>,
    ]);
    // xrplAddressOf / isLocked only exist on the newer contract; tolerate absence so the page renders.
    const [x, l] = await Promise.all([
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [wid] }).catch(() => "") as Promise<string>,
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "isLocked", args: [wid] }).catch(() => false) as Promise<boolean>,
    ]);
    setOwner(o);
    setRule(r);
    setXrpl(x);
    setLocked(l);
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
          {locked && (
            <span className="rounded-full border border-allow-500/40 bg-allow-500/10 px-2.5 py-0.5 text-[11px] text-allow-500">
              🔒 rule locked
            </span>
          )}
        </div>
      </div>

      <WelcomeBanner walletId={wid} />

      <ReceivePanel xrpl={xrpl} />

      {hasRule && rk ? (
        <>
          <Card>
            <h2 className="text-[15px] font-medium text-mist-100">Rule — {RULE_META[rk].name}</h2>
            <p className="mt-1 text-[13px] text-mist-400">{RULE_META[rk].tagline}</p>
            <p className="mt-1 text-xs text-signal-300/80">Protects against: {RULE_META[rk].protects}</p>
            <div className="mt-5 border-t hairline pt-5">
              {locked ? (
                <Notice tone="ok">
                  This policy is <span className="font-medium">locked forever</span>. Its rule and settings
                  can never change — not even with your control key. That&rsquo;s why this account can&rsquo;t
                  be drained even if the key is stolen: it can only ever keep doing exactly what it does now.
                </Notice>
              ) : (
                <RuleConfig walletId={wid} ruleKey={rk} />
              )}
            </div>
          </Card>
          <TestPanel walletId={wid} rule={rule} />
          <SpendPanel walletId={wid} xrpl={xrpl} />
          {!locked && <LockPanel walletId={wid} ruleKey={rk} onLocked={readChain} />}
        </>
      ) : (
        <Notice tone="warn">This account has no policy yet, so it can&rsquo;t spend. Attach one to activate it.</Notice>
      )}
    </div>
  );
}

function WelcomeBanner({ walletId }: { walletId: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(`kl_welcome_${walletId}`)) setShow(true);
    } catch {
      /* no storage — skip */
    }
  }, [walletId]);
  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(`kl_welcome_${walletId}`, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };
  return (
    <div className="rounded-xl border border-signal-500/30 bg-signal-500/[0.06] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2.5 text-[13px] leading-relaxed">
          <p className="text-mist-100">
            <span className="mr-1.5">🔐</span>
            <span className="font-medium">Your Keyless account is live.</span> Its key was born inside a Flare
            TEE — no one holds it. Not the app, not us, not even you.
          </p>
          <p className="text-mist-300">
            <span className="mr-1.5">🛡️</span>Your policy is set. This account now does{" "}
            <span className="text-mist-100">only what you allowed</span> — nothing else can happen.
          </p>
          <p className="text-mist-300">
            <span className="mr-1.5">💰</span>Fund the deposit address below to activate it — then try a payment
            your policy blocks and watch it get stopped. <span className="text-mist-100">That&rsquo;s the whole point.</span>
          </p>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-sm text-mist-500 transition-colors hover:text-mist-300">
          ✕
        </button>
      </div>
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

      <div className="mt-4 flex items-center gap-3 rounded-lg border hairline bg-ink-950 px-4 py-3">
        {xrpl ? (
          <>
            <a href={xrplAccount(xrpl)} target="_blank" rel="noreferrer" className="min-w-0 break-all font-mono text-sm text-signal-300 hover:text-signal-200">
              {xrpl}
            </a>
            <Copy text={xrpl} label="Copy address" className="ml-auto" />
          </>
        ) : (
          <span className="font-mono text-sm text-amber-200/80">provisioning your XRPL address… (a few seconds)</span>
        )}
      </div>

      {xrpl && !bal?.funded && (
        <p className="mt-2 text-[12px] leading-relaxed text-mist-500">
          Need testnet XRP? Fund this address in one step at the{" "}
          <a
            href="https://test.bithomp.com/faucet"
            target="_blank"
            rel="noreferrer"
            className="text-signal-300 underline underline-offset-2 hover:text-signal-200"
          >
            Bithomp faucet ↗
          </a>
          {" "}(paste the address above), or pick another from the{" "}
          <a
            href="https://xrpl.org/resources/dev-tools/xrp-faucets"
            target="_blank"
            rel="noreferrer"
            className="text-signal-300 underline underline-offset-2 hover:text-signal-200"
          >
            XRP faucet list ↗
          </a>
          .
        </p>
      )}

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

function LockPanel({ walletId, ruleKey, onLocked }: { walletId: `0x${string}`; ruleKey: RuleKey; onLocked: () => void }) {
  const { write } = useKeyless();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whether the policy actually has a configuration. Locking an EMPTY policy is a trap: it freezes the
  // account forever with nothing allowed and no way to fix it. Gate the button until it's configured.
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await fetch("/api/rule-config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rule: ruleKey, walletId }),
          cache: "no-store",
        });
        const b = await res.json().catch(() => ({}));
        const ok = Array.isArray(b.recipients)
          ? b.recipients.length > 0
          : ruleKey === "escrow"
            ? !!b.escrow
            : false;
        if (!stop) setConfigured(ok);
      } catch {
        if (!stop) setConfigured(null); // couldn't verify — stay locked-out (fail closed on an irreversible action)
      }
    })();
    return () => { stop = true; };
  }, [ruleKey, walletId]);

  const lock = async () => {
    setBusy(true);
    setErr(null);
    try {
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "lockRule", args: [walletId] });
      onLocked();
    } catch (e) {
      setErr(e instanceof Error ? e.message.split("\n")[0] : String(e));
      setBusy(false);
    }
  };

  return (
    <Card className="border-allow-500/20">
      <h2 className="text-[15px] font-medium text-mist-100">Lock this policy</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-mist-400">
        Freeze the policy <span className="text-mist-200">permanently</span>. After this, its rule and
        settings can never change — not with your control key, not even if it&rsquo;s stolen. Best once
        you&rsquo;ve tested it above and won&rsquo;t edit it again.{" "}
        <span className="text-mist-300">There is no unlock.</span>
      </p>

      <div className="mt-4">
        {configured === false ? (
          <Notice tone="warn">
            Configure this policy first — add at least one approved recipient above. Locking it empty would
            freeze the account forever with nothing allowed.
          </Notice>
        ) : !arming ? (
          <Button variant="ghost" onClick={() => setArming(true)} disabled={configured !== true}>
            {configured === null ? "Checking policy…" : "Lock policy →"}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-amber-200/90">This can&rsquo;t be undone. Lock it forever?</span>
            <Button onClick={lock} disabled={busy}>{busy ? "Locking…" : "Yes, lock forever"}</Button>
            <Button variant="ghost" onClick={() => setArming(false)} disabled={busy}>No, keep editable</Button>
          </div>
        )}
      </div>
      {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
    </Card>
  );
}

function TestPanel({ walletId, rule }: { walletId: `0x${string}`; rule: `0x${string}` }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string; label: string } | null>(null);

  const test = async () => {
    if (!XRPL_ADDRESS_RE.test(to.trim())) return alert("Enter a valid XRPL r-address.");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return alert("Enter an amount in XRP.");
    setBusy(true);
    setResult(null);
    const v = await dryRunAuthorize(rule, walletId, to.trim(), BigInt(Math.round(n * 1e6)));
    setResult({ ok: v.allowed, reason: v.reason, label: `${n} XRP → ${addr(to.trim())}` });
    setBusy(false);
  };

  return (
    <Card>
      <h2 className="text-[15px] font-medium text-mist-100">Test a payment (dry-run)</h2>
      <p className="mt-1 text-[13px] text-mist-400">
        Check whether a payment would pass your rule — <span className="text-mist-200">without sending anything.</span>{" "}
        It reads the real rule on-chain, so it&rsquo;s a safe way to sanity-check your setup before you fund or lock.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button variant="ghost" onClick={test} disabled={busy}>{busy ? "…" : "Test"}</Button>
        </div>
      </div>
      {result && (
        <div className="mt-3">
          <Notice tone={result.ok ? "ok" : "error"}>
            {result.ok
              ? `✓ ${result.label} would be accepted — the enclave would sign it.`
              : `✗ ${result.label} would be refused: “${result.reason ?? "not permitted"}”. Nothing would leave the account.`}
          </Notice>
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
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string; tx?: string } | null>(null);

  const pay = async () => {
    setMsg(null);
    const toClean = to.trim();
    if (!XRPL_ADDRESS_RE.test(toClean)) return setMsg({ tone: "error", text: "Enter a valid XRPL r-address." });
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return setMsg({ tone: "error", text: "Enter an amount in XRP." });
    const drops = BigInt(Math.round(n * 1e6));
    setBusy(true);
    try {
      await ensureFunded();
      // Snapshot existing outgoing payments so we can recognise the NEW one once it settles on XRPL.
      const seen = new Set<string>();
      try { (await getRecentPayments(xrpl)).forEach((t) => seen.add(t.hash)); } catch { /* transient */ }

      const ref = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, toClean, drops, ref], value: INIT_FEE });

      // On-chain authorization succeeded. The enclave now signs + submits async, so re-enable the form
      // and watch the ledger for the settled payment rather than leaving the user on "Authorized…" forever.
      setMsg({ tone: "info", text: "Authorized — the enclave is signing and submitting to XRPL. Confirming settlement…" });
      setTo(""); setAmount("");
      setBusy(false);

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        let txs: XrplTx[] = [];
        try { txs = await getRecentPayments(xrpl); } catch { continue; }
        const hit = txs.find((t) => t.outgoing && !seen.has(t.hash) && t.destination === toClean && t.amountDrops === drops);
        if (hit) {
          setMsg({ tone: "ok", text: `✓ Sent — ${n} XRP delivered to ${addr(toClean)}.`, tx: hit.hash });
          return;
        }
      }
      // Don't claim failure — the authorization landed; XRPL just hasn't shown the tx yet.
      setMsg({ tone: "info", text: "Submitted — taking a little longer than usual to confirm on XRPL. It'll appear under “Recent payments” below once it settles." });
      return;
    } catch (e) {
      // A contract revert here is the POLICY DOING ITS JOB — celebrate it, don't show a scary error.
      // Anything else (short fee, network) is a real error.
      let reason = "your policy didn't allow this";
      let blocked = false;
      if (e instanceof BaseError) {
        const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
        if (rev instanceof ContractFunctionRevertedError) {
          blocked = true;
          reason = (rev.data?.args?.[0] as string) ?? rev.reason ?? rev.shortMessage ?? reason;
        } else {
          reason = e.shortMessage ?? reason;
        }
      } else if (e instanceof Error) {
        reason = e.message.split("\n")[0];
      }
      if (blocked) {
        setMsg({
          tone: "ok",
          text: `🛡️ Blocked on-chain — your policy stopped this payment (“${reason}”). That's the whole point: even with the key, this account can't send there. Nothing left the account.`,
        });
      } else {
        setMsg({ tone: "error", text: `Couldn't send: ${reason}` });
      }
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
      <p className="mt-1.5 text-[12px] text-signal-300/80">
        Don&rsquo;t trust it? Try sending to an address you didn&rsquo;t allow — watch it get blocked. 🛡️
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button onClick={pay} disabled={busy || !xrpl}>{busy ? "…" : "Pay"}</Button>
        </div>
      </div>
      {msg && (
        <div className="mt-3">
          <Notice tone={msg.tone}>
            {msg.text}
            {msg.tx && (
              <>
                {" "}
                <a href={xrplTx(msg.tx)} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2 hover:text-mist-100">
                  View on XRPL ↗
                </a>
              </>
            )}
          </Notice>
        </div>
      )}
    </Card>
  );
}
