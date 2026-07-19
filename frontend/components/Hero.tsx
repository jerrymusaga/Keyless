"use client";

import { motion, useReducedMotion } from "motion/react";
import { LiveBadge } from "./ui";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  const reduce = useReducedMotion();

  // Animate the hero in on load: each block rises in sequence.
  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.8, ease: EASE, delay },
        };

  return (
    <header className="relative overflow-hidden px-6 pb-24 pt-20 md:pb-32 md:pt-28">
      {/* Slowly breathing aurora behind the type. */}
      <motion.div
        className="pointer-events-none absolute inset-0 aurora"
        aria-hidden="true"
        initial={reduce ? false : { opacity: 0.7 }}
        animate={reduce ? undefined : { opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 12, ease: "easeInOut", repeat: Infinity }}
      />
      <div className="pointer-events-none absolute inset-0 grid-field" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-5xl">
        <motion.div className="flex items-center justify-between gap-4" {...rise(0)}>
          <div className="flex items-center gap-2.5">
            <KeyholeMark />
            <span className="font-mono text-sm tracking-[0.2em] text-mist-100">KEYLESS</span>
          </div>
          <LiveBadge />
        </motion.div>

        <h1 className="mt-16 max-w-4xl text-balance text-4xl font-medium leading-[1.08] tracking-[-0.03em] text-mist-100 md:mt-24 md:text-7xl">
          <motion.span className="block" {...rise(0.08)}>
            An XRP account
          </motion.span>
          <motion.span className="block" {...rise(0.18)}>
            that only does <span className="text-signal-500">what you allow.</span>
          </motion.span>
        </h1>

        <motion.p
          className="mt-8 max-w-2xl text-pretty text-lg leading-relaxed text-mist-400 md:text-xl"
          {...rise(0.32)}
        >
          The XRP Ledger has no smart contracts, so an XRP key is all-or-nothing. Keyless gives it{" "}
          <span className="text-mist-100">rules the key itself enforces</span> — generated and kept
          inside a TEE. Pay only these addresses, only this much, only for this: an exchange-only
          wallet, an allowance for an AI agent, a subscription that pays itself, a DAO treasury that
          stays native XRP.
        </motion.p>

        <motion.p
          className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-mist-300 md:text-xl"
          {...rise(0.42)}
        >
          Each of those is the same guarantee from a different side: the key can only do what the
          rules say. Steal it, hijack the app, poison the address — it still{" "}
          <span className="text-refuse-500">can&rsquo;t be drained.</span>{" "}
          <span className="text-mist-100">
            The rules aren&rsquo;t for you. They&rsquo;re for whoever gets in.
          </span>
        </motion.p>

        <motion.div
          className="mt-12 flex flex-col gap-3 sm:flex-row sm:items-center"
          {...rise(0.54)}
        >
          <a
            href="/app"
            className="group inline-flex items-center justify-center gap-2 rounded-lg bg-mist-100 px-5 py-3 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
          >
            Create an account
            <span className="text-ink-950/40 transition-transform group-hover:translate-x-0.5">→</span>
          </a>
          <a
            href="#refuse"
            className="inline-flex items-center justify-center gap-2 rounded-lg border hairline bg-ink-850/80 px-5 py-3 text-sm text-mist-300 transition-colors hover:border-ink-600 hover:text-mist-100"
          >
            Watch it refuse to be robbed
          </a>
        </motion.div>

        <motion.p className="mt-6 font-mono text-xs text-mist-500" {...rise(0.66)}>
          Real XRP. Real ledger. The key was born in the enclave — nobody has ever seen it.
        </motion.p>
      </div>
    </header>
  );
}

/** A keyhole whose shackle is open — the mark carries the whole thesis. */
function KeyholeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        d="M8 10V7a4 4 0 0 1 7.5-1.9"
        className="fill-none stroke-signal-500 stroke-[1.6]"
        strokeLinecap="round"
      />
      <rect x="4" y="10" width="16" height="11" rx="2.5" className="fill-none stroke-mist-100 stroke-[1.6]" />
      <circle cx="12" cy="15" r="1.6" className="fill-signal-500" />
      <path d="M12 16.6V18.2" className="stroke-signal-500 stroke-[1.6]" strokeLinecap="round" />
    </svg>
  );
}
