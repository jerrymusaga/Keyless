"use client";

import { useEffect, useState } from "react";
import { ADDRESSES, EXTENSION_ID, explorerAddress } from "@/lib/keyless";
import { ExternalIcon } from "./ui";

/**
 * The machine serving the extension is read at view time, never hardcoded.
 *
 * The simulated enclave gets a new identity on every restart, and restarts don't coincide with deploys —
 * so both a constant and a build-time read would go stale silently and start pointing at a machine that
 * no longer serves the extension. /api/chain is uncached, so this is the address as of the moment you
 * looked. If the read fails, the link is omitted rather than shown stale.
 */
function useCurrentTeeMachine(): string | null {
  const [machine, setMachine] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/chain", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setMachine(d?.activeMachines?.[0] ?? null))
      .catch(() => {});
  }, []);

  return machine;
}

export function Footer() {
  const teeMachine = useCurrentTeeMachine();

  return (
    <footer className="border-t hairline px-6 py-16">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div className="max-w-sm">
            <div className="font-mono text-sm tracking-[0.2em] text-mist-100">KEYLESS</div>
            <p className="mt-3 text-[13px] leading-relaxed text-mist-400">
              An XRPL account that can only pay what an on-chain policy permits. The operator runs
              the machine and holds no key.
            </p>
            <p className="mt-4 text-xs text-mist-500">
              Built for Flare Summer Signal on Coston2 (chain 114). Simulated TEE platform, as
              accepted by Flare for this hackathon.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
                On-chain
              </div>
              <ul className="mt-3 space-y-2">
                <Link href={explorerAddress(ADDRESSES.accounts)} label="KeylessAccounts" />
                <Link href={explorerAddress(ADDRESSES.teeManager)} label="Flare TEE manager" />
                {teeMachine ? (
                  <Link href={explorerAddress(teeMachine)} label="TEE machine (live)" />
                ) : null}
              </ul>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
                Facts
              </div>
              <ul className="mt-3 space-y-2 font-mono text-[11px] text-mist-500">
                <li>extension {EXTENSION_ID}</li>
                <li>chain 114 — Coston2</li>
                <li>opType KEYLESS_XRP</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

function Link({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-baseline gap-1.5 text-[13px] text-mist-300 transition-colors hover:text-signal-400"
      >
        {label}
        <ExternalIcon />
      </a>
    </li>
  );
}
