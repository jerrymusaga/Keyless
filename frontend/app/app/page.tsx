"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useKeyless } from "@/components/app/KeylessProvider";
import { motion } from "motion/react";
import { Button, Card, Notice, Skeleton, Spinner } from "@/components/app/ui";
import { ControlKey } from "@/components/app/ControlKey";
import { listAccounts, type LocalAccount } from "@/lib/accounts";
import { publicClient } from "@/lib/clients";
import { ADDRESSES, ACCOUNTS_ABI, RULE_META, RULES, LEGACY_RULE_NAMES, addr, xrplAccount, ZERO_ADDRESS } from "@/lib/keyless";

type Row = LocalAccount & { rule: `0x${string}`; xrplAddress: string };

function ruleName(rule: string): string | null {
  const hit = (Object.keys(RULES) as (keyof typeof RULES)[]).find(
    (k) => RULES[k].toLowerCase() === rule.toLowerCase(),
  );
  // Fall back to older/retired rule deployments so those accounts still show their real policy name.
  return hit ? RULE_META[hit].name : (LEGACY_RULE_NAMES[rule.toLowerCase()] ?? null);
}

export default function AppHome() {
  const { status, address, balance, create } = useKeyless();
  const [rows, setRows] = useState<Row[] | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    const locals = listAccounts(address);
    const enriched = await Promise.all(
      locals.map(async (a) => {
        const rule = (await publicClient.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "ruleOf", args: [a.walletId] })) as `0x${string}`;
        // xrplAddressOf only exists on the writeback contract; tolerate its absence.
        const xrplAddress = (await publicClient
          .readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [a.walletId] })
          .catch(() => "")) as string;
        return { ...a, rule, xrplAddress };
      }),
    );
    setRows(enriched);
  }, [address]);

  useEffect(() => {
    if (status === "ready") load();
  }, [status, load]);

  if (status === "loading") {
    return <Spinner label="Loading your wallet…" />;
  }

  // No control key yet — the one-click onboarding.
  if (status === "none") {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="text-3xl font-medium tracking-[-0.02em] text-mist-100">Your XRP account, with rules.</h1>
        <p className="mt-4 leading-relaxed text-mist-400">
          Keyless makes a control key <span className="text-mist-200">in this browser</span> — yours, not ours. It signs
          your rule changes. The XRP itself is held by a key sealed in an enclave that can only pay where your rules allow.
        </p>
        <div className="mt-8">
          <Button onClick={create}>Create my Keyless wallet →</Button>
        </div>
        <p className="mt-4 text-xs text-mist-500">
          No extension, no seed phrase. Export your control key anytime to back it up. The XRP keys never leave the
          enclave — that&rsquo;s what keeps accounts undrainable.
        </p>
      </div>
    );
  }

  const lowGas = Number(balance) / 1e18 < 0.5;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.02em] text-mist-100">Your accounts</h1>
          <p className="mt-1 text-sm text-mist-400">Each account is an XRP wallet that only does what its policy allows.</p>
        </div>
        <Button href="/app/new">+ New account</Button>
      </div>

      {rows && rows.length > 0 && (
        <p className="mt-3 text-[13px] text-mist-500">
          <span className="text-mist-300">{rows.length}</span> account{rows.length !== 1 ? "s" : ""}
          {" · "}
          <span className="text-mist-300">{rows.filter((r) => r.rule !== ZERO_ADDRESS).length}</span> with a policy
        </p>
      )}

      {lowGas && (
        <div className="mt-6">
          <FundPrompt />
        </div>
      )}

      <div className="mt-8 space-y-3">
        {rows === null ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl border hairline bg-ink-900/60 p-5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-2.5 h-3 w-32" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Card>
            <p className="text-sm text-mist-400">
              You don&rsquo;t have any accounts yet. Create one and pick a rule — an exchange-only wallet, an
              agent allowance, a subscription, or a conditional payout.
            </p>
            <div className="mt-5">
              <Button href="/app/new">Create your first account →</Button>
            </div>
          </Card>
        ) : (
          rows.map((r, i) => (
            <motion.div
              key={r.walletId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
            >
              <AccountRow row={r} />
            </motion.div>
          ))
        )}
      </div>

      <div className="mt-10 border-t hairline pt-8">
        <ControlKey />
      </div>
    </div>
  );
}

function AccountRow({ row }: { row: Row }) {
  const name = ruleName(row.rule);
  const hasRule = row.rule !== ZERO_ADDRESS;
  const [blocked, setBlocked] = useState(0);
  useEffect(() => {
    try { setBlocked(Number(localStorage.getItem(`kl_blocked_${row.walletId}`) || 0)); } catch { /* no storage */ }
  }, [row.walletId]);
  return (
    <Link
      href={`/app/${row.walletId}`}
      className="block rounded-xl border hairline bg-ink-900/60 p-5 transition-colors hover:border-ink-600"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="truncate text-[15px] font-medium text-mist-100">{row.label}</span>
            {hasRule ? (
              <span className="rounded-full border border-signal-500/30 bg-signal-500/10 px-2 py-0.5 text-[11px] text-signal-300">
                {name ?? "custom policy"}
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[11px] text-amber-200/90">
                no rule yet
              </span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2.5 font-mono text-xs text-mist-500">
            {row.xrplAddress ? (
              <span title="XRPL deposit address (from chain)">{addr(row.xrplAddress)}</span>
            ) : (
              <span className="text-amber-200/70">provisioning XRPL address…</span>
            )}
            {blocked > 0 && (
              <span className="text-allow-500/90" title="Drain attempts this account refused">🛡️ {blocked} refused</span>
            )}
          </div>
        </div>
        <span className="text-mist-500">→</span>
      </div>
    </Link>
  );
}

function FundPrompt() {
  const { ensureFunded } = useKeyless();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "warn"; text: React.ReactNode } | null>(null);

  const fund = async () => {
    setBusy(true);
    setMsg(null);
    const r = await ensureFunded();
    setBusy(false);
    if (r.disabled) {
      setMsg({
        tone: "warn",
        text: (
          <>
            The gas sponsor isn&rsquo;t configured on this deployment. Fund your control key from the{" "}
            <a className="underline" href={r.faucet} target="_blank" rel="noreferrer">
              Coston2 faucet
            </a>{" "}
            to transact.
          </>
        ),
      });
    } else if (r.ok) {
      setMsg({ tone: "info", text: "Topped up. You can create and configure accounts." });
    }
  };

  return (
    <Notice tone="warn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>Your control key is low on gas — it needs a little C2FLR to sign Flare transactions.</span>
        <Button variant="ghost" onClick={fund} disabled={busy}>
          {busy ? "Funding…" : "Fund control key"}
        </Button>
      </div>
      {msg && <div className="mt-2">{msg.text}</div>}
    </Notice>
  );
}
