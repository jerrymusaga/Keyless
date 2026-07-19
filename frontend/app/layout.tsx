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
  title: "Keyless — an XRP account that only does what you allow",
  description:
    "A programmable XRP account whose key is born inside a secure enclave and can only ever sign what your on-chain rules permit. Steal the key, hijack the app, poison the address — it still can't be drained.",
  openGraph: {
    title: "Keyless — an XRP account that only does what you allow",
    description:
      "The key is born in a TEE and can only sign what your rules permit. The rules aren't for you — they're for whoever gets in.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Keyless — an XRP account that only does what you allow",
    description:
      "The key is born in a TEE and can only sign what your rules permit. The rules aren't for you — they're for whoever gets in.",
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
