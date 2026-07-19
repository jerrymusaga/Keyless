import type { Metadata } from "next";
import Link from "next/link";
import { KeylessProvider } from "@/components/app/KeylessProvider";
import { AppHeader } from "@/components/app/AppHeader";

export const metadata: Metadata = {
  title: "Keyless — your programmable XRP account",
  description: "Create an XRP account that only does what you allow. No extension, no seed phrase.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <KeylessProvider>
      <div className="min-h-dvh">
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
