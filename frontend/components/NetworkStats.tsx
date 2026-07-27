"use client";

import { useEffect, useState } from "react";

/**
 * Network-wide traction, shown on the public landing as social proof — but only once the numbers are
 * worth showing. Below the threshold it renders nothing, so a fresh launch ("2 accounts") never
 * undercuts the pitch. Counts come from on-chain counters via /api/stats.
 */
const THRESHOLD = 25; // minimum accounts-created before the bar appears

export function NetworkStats() {
  const [s, setS] = useState<{ available?: boolean; totalAccounts?: number; activeAccounts?: number } | null>(null);

  useEffect(() => {
    fetch("/api/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then(setS)
      .catch(() => {});
  }, []);

  if (!s?.available || (s.totalAccounts ?? 0) < THRESHOLD) return null;

  const stat = (value: number | undefined, label: string) => (
    <div className="px-6">
      <div className="font-mono text-2xl text-mist-100">{(value ?? 0).toLocaleString()}</div>
      <div className="mt-0.5 text-[12px] text-mist-400">{label}</div>
    </div>
  );

  return (
    <div className="border-b hairline bg-ink-900/40">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-y-3 divide-x divide-ink-800 px-6 py-5 text-center">
        {stat(s.totalAccounts, "Accounts created")}
        {stat(s.activeAccounts, "Active with a policy")}
        <span className="hidden pl-6 text-[11px] text-mist-500 sm:block">live on Coston2</span>
      </div>
    </div>
  );
}
