"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

/** A small copy-to-clipboard button. Shows a brief "Copied" confirmation. */
export function Copy({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1300);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border hairline bg-ink-900 px-2 py-1 text-[11px] font-medium text-mist-400 transition-colors hover:text-mist-100 ${className}`}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

export function Button({
  children,
  onClick,
  href,
  variant = "primary",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles = {
    primary: "bg-mist-100 text-ink-950 hover:bg-white",
    ghost: "border hairline bg-ink-850/80 text-mist-300 hover:border-ink-600 hover:text-mist-100",
    danger: "border border-refuse-500/40 bg-refuse-500/5 text-refuse-500 hover:bg-refuse-500/10",
  }[variant];
  const cls = `${base} ${styles} ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border hairline bg-ink-900/60 p-6 ${className}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-mist-200">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-mist-500">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border hairline bg-ink-950 px-3.5 py-2.5 font-mono text-sm text-mist-100 outline-none transition-colors placeholder:text-mist-500 focus:border-signal-500/60 ${props.className ?? ""}`}
    />
  );
}

/**
 * A numeric text field that only accepts digits (and, when `decimal`, a single dot). We sanitize on
 * change rather than use `type="number"` — that type still allows "e"/"+"/"-", shows spinner arrows, and
 * returns "" for anything it considers invalid, which hides typos. Here, non-numeric keystrokes are just
 * dropped, so the value the caller holds is always a clean numeric string.
 */
export function NumberInput({
  value,
  onValueChange,
  decimal = false,
  ...props
}: { value: string; onValueChange: (v: string) => void; decimal?: boolean } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
>) {
  const sanitize = (raw: string) => {
    if (!decimal) return raw.replace(/[^0-9]/g, "");
    const cleaned = raw.replace(/[^0-9.]/g, "");
    const [whole, ...rest] = cleaned.split(".");
    return rest.length ? `${whole}.${rest.join("")}` : cleaned; // collapse any extra dots
  };
  return (
    <Input
      {...props}
      value={value}
      inputMode={decimal ? "decimal" : "numeric"}
      onChange={(e) => onValueChange(sanitize(e.target.value))}
    />
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
}) {
  const styles = {
    info: "border-ink-600 bg-ink-850/60 text-mist-300",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-200/90",
    error: "border-refuse-500/40 bg-refuse-500/5 text-refuse-500",
    ok: "border-allow-500/40 bg-allow-500/5 text-allow-500",
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-[13px] leading-relaxed ${styles}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-mist-400">
      <span className="size-3.5 animate-spin rounded-full border-2 border-ink-600 border-t-signal-500" />
      {label}
    </span>
  );
}
