import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-mono-stack",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Keyless — an FAssets agent nobody has to trust",
  description:
    "The operator runs the machine but holds no key. An XRPL account governed by an on-chain policy contract, so an FAssets agent can be funded by anyone — because the operator provably cannot steal.",
  openGraph: {
    title: "Keyless — an FAssets agent nobody has to trust",
    description:
      "Watch a live policy contract refuse to pay an address it doesn't allow. No wallet needed.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Keyless — an FAssets agent nobody has to trust",
    description:
      "Watch a live policy contract refuse to pay an address it doesn't allow. No wallet needed.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
