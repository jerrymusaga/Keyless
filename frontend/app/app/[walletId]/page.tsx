"use client";

import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { motion, AnimatePresence } from "motion/react";
import { useKeyless } from "@/components/app/KeylessProvider";
import { RuleConfig, formatLimit, type Limit } from "@/components/app/RuleConfig";
import { Button, Card, Copy, Field, Input, Notice, Skeleton } from "@/components/app/ui";
import { publicClient } from "@/lib/clients";
import { getAccount } from "@/lib/accounts";
import { getXrplBalance, getRecentPayments, type XrplTx } from "@/lib/xrpl";
import { dryRunAuthorize } from "@/lib/showcase";
import {
  ADDRESSES,
  ACCOUNTS_ABI,
  EXTENSION_ID,
  INIT_FEE,
  RULES,
  RULE_ABIS,
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
  if (loading) return <AccountSkeleton />;
  if (owner === ZERO_ADDRESS) return <Notice tone="error">No such account.</Notice>;
  if (address && owner && owner.toLowerCase() !== address.toLowerCase()) {
    return <Notice tone="warn">This account is controlled by a different key than the one in this browser.</Notice>;
  }

  const local = address ? getAccount(address, wid) : undefined;
  const rk = rule ? ruleKeyOf(rule) : null;
  const hasRule = rule && rule !== ZERO_ADDRESS;

  return (
    <motion.div
      className="space-y-6"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
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
          <CapabilityCard walletId={wid} ruleKey={rk} />
          <Card>
            <h2 className="text-[15px] font-medium text-mist-100">{locked ? "Locked" : "Set up what it can do"}</h2>
            <div className="mt-4">
              {locked ? (
                <Notice tone="ok">
                  <span className="font-medium">Locked forever.</span> The rule and its settings can never change —
                  not even with your key. That&rsquo;s what makes it undrainable.
                </Notice>
              ) : (
                <RuleConfig walletId={wid} ruleKey={rk} />
              )}
            </div>
          </Card>
          <div id="break-it"><BreakItPanel walletId={wid} rule={rule} /></div>
          <ProofPanel rule={rule} xrpl={xrpl} />
          <SpendPanel walletId={wid} xrpl={xrpl} />
          {!locked && <LockPanel walletId={wid} ruleKey={rk} onLocked={readChain} />}
        </>
      ) : (
        <Notice tone="warn">This account has no policy yet, so it can&rsquo;t spend. Attach one to activate it.</Notice>
      )}
    </motion.div>
  );
}

/** Skeleton shown while the account's on-chain state loads — reads as the real layout arriving. */
function AccountSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
      </div>
      <Card><Skeleton className="h-4 w-40" /><Skeleton className="mt-3 h-10 w-full" /></Card>
      <Card><Skeleton className="h-4 w-32" /><Skeleton className="mt-3 h-16 w-full" /></Card>
      <Card><Skeleton className="h-4 w-44" /><Skeleton className="mt-3 h-9 w-2/3" /></Card>
    </div>
  );
}

/**
 * The confidence centrepiece: a plain-English readout of exactly what this account CAN and CAN'T do,
 * generated from its live on-chain config. Turns "policy" into "here's what your money is allowed to do."
 * Exchange is fully translated from config; other rules show their gist until per-policy detail is added.
 */
type Recip = { address: string; requireTag: boolean; tag: number };
type Escrow = { recipient: string; maxAmount: string; conditionHash: string; released: boolean };
type RuleCfg = { recipients?: Recip[]; capDrops?: string; limit?: Limit; escrow?: Escrow | null };

function CapabilityCard({ walletId, ruleKey }: { walletId: `0x${string}`; ruleKey: RuleKey }) {
  const [cfg, setCfg] = useState<RuleCfg | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const fetchCfg = () =>
      fetch("/api/rule-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: ruleKey, walletId }), cache: "no-store" })
        .then((r) => r.json())
        .then((b) => { if (!stop) { setCfg(b); setLoading(false); } })
        .catch(() => { if (!stop) setLoading(false); });
    fetchCfg();
    // The config is read from indexed events (a few seconds' lag), and edits happen in a sibling panel —
    // so poll, and refetch immediately when a save broadcasts, instead of making the user refresh.
    const t = setInterval(fetchCfg, 8000);
    const onChange = () => fetchCfg();
    window.addEventListener("kl:config-changed", onChange);
    return () => { stop = true; clearInterval(t); window.removeEventListener("kl:config-changed", onChange); };
  }, [walletId, ruleKey]);

  const can: ReactNode[] = [];
  const cant: ReactNode[] = [];
  let notSetUp = false;

  if (ruleKey === "exchange") {
    for (const r of cfg?.recipients ?? []) {
      can.push(<>Pay <span className="font-mono text-mist-200">{addr(r.address)}</span>{r.requireTag ? <> with tag <span className="font-mono text-mist-300">{r.tag}</span></> : null}</>);
    }
    if (cfg?.capDrops && cfg.capDrops !== "0") can.push(<>Send at most <span className="text-mist-200">{formatDrops(BigInt(cfg.capDrops))}</span> in one payment</>);
    cant.push("Send to anyone else");
    notSetUp = !loading && (cfg?.recipients?.length ?? 0) === 0;
  } else if (ruleKey === "rateLimit") {
    const l = cfg?.limit;
    if (l) {
      can.push(<>Spend up to <span className="text-mist-200">{formatLimit(l)}</span></>);
      if (l.maxPerTx && l.maxPerTx !== "0") can.push(<>Send at most <span className="text-mist-200">{formatDrops(BigInt(l.maxPerTx))}</span> in one payment</>);
      if (l.allowlistOnly) {
        for (const r of cfg?.recipients ?? []) can.push(<>Pay <span className="font-mono text-mist-200">{addr(r.address)}</span></>);
        cant.push("Pay anyone not on the list");
      } else {
        can.push("Pay any address (within the limit)");
      }
      cant.push("Spend more than the limit");
    } else {
      notSetUp = !loading;
    }
  } else if (ruleKey === "escrow") {
    const e = cfg?.escrow;
    if (e) {
      can.push(<>Pay <span className="font-mono text-mist-200">{addr(e.recipient)}</span> up to <span className="text-mist-200">{formatDrops(BigInt(e.maxAmount))}</span>{e.released ? <> — <span className="text-allow-500">condition proven ✓</span></> : " — once the condition is proven"}</>);
      if (!e.released) cant.push("Pay before the condition is proven");
      cant.push("Pay anyone else");
    } else {
      notSetUp = !loading;
    }
  } else if (ruleKey === "fxrp") {
    can.push("Mint FXRP into this account's own Flare account");
    can.push("Earn in Flare vaults, and bring it home to XRP");
    cant.push("Send FXRP to anyone else");
  }
  cant.push(<>Be drained — <span className="text-mist-300">even if your key is stolen</span></>);

  return (
    <Card className="border-signal-500/25 bg-gradient-to-b from-signal-500/[0.04] to-transparent">
      <h2 className="text-[15px] font-medium text-mist-100">What this account can &amp; can&rsquo;t do</h2>
      {loading ? (
        <div className="mt-3 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
      ) : (
        <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-allow-500">Can</p>
            <ul className="mt-2 space-y-1.5">
              {notSetUp ? (
                <li className="text-[13px] text-mist-500">Not set up yet — set it up below.</li>
              ) : (
                can.map((c, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-mist-300"><span className="mt-px text-allow-500">✓</span><span>{c}</span></li>
                ))
              )}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-refuse-400">Can&rsquo;t</p>
            <ul className="mt-2 space-y-1.5">
              {cant.map((c, i) => (
                <li key={i} className="flex gap-2 text-[13px] text-mist-300"><span className="mt-px text-refuse-400">✕</span><span>{c}</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="mt-4">
        <Button variant="ghost" onClick={() => document.getElementById("break-it")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
          Try to break it →
        </Button>
      </div>
    </Card>
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
        <div className="space-y-2 text-[13px] leading-relaxed">
          <p className="text-mist-100">
            <span className="mr-1.5">🔐</span>
            <span className="font-medium">Your account is live.</span> Its key lives inside a Flare TEE — no one holds it, not even you.
          </p>
          <p className="text-mist-300">
            <span className="mr-1.5">🛡️</span>It does <span className="text-mist-100">only what your policy allows.</span> Try to break it below — no funding needed.
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
            Send XRP here from anywhere. The key that signs lives in the enclave — it can only pay where your rule allows.
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
          Need testnet XRP? Paste this address into the{" "}
          <a href="https://test.bithomp.com/faucet" target="_blank" rel="noreferrer" className="text-signal-300 underline underline-offset-2 hover:text-signal-200">
            Bithomp faucet ↗
          </a>.
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
        // The FXRP rule needs no configuration — it mints only to this account's own (on-chain-computed)
        // Flare account and permits just the safe DeFi verbs. Nothing to allowlist, so it's ready at once.
        if (ruleKey === "fxrp") {
          if (!stop) setConfigured(true);
          return;
        }
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
        Freeze it <span className="text-mist-200">permanently</span> — the rule can never change again, even if your
        key is stolen. <span className="text-mist-300">There is no unlock.</span>
      </p>

      <div className="mt-4">
        {configured === false ? (
          <Notice tone="warn">
            Set the policy up first (add at least one approved recipient) — locking it empty would freeze the
            account with nothing allowed.
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

// A few well-formed "stranger" r-addresses to stand in for a thief. The dry-run does a string compare
// against the on-chain allowlist, so these just need to look like real addresses — nothing is sent.
const STRANGERS = [
  "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT",
  "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLp",
  "rDNvpqSzJzk8jVLBrGHMpuvSb3iBaz5tYs",
];
const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The block moment — the emotional centre of the product. "Go ahead, try to drain it" runs the account's
 * REAL rule on-chain (dryRunAuthorize: a gasless eth_call, nothing moves) and the refusal is the payoff.
 * Every refusal bumps a persistent per-account counter and offers a shareable proof. This is what makes
 * "undrainable" felt rather than claimed.
 */
function BreakItPanel({ walletId, rule }: { walletId: `0x${string}`; rule: `0x${string}` }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string; label: string } | null>(null);
  const [blocked, setBlocked] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try { setBlocked(Number(localStorage.getItem(`kl_blocked_${walletId}`) || 0)); } catch { /* no storage */ }
  }, [walletId]);

  const run = async (recip: string, xrp: number, label: string) => {
    setBusy(true);
    setResult(null);
    const v = await dryRunAuthorize(rule, walletId, recip, BigInt(Math.round(xrp * 1e6)));
    setResult({ ok: v.allowed, reason: v.reason, label });
    if (!v.allowed) {
      setBlocked((b) => {
        const n = b + 1;
        try { localStorage.setItem(`kl_blocked_${walletId}`, String(n)); } catch { /* ignore */ }
        return n;
      });
    }
    setBusy(false);
  };

  const drain = () => {
    const thief = STRANGERS[Math.floor(Math.random() * STRANGERS.length)];
    run(thief, 10000, `Drain 10,000 XRP → ${addr(thief)}`);
  };

  const custom = () => {
    if (!XRPL_ADDRESS_RE.test(to.trim())) return alert("Enter a valid XRPL r-address.");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return alert("Enter an amount in XRP.");
    run(to.trim(), n, `${n} XRP → ${addr(to.trim())}`);
  };

  const share = async () => {
    const text = "My Keyless XRP account just refused a drain on-chain — even I can't send where its policy forbids. Verified live on Coston2. 🛡️";
    try {
      await navigator.clipboard.writeText(`${text}\n${window.location.origin}/see`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };

  return (
    <Card className="border-signal-500/25 bg-gradient-to-b from-signal-500/[0.04] to-transparent">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium text-mist-100">Try to break it 🛡️</h2>
        {blocked > 0 && (
          <span className="flex items-center gap-1.5 text-[12px] text-mist-400">
            <span className="text-allow-500">🛡️</span>refused
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={blocked}
                initial={{ y: -8, opacity: 0, scale: 0.7 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: 8, opacity: 0, position: "absolute" }}
                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                className="font-mono font-semibold text-allow-500"
              >
                {blocked}
              </motion.span>
            </AnimatePresence>
            drain{blocked !== 1 ? "s" : ""} so far
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-mist-400">
        Try to send this account&rsquo;s money somewhere it shouldn&rsquo;t go. It asks your{" "}
        <span className="text-mist-200">real rule on-chain</span> — no gas, nothing moves — and refuses.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button onClick={drain} disabled={busy}>{busy ? "Asking the rule…" : "Try to drain it →"}</Button>
        <span className="text-[12px] text-mist-500">or test a specific payment</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button variant="ghost" onClick={custom} disabled={busy}>Test</Button>
        </div>
      </div>

      <div className="mt-4 min-h-[68px]">
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div
              key={result.label + (result.ok ? "ok" : "no")}
              initial={{ opacity: 0, scale: 0.96, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className={`rounded-xl border px-4 py-3.5 ${result.ok ? "border-allow-500/40 bg-allow-500/[0.06]" : "border-refuse-500/40 bg-refuse-500/[0.06]"}`}
            >
              <div className={`flex items-center gap-2 text-[14px] font-medium ${result.ok ? "text-allow-500" : "text-refuse-400"}`}>
                <motion.span initial={{ scale: 0.4, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 420, damping: 12 }}>
                  {result.ok ? "✓" : "🛡️"}
                </motion.span>
                {result.ok ? "Allowed" : "Refused"} — <span className="font-normal opacity-90">{result.label}</span>
              </div>
              <div className={`mt-1 text-[13px] ${result.ok ? "text-allow-500/90" : "text-refuse-400/90"}`}>
                {result.ok
                  ? "Your rule permits this — the enclave would sign and send it."
                  : `“${result.reason ?? "not permitted"}”. Nothing left the account — even with the key, it can't go there.`}
              </div>
              {!result.ok && (
                <button type="button" onClick={share} className="mt-2 text-[12px] font-medium text-signal-300 underline underline-offset-2 transition-colors hover:text-signal-200">
                  {copied ? "Copied ✓" : "Share this proof ↗"}
                </button>
              )}
            </motion.div>
          ) : (
            <p className="text-[12px] text-mist-500">The refusal is the fun part — it&rsquo;s your rule holding the line on-chain, not us.</p>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}

/**
 * Trust made visible — the undrainability claim backed by anchors the user can check on-chain, not a
 * promise. Deliberately honest: it verifies what IS on-chain (the extension binding, live; the rule the key
 * obeys; the TEE machine) and does NOT claim a verified remote-attestation code-hash (that verifier is still
 * a skeleton). The headline is the real guarantee: this app can request a payment but can never sign one.
 */
function ProofPanel({ rule, xrpl }: { rule: `0x${string}`; xrpl: string }) {
  const [bound, setBound] = useState<boolean | null>(null);
  const [ext, setExt] = useState<bigint | null>(null);

  useEffect(() => {
    Promise.all([
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "isBound" }).catch(() => null),
      publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "extensionId" }).catch(() => null),
    ]).then(([b, e]) => { setBound(b as boolean | null); setExt(e as bigint | null); });
  }, []);

  const extLabel = ext !== null ? ext.toString() : String(EXTENSION_ID);
  const rows: { title: ReactNode; proof: ReactNode; link?: { href: string; label: string }; live?: boolean | null }[] = [
    {
      title: "The signing key was born in a Flare TEE",
      proof: <>Made inside the enclave — <span className="text-mist-200">it can&rsquo;t be exported,</span> by anyone.</>,
      link: xrpl ? { href: xrplAccount(xrpl), label: "the XRPL account ↗" } : undefined,
    },
    {
      title: <>Bound to Flare TEE extension <span className="font-mono">{extLabel}</span></>,
      proof: <>Registered and bound on Flare&rsquo;s TeeManager — verified live.</>,
      link: { href: explorerAddress(ADDRESSES.teeManager), label: "Flare TeeManager ↗" },
      live: bound,
    },
    {
      title: "Governed only by this one rule",
      proof: <>Nothing else can move the funds. Read the code:</>,
      link: { href: explorerAddress(rule), label: "the rule contract ↗" },
    },
  ];

  return (
    <Card>
      <h2 className="text-[15px] font-medium text-mist-100">Proof it&rsquo;s undrainable</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-mist-400">
        Not a promise — check it on-chain. <span className="text-mist-200">This app can ask your account to pay, but can never sign for it.</span>
      </p>
      <ul className="mt-4 space-y-3">
        {rows.map((r, i) => (
          <li key={i} className="flex gap-3">
            <span className={`mt-0.5 shrink-0 ${r.live === false ? "text-refuse-400" : "text-allow-500"}`} aria-hidden="true">
              {r.live === null ? "…" : r.live === false ? "✕" : "✓"}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-mist-100">{r.title}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-mist-400">
                {r.proof}
                {r.link && (
                  <>
                    {" "}
                    <a href={r.link.href} target="_blank" rel="noreferrer" className="text-signal-300 underline underline-offset-2 hover:text-signal-200">
                      {r.link.label}
                    </a>
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
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
      // Guard: don't attempt a spend this account can't cover — check its XRPL balance, keeping ~1 XRP for
      // the ledger reserve. If the balance can't be read, proceed and let the chain be the backstop.
      try {
        const xb = await getXrplBalance(xrpl);
        if (!xb.funded) { setBusy(false); return setMsg({ tone: "error", text: "This account has no XRP yet — fund the deposit address above first." }); }
        if (drops + 1_000_000n > xb.drops) { setBusy(false); return setMsg({ tone: "error", text: `This account holds ${formatDrops(xb.drops)}. Send a little less so ~1 XRP stays for the ledger reserve.` }); }
      } catch { /* balance unreadable — proceed */ }

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
        Runs your rule first. If it refuses, nothing leaves the account.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button onClick={pay} disabled={busy || !xrpl}>{busy ? "…" : "Pay"}</Button>
        </div>
      </div>
      {msg && (
        <motion.div
          className="mt-3"
          key={msg.text}
          initial={{ opacity: 0, scale: 0.97, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.32, ease: EASE }}
        >
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
        </motion.div>
      )}
    </Card>
  );
}
