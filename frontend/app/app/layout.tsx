import type { Metadata } from "next";
import Link from "next/link";
import { KeylessProvider } from "@/components/app/KeylessProvider";
import { AppHeader } from "@/components/app/AppHeader";

export const metadata: Metadata = {
  title: "Keyless — your programmable XRP account",
  description: "Create an XRP account that only does what you allow. No extension, no seed phrase.",
};

/** Set NEXT_PUBLIC_FEEDBACK_URL in Vercel to a Tally / Google Form URL to show the feedback link. */
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

function TestnetBanner() {
  return (
    <div className="border-b border-amber-500/25 bg-amber-500/[0.08]">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-center gap-x-2.5 gap-y-1 px-6 py-1.5 text-center text-[11px] text-amber-200/90">
        <span>🧪 <span className="font-medium">Testnet</span> — Coston2 + XRPL Testnet · no real funds</span>
        <span className="text-amber-200/40">·</span>
        <span>Actively developed — expect breaking changes before mainnet</span>
        {FEEDBACK_URL && (
          <>
            <span className="text-amber-200/40">·</span>
            <a href={FEEDBACK_URL} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2 hover:text-amber-100">
              Give feedback →
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <KeylessProvider>
      <div className="min-h-dvh">
        <TestnetBanner />
        <AppHeader />
        <main className="mx-auto w-full max-w-4xl px-6 py-10 md:py-14">{children}</main>
        <footer className="mx-auto w-full max-w-4xl px-6 pb-12 pt-6 text-xs text-mist-500">
          <Link href="/" className="hover:text-mist-300">
            ← Keyless
          </Link>
          <span className="mx-2">·</span>
          Testnet (Coston2 + XRPL Testnet). Your control key lives in this browser.
        </footer>
      </div>
    </KeylessProvider>
  );
}
