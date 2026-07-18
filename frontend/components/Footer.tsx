import { ADDRESSES, EXTENSION_ID, explorerAddress } from "@/lib/keyless";
import { ExternalIcon } from "./ui";

export function Footer() {
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
                <Link href={explorerAddress(ADDRESSES.policy)} label="Policy contract" />
                <Link href={explorerAddress(ADDRESSES.teeManager)} label="Flare TEE manager" />
                <Link href={explorerAddress(ADDRESSES.teeMachine)} label="TEE machine" />
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
