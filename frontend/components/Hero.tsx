"use client";

import { motion, useReducedMotion } from "motion/react";
import { LiveBadge } from "./ui";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  const reduce = useReducedMotion();
  const rise = (delay: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.7, ease: EASE, delay } };

  return (
    <header className="relative overflow-hidden px-6 pb-20 pt-6 md:pb-28">
      <motion.div
        className="pointer-events-none absolute inset-0 aurora"
        aria-hidden="true"
        initial={reduce ? false : { opacity: 0.7 }}
        animate={reduce ? undefined : { opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 12, ease: "easeInOut", repeat: Infinity }}
      />
      <div className="pointer-events-none absolute inset-0 grid-field" aria-hidden="true" />

      {/* top nav */}
      <div className="relative mx-auto flex w-full max-w-6xl items-center justify-between py-4">
        <div className="flex items-center gap-2.5">
          <KeyholeMark />
          <span className="font-mono text-sm tracking-[0.2em] text-mist-100">KEYLESS</span>
        </div>
        <nav className="flex items-center gap-2">
          <a href="/see" className="hidden rounded-lg px-3.5 py-2 text-sm text-mist-300 transition-colors hover:text-mist-100 sm:inline-block">
            See it refuse
          </a>
          <a href="/app" className="rounded-lg bg-mist-100 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-white">
            Open app
          </a>
        </nav>
      </div>

      <div className="relative mx-auto mt-10 grid w-full max-w-6xl items-center gap-14 md:mt-16 lg:grid-cols-[1.05fr_1fr]">
        {/* left: copy */}
        <div>
          <motion.div {...rise(0)}>
            <LiveBadge label="Live on Coston2 testnet" />
          </motion.div>
          <motion.h1
            className="mt-6 text-balance text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-mist-100 md:text-6xl"
            {...rise(0.06)}
          >
            An XRP account that only does <span className="text-signal-400">what you allow.</span>
          </motion.h1>
          <motion.p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-mist-400" {...rise(0.14)}>
            The key is generated inside a secure enclave and never leaves. It can only ever sign what your
            on-chain rules permit — so steal the key, hijack the app, poison the address, and it still{" "}
            <span className="text-mist-200">can&rsquo;t be drained.</span>
          </motion.p>
          <motion.div className="mt-9 flex flex-col gap-3 sm:flex-row" {...rise(0.22)}>
            <a
              href="/app"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-mist-100 px-6 py-3.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
            >
              Create an account
              <span className="text-ink-950/40 transition-transform group-hover:translate-x-0.5">→</span>
            </a>
            <a
              href="/see"
              className="inline-flex items-center justify-center gap-2 rounded-xl border hairline bg-ink-850/70 px-6 py-3.5 text-sm text-mist-200 transition-colors hover:border-ink-600 hover:text-mist-100"
            >
              Watch it refuse a thief
            </a>
          </motion.div>
          <motion.p className="mt-6 font-mono text-xs text-mist-500" {...rise(0.3)}>
            No extension. No custodian. Built on Flare + the XRP Ledger.
          </motion.p>
        </div>

        {/* right: app mockup */}
        <motion.div
          className="relative"
          initial={reduce ? false : { opacity: 0, y: 24, scale: 0.98 }}
          animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}
        >
          <div className="pointer-events-none absolute -inset-8 -z-10 rounded-[2rem] bg-signal-500/10 blur-3xl" aria-hidden="true" />
          <AppMockup reduce={!!reduce} />
        </motion.div>
      </div>
    </header>
  );
}

function AppMockup({ reduce }: { reduce: boolean }) {
  const row = (delay: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, ease: EASE, delay } };

  return (
    <div className="overflow-hidden rounded-2xl border hairline bg-ink-900/90 shadow-2xl shadow-black/50 backdrop-blur-sm">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b hairline bg-ink-850/80 px-4 py-3">
        <span className="size-3 rounded-full bg-refuse-500/60" />
        <span className="size-3 rounded-full bg-warn-500/60" />
        <span className="size-3 rounded-full bg-allow-500/60" />
        <div className="ml-2 flex items-center gap-1.5 rounded-md bg-ink-800 px-2.5 py-1 font-mono text-[11px] text-mist-400">
          <span className="size-1.5 rounded-full bg-signal-500 live-dot" />
          keyless.app/account
        </div>
      </div>

      {/* account card */}
      <div className="space-y-4 p-5">
        <motion.div className="flex items-center justify-between" {...row(0.4)}>
          <div className="flex items-center gap-2.5">
            <KeyholeMark />
            <span className="text-sm font-medium text-mist-100">Exchange savings</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="rounded-full border border-signal-500/30 bg-signal-500/10 px-2 py-0.5 text-[10px] text-signal-300">Exchange-only</span>
            <span className="rounded-full border border-allow-500/30 bg-allow-500/10 px-2 py-0.5 text-[10px] text-allow-500">🔒 locked</span>
          </div>
        </motion.div>

        <motion.div className="rounded-xl border hairline bg-ink-950/60 p-4" {...row(0.5)}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-mist-500">Deposit address</span>
            <span className="text-[11px] text-mist-500">Balance</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="font-mono text-[13px] text-signal-300">rw15KUmE…wVDMC</span>
            <span className="font-mono text-[15px] text-mist-100">50,000 XRP</span>
          </div>
        </motion.div>

        {/* the can/can't card — the actual centrepiece of the account page */}
        <motion.div className="rounded-xl border border-signal-500/25 bg-signal-500/[0.04] p-4" {...row(0.56)}>
          <span className="text-[11px] text-mist-400">What this account can &amp; can&rsquo;t do</span>
          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] leading-snug">
            <span className="flex gap-1.5 text-mist-300"><span className="text-allow-500">✓</span>Pay your exchange</span>
            <span className="flex gap-1.5 text-mist-300"><span className="text-refuse-400">✕</span>Send anywhere else</span>
            <span className="flex gap-1.5 text-mist-300"><span className="text-allow-500">✓</span>Up to 5,000 XRP each</span>
            <span className="flex gap-1.5 text-mist-300"><span className="text-refuse-400">✕</span>Be drained — even if your key is stolen</span>
          </div>
        </motion.div>

        {/* the money shot: a refused spend */}
        <motion.div className="rounded-xl border hairline bg-ink-950/60 p-4" {...row(0.68)}>
          <span className="text-[11px] text-mist-500">Try to break it — someone with the key sends it elsewhere</span>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 rounded-lg border hairline bg-ink-900 px-3 py-2 font-mono text-[12px] text-mist-300">
              rF3x9…Att4cker
            </div>
            <div className="w-20 rounded-lg border hairline bg-ink-900 px-3 py-2 text-center font-mono text-[12px] text-mist-300">5,000</div>
            <div className="rounded-lg bg-mist-100 px-3.5 py-2 text-[12px] font-medium text-ink-950">Pay</div>
          </div>
          <motion.div
            className="mt-3 flex items-start gap-2 rounded-lg border border-refuse-500/40 bg-refuse-500/[0.07] px-3 py-2.5"
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={reduce ? undefined : { opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.9 }}
          >
            <span className="text-refuse-500">✗</span>
            <span className="text-[12px] leading-relaxed text-refuse-400">
              <span className="font-medium">Refused — recipient not allowed.</span> The enclave was never asked to
              sign. Nothing left the account.
            </span>
          </motion.div>
        </motion.div>
      </div>
    </div>
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
