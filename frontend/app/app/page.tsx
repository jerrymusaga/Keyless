"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useKeyless } from "@/components/app/KeylessProvider";
import { Button, Card, Notice, Spinner } from "@/components/app/ui";
import { ControlKey } from "@/components/app/ControlKey";
import { listAccounts, type LocalAccount } from "@/lib/accounts";
import { publicClient } from "@/lib/clients";
import { ADDRESSES, ACCOUNTS_ABI, RULE_META, RULES, addr, xrplAccount, ZERO_ADDRESS } from "@/lib/keyless";

type Row = LocalAccount & { rule: `0x${string}`; xrplAddress: string };

function ruleName(rule: string): string | null {
  const hit = (Object.keys(RULES) as (keyof typeof RULES)[]).find(
    (k) => RULES[k].toLowerCase() === rule.toLowerCase(),
  );
  return hit ? RULE_META[hit].name : null;
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
          Keyless creates a control key <span className="text-mist-200">in this browser</span> — you hold it,
          not us. It signs the rule changes for your accounts on Flare. The XRP itself is held by a key born
          inside a secure enclave that can only ever sign what your rules allow.
        </p>
        <div className="mt-8">
          <Button onClick={create}>Create my Keyless wallet →</Button>
        </div>
        <p className="mt-4 text-xs text-mist-500">
          No extension, no seed phrase to write down. Your <span className="text-mist-300">control key</span>{" "}
          stays in this browser and you can export it anytime to back it up. (Your XRP keys live in the
          enclave and are never exportable — that&rsquo;s what keeps the accounts undrainable.)
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
          <p className="mt-1 text-sm text-mist-400">Each account is an XRP wallet that only does what its rule allows.</p>
        </div>
        <Button href="/app/new">+ New account</Button>
      </div>

      <StatsBar />

      {lowGas && (
        <div className="mt-6">
          <FundPrompt />
        </div>
      )}

      <div className="mt-8 space-y-3">
        {rows === null ? (
          <Spinner label="Reading your accounts from Coston2…" />
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
          rows.map((r) => <AccountRow key={r.walletId} row={r} />)
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
                {name ?? "custom rule"}
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[11px] text-amber-200/90">
                no rule yet
              </span>
            )}
          </div>
          <div className="mt-1.5 font-mono text-xs text-mist-500">
            {row.xrplAddress ? (
              <span title="XRPL deposit address (from chain)">{addr(row.xrplAddress)}</span>
            ) : (
              <span className="text-amber-200/70">provisioning XRPL address…</span>
            )}
          </div>
        </div>
        <span className="text-mist-500">→</span>
      </div>
    </Link>
  );
}

function StatsBar() {
  const [s, setS] = useState<{ available: boolean; totalAccounts?: number } | null>(null);

  useEffect(() => {
    fetch("/api/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setS(d))
      .catch(() => {});
  }, []);

  // Hide entirely until the contract exposes the counter (pre-redeploy), so we never show a broken bar.
  if (s && !s.available) return null;

  return (
    <div className="mt-6 flex items-center gap-4 rounded-xl border hairline bg-ink-900/50 px-5 py-4">
      <div className="font-mono text-2xl text-mist-100">
        {s?.totalAccounts === undefined ? "—" : s.totalAccounts.toLocaleString()}
      </div>
      <div className="text-[13px] text-mist-400">
        Keyless accounts created on Coston2
        <span className="ml-2 font-mono text-[11px] text-mist-500">(live, on-chain)</span>
      </div>
    </div>
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
