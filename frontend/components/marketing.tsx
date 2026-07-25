import Link from "next/link";
import { Reveal, StaggerGroup, StaggerItem } from "./motion";
import { RULE_META, type RuleKey } from "@/lib/keyless";

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal-400">{eyebrow}</p>
      <h2 className="mt-4 text-balance text-3xl font-medium tracking-[-0.02em] text-mist-100 md:text-4xl">{title}</h2>
      {sub && <p className="mt-4 text-pretty leading-relaxed text-mist-400">{sub}</p>}
    </Reveal>
  );
}

export function TrustBar() {
  return (
    <div className="border-y hairline bg-ink-900/40">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6 text-sm text-mist-500">
        <span className="text-mist-400">Built on</span>
        <span className="font-medium text-mist-200">Flare Confidential Compute</span>
        <span className="hidden text-ink-600 sm:inline">·</span>
        <span className="font-medium text-mist-200">The XRP Ledger</span>
        <span className="hidden text-ink-600 sm:inline">·</span>
        <span>No bridge. No wrapped token. Real XRP.</span>
      </div>
    </div>
  );
}

const ORDER: RuleKey[] = ["exchange", "rateLimit", "escrow"];

export function Features() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-24 md:py-32">
      <SectionHead
        eyebrow="One account, many jobs"
        title="Pick the rule your account obeys."
        sub="Every account is an XRP wallet whose key can only sign what its rule permits. Choose one when you create it — change it anytime, or lock it forever."
      />
      <StaggerGroup className="mt-14 grid gap-4 md:grid-cols-2">
        {ORDER.map((k) => (
          <StaggerItem key={k}>
            <div className="h-full rounded-2xl border hairline bg-ink-900/60 p-6 transition-colors hover:border-ink-600">
              <div className="flex items-center gap-3">
                <RuleIcon k={k} />
                <h3 className="text-base font-medium text-mist-100">{RULE_META[k].name}</h3>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-mist-400">{RULE_META[k].tagline}</p>
              <p className="mt-3 border-t hairline pt-3 text-[13px] text-signal-300/80">
                Protects against: <span className="text-mist-400">{RULE_META[k].protects}</span>
              </p>
            </div>
          </StaggerItem>
        ))}
      </StaggerGroup>
    </section>
  );
}

export function HowItWorks() {
  const steps = [
    { n: "1", t: "Create an account", d: "One click. The XRP key is generated inside a secure enclave — no seed phrase, no extension, and no human ever sees it." },
    { n: "2", t: "Pick a rule", d: "Exchange-only, an agent allowance, a subscription, a conditional payout. The rule is the account's entire security surface." },
    { n: "3", t: "It can't be drained", d: "The key can only ever sign what the rule allows. Lock the rule and not even your own control key can change it." },
  ];
  return (
    <section className="border-y hairline bg-ink-900/30">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 md:py-28">
        <SectionHead eyebrow="How it works" title="Live in three steps." />
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08}>
              <div className="rounded-2xl border hairline bg-ink-950/50 p-7">
                <div className="flex size-9 items-center justify-center rounded-full border border-signal-500/40 bg-signal-500/10 font-mono text-sm text-signal-300">
                  {s.n}
                </div>
                <h3 className="mt-5 text-lg font-medium text-mist-100">{s.t}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-mist-400">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SeeBand() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20">
      <Reveal className="relative overflow-hidden rounded-3xl border hairline bg-ink-900/60 px-8 py-12 text-center md:px-16 md:py-16">
        <div className="pointer-events-none absolute inset-0 aurora opacity-60" aria-hidden="true" />
        <div className="relative">
          <h2 className="text-balance text-2xl font-medium tracking-[-0.02em] text-mist-100 md:text-3xl">
            Don&rsquo;t take our word for it.
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-pretty leading-relaxed text-mist-400">
            Try to make a live rule pay a thief. The verdict comes straight from the real contract on Coston2 —
            no wallet, no signup.
          </p>
          <div className="mt-7">
            <Link
              href="/see"
              className="inline-flex items-center gap-2 rounded-xl bg-mist-100 px-6 py-3.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
            >
              Watch it refuse →
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export function Security() {
  const points = [
    { t: "The key never leaves the enclave", d: "It's generated inside a TEE on Flare and can't be exported — so there's nothing to phish, leak, or steal. You receive to it like any XRP account; you spend only through the rule." },
    { t: "The rules live on-chain", d: "Every payment runs the rule first, enforced by a contract, not a server. If the rule says no, the enclave is never even asked to sign." },
    { t: "Lock it and it's final", d: "Freeze an account's rule forever. After that, not even your own control key can repoint it or widen it — a thief who steals everything still can't move your funds." },
  ];
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-24 md:py-32">
      <SectionHead eyebrow="Why it can't be drained" title="The security isn't a promise. It's the architecture." />
      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {points.map((p, i) => (
          <Reveal key={p.t} delay={i * 0.08}>
            <div className="h-full rounded-2xl border hairline bg-ink-900/60 p-7">
              <div className="size-8">
                <ShieldMark />
              </div>
              <h3 className="mt-4 text-base font-medium text-mist-100">{p.t}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{p.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

export function FinalCTA() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-28 pt-8">
      <Reveal className="text-center">
        <h2 className="mx-auto max-w-2xl text-balance text-3xl font-medium tracking-[-0.02em] text-mist-100 md:text-5xl">
          An XRP account that can&rsquo;t be drained.
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-pretty leading-relaxed text-mist-400">
          The rules aren&rsquo;t for you. They&rsquo;re for whoever gets in.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/app" className="inline-flex items-center justify-center gap-2 rounded-xl bg-mist-100 px-7 py-3.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white">
            Create an account →
          </Link>
          <Link href="/see" className="inline-flex items-center justify-center gap-2 rounded-xl border hairline bg-ink-850/70 px-7 py-3.5 text-sm text-mist-200 transition-colors hover:border-ink-600 hover:text-mist-100">
            See it in action
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

function RuleIcon({ k }: { k: RuleKey }) {
  const map: Record<RuleKey, string> = { exchange: "🏦", rateLimit: "🤖", escrow: "📦" };
  return (
    <span className="flex size-9 items-center justify-center rounded-lg border hairline bg-ink-850 text-base" aria-hidden="true">
      {map[k]}
    </span>
  );
}

function ShieldMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-8" aria-hidden="true" fill="none">
      <path d="M12 3l7 2.5v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9v-5L12 3z" className="stroke-signal-500 stroke-[1.4]" />
      <path d="M9 12l2 2 4-4.2" className="stroke-signal-400 stroke-[1.5]" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
