"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, Input } from "@/components/app/ui";
import { DEMOS, dryRunAuthorize, type Demo, type Scenario, type Verdict } from "@/lib/showcase";
import { explorerAddress, addr, XRPL_ADDRESS_RE } from "@/lib/keyless";

export default function SeePage() {
  return (
    <main className="min-h-dvh">
      <header className="border-b hairline bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3.5">
          <Link href="/" className="flex items-center gap-2.5">
            <KeyholeMark />
            <span className="font-mono text-sm tracking-[0.18em] text-mist-100">KEYLESS</span>
          </Link>
          <Link href="/app" className="rounded-lg bg-mist-100 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-white">
            Create your own →
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-6 py-12 md:py-16">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal-400">Try it — no wallet, no signup</p>
        <h1 className="mt-4 max-w-3xl text-balance text-3xl font-medium leading-[1.1] tracking-[-0.02em] text-mist-100 md:text-5xl">
          Watch the rules refuse a payment they aren&rsquo;t allowed to make.
        </h1>
        <p className="mt-5 max-w-2xl text-pretty leading-relaxed text-mist-400">
          Every verdict below is computed by the <span className="text-mist-200">real rule contract live on Coston2</span> —
          not a mockup. Each attempt is a read-only check against the deployed rule: no gas, no wallet, nothing moves.
          Try the presets, or type your own and try to break it.
        </p>

        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {DEMOS.map((d) => (
            <DemoPanel key={d.key} demo={d} />
          ))}
        </div>

        <div className="mt-14 rounded-2xl border hairline bg-ink-900/60 p-8 text-center">
          <h2 className="text-xl font-medium text-mist-100">Convinced? Make your own in a minute.</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-mist-400">
            Create an XRP account, pick a rule, and it&rsquo;s yours — the key stays in the enclave, and it can only
            ever do what you allow.
          </p>
          <div className="mt-6">
            <Button href="/app">Create an account →</Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function DemoPanel({ demo }: { demo: Demo }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<(Verdict & { label: string }) | null>(null);

  const run = async (recip: string, amt: number, label: string) => {
    setBusy(true);
    setVerdict(null);
    const drops = BigInt(Math.max(0, Math.round(amt * 1e6)));
    const v = await dryRunAuthorize(demo.rule, demo.walletId, recip, drops);
    setVerdict({ ...v, label });
    setBusy(false);
  };

  const preset = (s: Scenario) => run(s.recipient, s.amountXrp, s.label);
  const custom = () => {
    if (!XRPL_ADDRESS_RE.test(recipient.trim())) return alert("Enter a valid XRPL r-address.");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return alert("Enter an amount in XRP.");
    run(recipient.trim(), n, `Pay ${n} XRP → ${addr(recipient.trim())}`);
  };

  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-medium text-mist-100">{demo.name}</h3>
        <a href={explorerAddress(demo.rule)} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-mist-500 hover:text-signal-300">
          real rule ↗
        </a>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{demo.scene}</p>
      <p className="mt-1.5 text-[12px] text-mist-500">{demo.config}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {demo.presets.map((s) => (
          <button
            key={s.label}
            onClick={() => preset(s)}
            disabled={busy}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${
              s.attack
                ? "border-refuse-500/30 bg-refuse-500/5 text-refuse-400 hover:bg-refuse-500/10"
                : "border-allow-500/30 bg-allow-500/5 text-allow-500 hover:bg-allow-500/10"
            }`}
          >
            {s.attack ? "✗ " : "✓ "}{s.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Any r-address…" className="text-[12px]" />
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XRP" inputMode="decimal" className="w-20 text-[12px]" />
        <Button variant="ghost" onClick={custom} disabled={busy}>Try</Button>
      </div>

      <div className="mt-4 min-h-[52px]">
        {busy ? (
          <div className="text-[13px] text-mist-500">Asking the rule on Coston2…</div>
        ) : verdict ? (
          <div
            className={`rounded-lg border px-3.5 py-3 text-[13px] ${
              verdict.allowed
                ? "border-allow-500/40 bg-allow-500/5 text-allow-500"
                : "border-refuse-500/40 bg-refuse-500/5 text-refuse-400"
            }`}
          >
            <div className="font-medium">
              {verdict.allowed ? "✓ Accepted" : "✗ Refused"} — <span className="font-normal opacity-90">{verdict.label}</span>
            </div>
            <div className="mt-0.5 opacity-90">
              {verdict.allowed
                ? "The rule permits it — the enclave would sign and send."
                : `The rule blocked it: “${verdict.reason ?? "not permitted"}”. Nothing leaves the account.`}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-mist-500">Pick a scenario above — the refusal is the interesting part.</div>
        )}
      </div>
    </Card>
  );
}

function KeyholeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path d="M8 10V7a4 4 0 0 1 7.5-1.9" className="fill-none stroke-signal-500 stroke-[1.6]" strokeLinecap="round" />
      <rect x="4" y="10" width="16" height="11" rx="2.5" className="fill-none stroke-mist-100 stroke-[1.6]" />
      <circle cx="12" cy="15" r="1.6" className="fill-signal-500" />
      <path d="M12 16.6V18.2" className="stroke-signal-500 stroke-[1.6]" strokeLinecap="round" />
    </svg>
  );
}
