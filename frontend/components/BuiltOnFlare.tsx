import { ADDRESSES, EXTENSION_ID, RULES, addr, explorerAddress } from "@/lib/keyless";

/**
 * What Keyless actually runs on, named — and only here.
 *
 * The rest of the product deliberately strips this vocabulary out: someone setting a spending limit
 * shouldn't have to meet the words "attestation" or "TEE" to do it. But stripping it everywhere left the
 * integrations invisible, so they get one unmissable place instead of a dusting through the flows.
 *
 * Ordered by how much weight each carries. Confidential Compute is first because nothing else here works
 * without it; the other three are things an ordinary contract could do. Every row links to live state on
 * Coston2, because a list of logos proves nothing.
 */

type Row = {
  role: string;
  name: string;
  what: string;
  link: { label: string; href: string };
};

const ROWS: Row[] = [
  {
    role: "The key",
    name: "Flare Confidential Compute",
    what:
      "Each account's XRPL key is generated inside a TEE and never leaves it — not to us, not to you. " +
      "It signs only what the on-chain rule authorizes. Everything else on this page assumes this one " +
      "holds; without it, Keyless would just be a contract asking a wallet nicely.",
    link: { label: `Extension ${EXTENSION_ID} · TEE manager ${addr(ADDRESSES.teeManager)}`, href: explorerAddress(ADDRESSES.teeManager) },
  },
  {
    role: "The trigger",
    name: "Flare Data Connector",
    what:
      "Turns a public API into a fact the chain can check. A Conditional account can pay nobody — not the " +
      "payee, not the person who funded it — until the FDC attests the condition. The whole request is " +
      "pinned on-chain, so a proof of some other API returning the same value can't be swapped in.",
    link: { label: `ConditionalRule ${addr(RULES.escrow)}`, href: explorerAddress(RULES.escrow) },
  },
  {
    role: "The bridge",
    name: "FAssets direct minting",
    what:
      "One tagged XRP payment mints FXRP on Flare. The destination is computed on-chain from the account " +
      "itself rather than configured, so a stolen control key cannot repoint the mint at a thief.",
    link: { label: `FxrpRule ${addr(RULES.fxrp)}`, href: explorerAddress(RULES.fxrp) },
  },
  {
    role: "The yield",
    name: "Flare Smart Accounts",
    what:
      "Where that FXRP lands and earns. The policy whitelists the instruction set — into a vault, out of a " +
      "vault, home to XRP — and leaves transfer-out of it entirely, so the FXRP has nowhere to go but back.",
    link: { label: `FSA diamond ${addr(ADDRESSES.fsaDiamond)}`, href: explorerAddress(ADDRESSES.fsaDiamond) },
  },
];

export function BuiltOnFlare() {
  return (
    <section className="mt-16">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal-400">Built on Flare</p>
      <h2 className="mt-4 max-w-3xl text-balance text-2xl font-medium leading-tight tracking-[-0.02em] text-mist-100 md:text-3xl">
        Four Flare pieces, each doing one job.
      </h2>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist-400">
        Listed in the order they carry weight. Every address below is live on Coston2 — click any of them
        rather than take this at face value.
      </p>

      <div className="mt-8 hairline overflow-hidden rounded-2xl border bg-ink-900/60">
        {ROWS.map((r, i) => (
          <div
            key={r.name}
            className={`grid gap-x-8 gap-y-3 p-6 md:grid-cols-[10rem_1fr] md:p-7 ${i > 0 ? "border-t hairline" : ""}`}
          >
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-mist-500">{r.role}</div>
              <div className="mt-1.5 text-[15px] font-medium leading-snug text-mist-100">{r.name}</div>
            </div>
            <div className="min-w-0">
              <p className="text-pretty text-[14px] leading-relaxed text-mist-400">{r.what}</p>
              <a
                href={r.link.href}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block break-all font-mono text-[12px] text-signal-400 underline decoration-ink-600 underline-offset-4 transition-colors hover:decoration-signal-500"
              >
                {r.link.label} ↗
              </a>
            </div>
          </div>
        ))}
      </div>

    </section>
  );
}
