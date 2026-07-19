"use client";

import Link from "next/link";
import { useKeyless } from "./KeylessProvider";
import { addr, explorerAddress } from "@/lib/keyless";

/** App header: the Keyless mark, and — once you have a control key — its identity chip and gas balance. */
export function AppHeader() {
  const { status, address, balance } = useKeyless();
  const flr = Number(balance) / 1e18;

  return (
    <header className="sticky top-0 z-20 border-b hairline bg-ink-950/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3.5">
        <Link href="/app" className="flex items-center gap-2.5">
          <KeyholeMark />
          <span className="font-mono text-sm tracking-[0.18em] text-mist-100">KEYLESS</span>
        </Link>

        {status === "ready" && address && (
          <div className="flex items-center gap-3">
            <span
              className={`hidden font-mono text-[11px] sm:inline ${flr < 0.5 ? "text-refuse-500" : "text-mist-500"}`}
              title="Gas balance of your control key"
            >
              {flr.toLocaleString(undefined, { maximumFractionDigits: 2 })} C2FLR
            </span>
            <a
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border hairline bg-ink-850 px-3 py-1.5 font-mono text-[11px] text-mist-300 transition-colors hover:text-mist-100"
              title="Your control key (held in this browser)"
            >
              {addr(address)}
            </a>
          </div>
        )}
      </div>
    </header>
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
