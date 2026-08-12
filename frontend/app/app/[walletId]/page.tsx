"use client";

import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { motion, AnimatePresence } from "motion/react";
import { useKeyless } from "@/components/app/KeylessProvider";
import { RuleConfig, formatLimit, type Limit } from "@/components/app/RuleConfig";
import { Button, Card, Copy, Input, Notice, Skeleton } from "@/components/app/ui";
import { publicClient } from "@/lib/clients";
import { getAccount } from "@/lib/accounts";
import { getXrplBalance, getRecentPayments, type XrplTx } from "@/lib/xrpl";
import { nicknameOf } from "@/lib/nicknames";
import { dryRunAuthorize } from "@/lib/showcase";
import {
  ADDRESSES,
  ACCOUNTS_ABI,
  EXTENSION_ID,
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
  scheduleEnd,
  RULE_ABIS,
  SUPERSEDED_RULES,
  paymentRef,
} from "@/lib/keyless";
import { readLimit, fmtIn, type LimitState } from "@/lib/limit";

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

  // Whether a manual payment could succeed right now. null = still checking, so the panel stays hidden
  // rather than flickering between two claims about what the account can do.
  //
  // Lives up here with the other hooks on purpose: it used to sit below the early returns, which meant it
  // was skipped whenever the page was still loading — and a component that calls a different number of
  // hooks between renders crashes outright.
  const [spendReady, setSpendReady] = useState<boolean | null>(null);
  useEffect(() => {
    const k = rule ? ruleKeyOf(rule) : null;
    if (!k) return;
    if (k !== "escrow" && k !== "scheduled") { setSpendReady(true); return; }
    let stop = false;
    const check = async () => {
      try {
        if (k === "escrow") {
          const c = (await publicClient.readContract({
            address: RULES.escrow as `0x${string}`, abi: RULE_ABIS.escrow as never,
            functionName: "conditionOf", args: [wid],
          })) as readonly [string, bigint, string, string, bigint, string, bigint, boolean, boolean];
          if (!stop) setSpendReady(c[7]); // released
        } else {
          const [dueAt] = (await publicClient.readContract({
            address: RULES.scheduled as `0x${string}`, abi: RULE_ABIS.scheduled as never,
            functionName: "nextRun", args: [wid],
          })) as readonly [bigint, bigint];
          if (!stop) setSpendReady(dueAt > 0n && Number(dueAt) <= Math.floor(Date.now() / 1000));
        }
      } catch { if (!stop) setSpendReady(false); }
    };
    check();
    const t = setInterval(check, 20_000);
    return () => { stop = true; clearInterval(t); };
  }, [rule, wid]);

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
  // A rule we recognise but no longer deploy. The account isn't ruleless — saying so would be both wrong
  // and alarming — it's pointing at a version the executors no longer watch.
  const superseded = hasRule && !rk ? SUPERSEDED_RULES[rule.toLowerCase()] : undefined;


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
          {/* A recovered account has no label — name it by its policy, same as the list does. */}
          <h1 className="text-2xl font-medium tracking-[-0.02em] text-mist-100">
            {local?.label || (rk ? `${RULE_META[rk].name} account` : "Account")}
          </h1>
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
          {/* FXRP has its own mint / earn / bring-home actions, and the rule blocks all other payments —
              so a generic "Spend to an r-address" would only ever be refused. Hide it for FXRP. */}
          {/* On Conditional and Scheduled, this panel can't do anything until the rule says so — and a
              tester read it beside "Try to break it" as a second way to do the same thing. It isn't: it's
              how a proven condition actually pays out. So rather than delete the payout, hide it until it
              means something, and let the account say why it's absent. */}
          {rk !== "fxrp" && (spendReady === null ? null : spendReady ? (
            <SpendPanel walletId={wid} xrpl={xrpl} ruleKey={rk} />
          ) : (
            <Card>
              <h2 className="text-[15px] font-medium text-mist-100">{rk === "escrow" ? "Nothing to release yet" : "Nothing due yet"}</h2>
              <p className="mt-1 text-[13px] text-mist-400">
                {rk === "escrow"
                  ? "Once the condition is proven, this is where the payment is released. Until then the rule refuses every payment — including yours."
                  : "Scheduled payments run on their own when they fall due. Nothing can be sent before then, by anyone."}
              </p>
            </Card>
          ))}
          {!locked && <LockPanel walletId={wid} ruleKey={rk} onLocked={readChain} />}
        </>
      ) : superseded ? (
        <MovePanel walletId={wid} superseded={superseded} onMoved={readChain} />
      ) : (
        <Notice tone="warn">This account has no policy yet, so it can&rsquo;t spend. Attach one to activate it.</Notice>
      )}
    </motion.div>
  );
}

/**
 * An account left on a rule version we've replaced.
 *
 * Its funds are safe and the old contract still governs it, but nothing runs its schedule any more and the
 * settings panel writes to the current rule — so the page would otherwise look empty for no stated reason.
 * Say what happened, and make the fix one button.
 */
function MovePanel({
  walletId,
  superseded,
  onMoved,
}: {
  walletId: `0x${string}`;
  superseded: { name: string; current: RuleKey };
  onMoved: () => void;
}) {
  const { write } = useKeyless();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const move = async () => {
    setBusy(true);
    setErr(null);
    try {
      await write({
        address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "setRule",
        args: [walletId, RULES[superseded.current] as `0x${string}`],
      });
      onMoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Notice tone="warn">
        <div className="space-y-2">
          <div>
            <span className="font-medium">This account is on an older version of {superseded.name}.</span>{" "}
            Its money is safe and untouched — but the version it&rsquo;s on is no longer the one being run, so
            anything it had scheduled won&rsquo;t happen, and its settings won&rsquo;t show below.
          </div>
          <div className="text-mist-400">
            Moving it takes one transaction. You&rsquo;ll need to set the schedule up again afterwards — settings
            live in the rule, so they don&rsquo;t come across.
          </div>
        </div>
      </Notice>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={move} disabled={busy}>{busy ? "Moving…" : `Move to the current ${superseded.name}`}</Button>
      </div>
      {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
    </Card>
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
type Escrow = { recipient: string; maxAmount: string; released: boolean; condition?: string; deadline?: string; fallback?: string };
type SchedLine = { recipient: string; amount: string; unit: number; offsetDays: number; runs: number; firstDue: string };
type RuleCfg = { recipients?: Recip[]; capDrops?: string; limit?: Limit; escrow?: Escrow | null; lines?: SchedLine[] };

const SCHED_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** "on the 1st of every month" — the sentence the owner filled in, not the fields it was stored as. */
function schedWhen(l: { unit: number; offsetDays: number }): string {
  if (l.unit === 0) return "every day";
  if (l.unit === 1) return `every ${SCHED_DAYS[l.offsetDays] ?? "Monday"}`;
  if (l.offsetDays === 255) return "on the last day of every month"; // CalendarLib.LAST_DAY
  const n = l.offsetDays + 1;
  const teen = n % 100;
  const suffix = teen >= 11 && teen <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `on the ${n}${suffix} of every month`;
}

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
      can.push(<>Pay <span className="font-mono text-mist-200">{addr(e.recipient)}</span>, up to <span className="text-mist-200">{formatDrops(BigInt(e.maxAmount))}</span>{e.condition ? <> — once <span className="text-mist-200">{e.condition}</span> is proven</> : " — once the condition is proven"}</>);
      if (e.released) can.push(<><span className="text-allow-500">Condition proven ✓</span> — it can pay now</>);
      else cant.push("Pay anything at all — until the condition is proven");
      if (e.deadline && e.deadline !== "0" && e.fallback) {
        can.push(<>Return the funds to <span className="font-mono text-mist-200">{addr(e.fallback)}</span> if that hasn&rsquo;t happened by <span className="text-mist-200">{new Date(Number(e.deadline) * 1000).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</span></>);
      }
      cant.push("Pay anyone else");
    } else {
      notSetUp = !loading;
    }
  } else if (ruleKey === "scheduled") {
    const lines = cfg?.lines ?? [];
    for (const l of lines) {
      can.push(
        <>Pay <span className="font-mono text-mist-200">{addr(l.recipient)}</span> exactly{" "}
        <span className="text-mist-200">{formatDrops(BigInt(l.amount))}</span> {schedWhen(l)}
        {(() => {
          const end = scheduleEnd(l.unit, l.offsetDays, Number(l.firstDue), l.runs);
          return end
            ? <>, {l.runs} time{l.runs === 1 ? "" : "s"} — until <span className="text-mist-200">{end.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</span></>
            : <>, {l.runs} times — with no end date anyone will see</>;
        })()}</>,
      );
    }
    if (lines.length) {
      // Worth spelling out: this is the only policy that permits a point rather than a range.
      cant.push("Pay a penny more, or a penny less");
      cant.push("Pay early, or twice in the same period");
      cant.push("Pay anyone not on this list");
    }
    notSetUp = !loading && lines.length === 0;
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
  const [ledgerDown, setLedgerDown] = useState(false);

  useEffect(() => {
    if (!xrpl) return;
    let stop = false;
    const load = async () => {
      try {
        const [b, t] = await Promise.all([getXrplBalance(xrpl), getRecentPayments(xrpl)]);
        if (!stop) { setBal(b); setTxs(t); setLedgerDown(false); }
      } catch {
        // Don't leave the balance on a placeholder forever — an unreachable ledger looks identical to a
        // slow one, and someone who just funded the account will assume their money vanished.
        if (!stop) setLedgerDown(true);
      }
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
            {!xrpl ? "—" : bal !== null ? (bal.funded ? formatDrops(bal.drops) : "unfunded") : ledgerDown ? "—" : "…"}
          </div>
          {ledgerDown && bal === null && (
            <div className="mt-0.5 text-[11px] text-warn-500">can&rsquo;t reach the XRP Ledger</div>
          )}
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
            {/* Every row links to the ledger. This list is the account's own account of itself, and a
                product arguing "don't take our word for it" shouldn't ask you to for its history. */}
            {txs.map((t) => (
              <li key={t.hash} className="flex items-center justify-between gap-3 py-2 font-mono text-[12px]">
                <span className={t.outgoing ? "text-refuse-400" : "text-allow-500"}>
                  {t.outgoing ? "− " : "+ "}{formatDrops(t.amountDrops)}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-mist-500">{t.outgoing ? `to ${addr(t.destination)}` : "received"}</span>
                  <a
                    href={xrplTx(t.hash)} target="_blank" rel="noreferrer"
                    title={t.hash}
                    className="shrink-0 text-signal-400 underline decoration-ink-600 underline-offset-4 transition-colors hover:decoration-signal-500"
                  >
                    ↗
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function LockPanel({ walletId, ruleKey, onLocked }: { walletId: `0x${string}`; ruleKey: RuleKey; onLocked: () => void }) {
  const { write, address: owner } = useKeyless();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whether the policy actually has a configuration. Locking an EMPTY policy is a trap: it freezes the
  // account forever with nothing allowed and no way to fix it. Gate the button until it's configured.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Everywhere this account will still be able to send once frozen. A tester asked the right question:
  // "when a change is needed, the only solution seems to be to empty the wallet and create a new one —
  // what countermeasures do you suggest?" This is the countermeasure, and it only works before the lock:
  // make sure at least one permitted destination is somewhere they control.
  const [exits, setExits] = useState<string[]>([]);

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
            : ruleKey === "scheduled"
              ? Array.isArray(b.lines) && b.lines.length > 0
              : false;
        const found: string[] = Array.isArray(b.recipients)
          ? b.recipients.map((r: { address: string }) => r.address)
          : Array.isArray(b.lines)
            ? b.lines.map((l: { recipient: string }) => l.recipient)
            : Array.isArray(b.payees)
              ? b.payees
              : b.escrow
                ? [b.escrow.recipient, b.escrow.fallback].filter(Boolean)
                : [];
        if (!stop) setExits([...new Set(found)]);
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
          <div className="space-y-3">
            {/* The one thing worth checking before an irreversible decision: where can the money still go? */}
            {exits.length > 0 && (
              <Notice tone="warn">
                <div className="space-y-1.5">
                  <div>
                    <span className="font-medium">Once locked, this account can only ever send to:</span>
                  </div>
                  <ul className="space-y-0.5">
                    {exits.map((e) => (
                      <li key={e} className="font-mono text-[12px] text-mist-300">
                        {nicknameOf(owner, e) ? `${nicknameOf(owner, e)} — ` : ""}{e}
                      </li>
                    ))}
                  </ul>
                  <div className="text-mist-400">
                    Make sure at least one of those is somewhere you control. After locking, that list is the
                    only way value ever leaves this account — and it can never be added to.
                  </div>
                </div>
              </Notice>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-amber-200/90">This can&rsquo;t be undone. Lock it forever?</span>
              <Button onClick={lock} disabled={busy}>{busy ? "Locking…" : "Yes, lock forever"}</Button>
              <Button variant="ghost" onClick={() => setArming(false)} disabled={busy}>No, keep editable</Button>
            </div>
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
 * The destination tag this account has pinned to `recipient`, if any — and fill it in once known.
 *
 * An exchange only credits a deposit that carries its tag, so ExchangeRule can pin (recipient, tag) and
 * refuse anything else. That makes the tag part of the payment, not a detail: without it a pinned
 * recipient is unpayable.
 *
 * Reporting it is all this does. The spend form fills it in and locks it, because there nobody should have
 * to remember the number and changing it could only produce a refusal. Try-to-break-it deliberately does
 * NOT fill it in — that panel must test what you actually typed, or it could answer "allowed" for an input
 * you never gave it. It shows the pinned value as a hint instead, so trying the right tag stays one glance
 * away without being done for you.
 */
function usePinnedTag(enabled: boolean, walletId: `0x${string}`, recipient: string) {
  const [pinned, setPinned] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    fetch("/api/rule-config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rule: "exchange", walletId }),
    })
      .then((r) => r.json())
      .then((d: { recipients?: { address: string; requireTag: boolean; tag: number }[] }) => {
        if (stop || !d.recipients) return;
        setPinned(Object.fromEntries(d.recipients.filter((r) => r.requireTag).map((r) => [r.address, r.tag])));
      })
      .catch(() => { /* the field just won't prefill */ });
    return () => { stop = true; };
  }, [enabled, walletId]);

  return pinned[recipient.trim()];
}

/**
 * The block moment — the emotional centre of the product. "Go ahead, try to drain it" runs the account's
 * REAL rule on-chain (dryRunAuthorize: a gasless eth_call, nothing moves) and the refusal is the payoff.
 * Every refusal bumps a persistent per-account counter and offers a shareable proof. This is what makes
 * "undrainable" felt rather than claimed.
 */
function BreakItPanel({ walletId, rule }: { walletId: `0x${string}`; rule: `0x${string}` }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [tag, setTag] = useState("");
  const pinnedTag = usePinnedTag(rule === RULES.exchange, walletId, to);

  // "Try to drain it" sends to a STRANGER, so on an allowlist-backed spending limit it's refused for the
  // recipient and the amount is never reached — the headline demo on a spending-limit account never
  // actually demonstrated the spending limit. This arms a second attempt that clears the recipient gate
  // and fails on the cap instead: an approved address, for more than the rule allows.
  const [overspend, setOverspend] = useState<{ recipient: string; xrp: number } | null>(null);
  useEffect(() => {
    if (rule !== RULES.rateLimit) return;
    let stop = false;
    (async () => {
      try {
        const [cfg, lim] = await Promise.all([
          fetch("/api/rule-config", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ rule: "rateLimit", walletId }),
          }).then((r) => r.json()) as Promise<{ recipients?: { address: string }[] }>,
          readLimit(walletId),
        ]);
        const first = cfg.recipients?.[0]?.address;
        if (stop || !first || !lim || lim.cap === 0n) return;
        // Comfortably past the cap, so it reads as a deliberate overspend rather than a rounding argument.
        setOverspend({ recipient: first, xrp: Math.ceil(Number(lim.cap) / 1e6) * 3 });
      } catch { /* the extra button just won't appear */ }
    })();
    return () => { stop = true; };
  }, [rule, walletId]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string; label: string } | null>(null);
  const [blocked, setBlocked] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try { setBlocked(Number(localStorage.getItem(`kl_blocked_${walletId}`) || 0)); } catch { /* no storage */ }
  }, [walletId]);

  const run = async (recip: string, xrp: number, label: string, destTag = 0) => {
    setBusy(true);
    setResult(null);
    const v = await dryRunAuthorize(rule, walletId, recip, BigInt(Math.round(xrp * 1e6)), destTag);
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

  const tryOverspend = () => {
    if (!overspend) return;
    run(overspend.recipient, overspend.xrp, `${overspend.xrp} XRP → ${addr(overspend.recipient)} (approved)`);
  };

  const custom = () => {
    if (!XRPL_ADDRESS_RE.test(to.trim())) return alert("Enter a valid XRPL r-address.");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return alert("Enter an amount in XRP.");
    run(to.trim(), n, `${n} XRP → ${addr(to.trim())}`, Number(tag.trim() || 0));
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
        {overspend && (
          <Button variant="ghost" onClick={tryOverspend} disabled={busy}>
            Try to overspend →
          </Button>
        )}
        <span className="text-[12px] text-mist-500">or test a specific payment</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="tag"
            inputMode="numeric"
            /* Prefilled from the policy but deliberately EDITABLE here, unlike the spend form: this panel
               exists to try what shouldn't work, and "same exchange, someone else's tag" is one of the
               attacks the pinning actually stops. Locking it would hide the thing worth showing. */
            title={pinnedTag !== undefined ? `Your policy pins this recipient to tag ${pinnedTag}. Change it and see what happens.` : "Destination tag, if the recipient uses one."}
            className="w-24"
          />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button variant="ghost" onClick={custom} disabled={busy}>Test</Button>
        </div>
      </div>
      {pinnedTag !== undefined && (
        /* Told, not filled in. An exchange deposit address is shared by every customer of that exchange —
           the tag is which account. So "right address, someone else's tag" is a real attack, and seeing it
           refused is the point of this panel. */
        <p className="mt-2 text-[11px] text-mist-500">
          Your policy pins this recipient to tag <span className="font-mono text-mist-400">{pinnedTag}</span>.
          Send it with any other tag — or none — and it&rsquo;s refused.
        </p>
      )}

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

/**
 * Copy that fits what this policy uses the panel FOR.
 *
 * A tester read "Spend" alongside "Try to break it" and asked for one of them to go, since they appeared
 * to do the same thing. They don't — this one really moves money — but on two policies it isn't a
 * discretionary spend at all: for Conditional it's how the payee finally gets paid, and for Scheduled it's
 * a manual run of something already due. Deleting it would have removed the payout; naming it properly is
 * what was actually wrong.
 */
const SPEND_COPY: Partial<Record<RuleKey, { title: string; blurb: string }>> = {
  escrow: {
    title: "Release the payment",
    blurb: "Once the condition is proven, this is how the payee is paid. Before then the rule refuses it — including to you.",
  },
  scheduled: {
    title: "Run a payment now",
    blurb: "Scheduled payments run on their own. Use this only to push a due one through early — the rule still refuses anything that isn't due.",
  },
};

function SpendPanel({ walletId, xrpl, ruleKey }: { walletId: `0x${string}`; xrpl: string; ruleKey: RuleKey }) {
  const { write, ensureFunded } = useKeyless();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [spendable, setSpendable] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string; tx?: string } | null>(null);
  const [tag, setTag] = useState("");
  const pinnedTag = usePinnedTag(ruleKey === "exchange", walletId, to);
  useEffect(() => {
    if (pinnedTag !== undefined) setTag(String(pinnedTag));
  }, [pinnedTag]);

  // On a spending limit the balance is NOT the ceiling — the policy is, and it's usually much lower. This
  // panel printed "this account can send 95 XRP" beside the amount box on an account whose rule allowed 7,
  // so the one number next to the button was the one that didn't apply. The allowance is shown further up
  // the page, but by the time you've scrolled to the amount field it's gone.
  const [limit, setLimit] = useState<LimitState | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (ruleKey !== "rateLimit") return;
    let stop = false;
    const read = () => readLimit(walletId)
      .then((l) => { if (!stop) { setLimit(l); setNow(Math.floor(Date.now() / 1000)); } })
      .catch(() => { /* transient — fall back to the balance ceiling */ });
    read();
    const poll = setInterval(read, 30_000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    const onChange = () => read();
    window.addEventListener("kl:config-changed", onChange);
    return () => {
      stop = true; clearInterval(poll); clearInterval(tick);
      window.removeEventListener("kl:config-changed", onChange);
    };
  }, [ruleKey, walletId]);

  // Hold the balance rather than checking it on submit: "you don't have that much" is only useful before
  // the click. XRPL keeps ~1 XRP as an unspendable base reserve, so it's never part of what can be sent.
  useEffect(() => {
    if (!xrpl) return;
    let stop = false;
    getXrplBalance(xrpl)
      .then((b) => { if (!stop) setSpendable(b.funded ? (b.drops > 1_000_000n ? b.drops - 1_000_000n : 0n) : 0n); })
      .catch(() => { /* unknown; the field just won't show a maximum */ });
    return () => { stop = true; };
  }, [xrpl]);

  const wanted = (() => { const n = Number(amount); return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : null; })();
  // Whichever runs out first. `policyBound` decides which explanation to give when it's exceeded — "you
  // don't have it" and "your rule won't allow it" are different problems with different fixes.
  const ceiling = limit !== null && (spendable === null || limit.left < spendable) ? limit.left : spendable;
  const policyBound = limit !== null && (spendable === null || limit.left < spendable);
  const over = wanted !== null && ceiling !== null && wanted > ceiling;

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

      // The top 4 bytes are the destination tag; the enclave sets XRPL's DestinationTag from them and
      // ExchangeRule checks them against the tag pinned to this recipient. This used to be 32 random
      // bytes, which meant a pinned recipient could never be paid and everyone else got a random tag.
      const ref = paymentRef(Number(tag.trim() || 0));
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "pay", args: [walletId, toClean, drops, ref], value: INIT_FEE });

      // On-chain authorization succeeded. The enclave now signs + submits async, so re-enable the form
      // and watch the ledger for the settled payment rather than leaving the user on "Authorized…" forever.
      setMsg({ tone: "info", text: "Authorized — the enclave is signing and submitting to XRPL. Confirming settlement…" });
      setTo(""); setAmount(""); setTag("");
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
      <h2 className="text-[15px] font-medium text-mist-100">{SPEND_COPY[ruleKey]?.title ?? "Spend"}</h2>
      <p className="mt-1 text-[13px] text-mist-400">
        {SPEND_COPY[ruleKey]?.blurb ?? "Runs your rule first. If it refuses, nothing leaves the account."}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient r-address" />
        <div className="flex gap-2">
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="tag"
            inputMode="numeric"
            readOnly={pinnedTag !== undefined}
            title={pinnedTag !== undefined ? "Your policy pins this recipient to this destination tag." : "Destination tag — exchanges need it to credit your deposit. Leave blank if the recipient doesn't use one."}
            className={`w-20 ${pinnedTag !== undefined ? "text-mist-400" : ""}`}
          />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-28" />
          <Button onClick={pay} disabled={busy || !xrpl || over}>{busy ? "…" : "Pay"}</Button>
        </div>
        {ceiling !== null && (
          <p className={`mt-1.5 text-[11px] ${over ? "text-refuse-500" : "text-mist-500"}`}>
            {over
              ? policyBound
                ? "That's more than your rule allows right now."
                : "That's more than this account can send."
              : <>This account can send <span className="text-mist-400">{formatDrops(ceiling)}</span></>}
            {ceiling > 0n && (
              <> · <button type="button" onClick={() => setAmount(String(Number(ceiling) / 1e6))} className="underline decoration-ink-600 underline-offset-2 hover:text-signal-400">use max</button></>
            )}
            {policyBound
              ? limit && limit.resetAt > 0 && !(limit.mode === 0 && limit.stale)
                ? <> · your allowance refills <span className="text-mist-400">{fmtIn(limit.resetAt, now)}</span></>
                : " · capped by your spending limit"
              : " · 1 XRP stays as the ledger reserve"}
          </p>
        )}
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
