import { Section, Panel } from "./ui";
import { StaggerGroup, StaggerItem } from "./motion";
import { RULES, EXPLORER } from "@/lib/keyless";

/**
 * The product, made concrete. Each card is a rule you can put on a wallet, framed
 * by the adversary it defeats — because a rule you'd never break yourself only
 * earns its keep against someone who would. Every rule is one readable contract.
 */

type Template = {
  name: string;
  tag: string;
  rule: string;
  adversary: string;
  ruleAddr: string;
  ruleName: string;
  glyph: React.ReactNode;
};

const TEMPLATES: Template[] = [
  {
    name: "Exchange-only",
    tag: "for anyone holding XRP",
    rule: "Pays your exchange deposit address. Nothing else, ever.",
    adversary: "Address-poisoning malware swaps the paste. A careful human still approves the wrong address — the allowlist doesn't.",
    ruleAddr: RULES.allowlist,
    ruleName: "AllowlistRule",
    glyph: <GlyphShield />,
  },
  {
    name: "Agent wallet",
    tag: "for AI agents & bots",
    rule: "Spends freely — within an allowlist and a cap per window.",
    adversary: "A prompt-injected or hijacked agent tries to run. It can spend up to the limit; it cannot drain, and cannot pay anyone you didn't name.",
    ruleAddr: RULES.rateLimit,
    ruleName: "RateLimitRule",
    glyph: <GlyphBot />,
  },
  {
    name: "Subscription",
    tag: "for recurring billing",
    rule: "One merchant may pull up to a cap per period. You can cancel any time.",
    adversary: "A merchant tries to overcharge or redirect the pull. The rule caps it and pins the destination — they provably can't take more.",
    ruleAddr: RULES.subscription,
    ruleName: "SubscriptionRule",
    glyph: <GlyphCycle />,
  },
  {
    name: "Savings",
    tag: "for cold storage discipline",
    rule: "Only ever pays your own cold address.",
    adversary: "A 2 a.m. impulse — or a stolen key — points somewhere new. The wallet won't follow.",
    ruleAddr: RULES.allowlist,
    ruleName: "AllowlistRule",
    glyph: <GlyphVault />,
  },
];

export function Templates() {
  return (
    <Section
      id="templates"
      index="02"
      eyebrow="What you can build"
      title={
        <>
          Pick a rule. The key enforces it —{" "}
          <span className="text-mist-500">not the app, not you, not the operator.</span>
        </>
      }
      lede={
        <>
          A wallet points at one rule module: a single, readable contract that decides what it can
          pay. Swap the rule and the account behaves differently; the key never changes and never
          leaves the enclave. Here are four to start.
        </>
      }
    >
      <StaggerGroup className="grid gap-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <StaggerItem key={t.name}>
            <Panel className="group h-full p-6 transition-colors hover:border-ink-600">
              <div className="flex items-start justify-between gap-4">
                <div className="flex size-10 items-center justify-center rounded-lg border hairline bg-ink-850 text-signal-400">
                  {t.glyph}
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-500">
                  {t.tag}
                </span>
              </div>

              <h3 className="mt-5 text-lg font-medium text-mist-100">{t.name}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-mist-300">{t.rule}</p>

              <div className="mt-4 rounded-lg border-l-2 border-l-refuse-500/70 bg-ink-850/60 px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-refuse-500/90">
                  Protects against
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mist-400">{t.adversary}</p>
              </div>

              <a
                href={`${EXPLORER}/address/${t.ruleAddr}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-mist-500 underline decoration-ink-600 underline-offset-4 transition-colors hover:text-signal-400 hover:decoration-signal-500"
              >
                {t.ruleName} · read it on-chain →
              </a>
            </Panel>
          </StaggerItem>
        ))}
      </StaggerGroup>

      <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-mist-500">
        The rule interface is open — anyone can write one. A rule governs only its own wallet, so a
        bad rule is self-harm, never someone else&rsquo;s funds. That&rsquo;s the platform:{" "}
        <span className="text-mist-300">the account is fixed, the rules are yours.</span>
      </p>
    </Section>
  );
}

function GlyphShield() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
      <path d="M10 2.5l6 2v4.5c0 4-2.6 6.4-6 8-3.4-1.6-6-4-6-8V4.5l6-2z" strokeLinejoin="round" />
      <path d="M7.5 10l1.8 1.8L13 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GlyphBot() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
      <rect x="4" y="7" width="12" height="9" rx="2" strokeLinejoin="round" />
      <path d="M10 4.5V7M7.5 11h.01M12.5 11h.01" strokeLinecap="round" />
      <circle cx="10" cy="4" r="1.2" />
    </svg>
  );
}
function GlyphCycle() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
      <path d="M4 10a6 6 0 0 1 10-4.5M16 10a6 6 0 0 1-10 4.5" strokeLinecap="round" />
      <path d="M14 3v2.8h-2.8M6 17v-2.8h2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GlyphVault() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 4v1.4M10 14.6V16" strokeLinecap="round" />
    </svg>
  );
}
