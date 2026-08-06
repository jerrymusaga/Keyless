import type { ReactNode } from "react";

export function Section({
  id,
  index,
  eyebrow,
  title,
  lede,
  children,
  className = "",
}: {
  id?: string;
  index?: string;
  eyebrow?: string;
  title?: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`relative border-t hairline px-6 py-24 md:py-32 ${className}`}>
      <div className="mx-auto w-full max-w-5xl">
        {(eyebrow || index) && (
          <div className="mb-5 flex items-center gap-3">
            {index && (
              <span className="font-mono text-xs tabular-nums text-signal-500">{index}</span>
            )}
            {eyebrow && (
              <span className="font-mono text-xs uppercase tracking-[0.18em] text-mist-500">
                {eyebrow}
              </span>
            )}
          </div>
        )}
        {title && (
          <h2 className="max-w-3xl text-balance text-3xl font-medium leading-[1.15] tracking-[-0.02em] text-mist-100 md:text-5xl">
            {title}
          </h2>
        )}
        {lede && (
          <div className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-mist-400 md:text-lg">
            {lede}
          </div>
        )}
        {children && <div className="mt-12">{children}</div>}
      </div>
    </section>
  );
}


/** A single on-chain fact. Monospace because it is data, not prose. */
export function Fact({
  label,
  value,
  href,
  mono = true,
  tone = "default",
  hint,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  mono?: boolean;
  tone?: "default" | "allow" | "signal";
  hint?: string;
}) {
  const toneClass =
    tone === "allow"
      ? "text-allow-500"
      : tone === "signal"
        ? "text-signal-400"
        : "text-mist-100";

  const body = (
    <span
      className={`${mono ? "font-mono text-[13px]" : "text-sm"} ${toneClass} ${
        href ? "underline decoration-ink-600 underline-offset-4 transition-colors hover:decoration-signal-500" : ""
      } break-all`}
    >
      {value}
    </span>
  );

  return (
    <div className="flex flex-col gap-1.5 border-b hairline py-4 last:border-b-0 md:flex-row md:items-baseline md:gap-6">
      <div className="w-full shrink-0 md:w-56">
        <div className="text-[13px] text-mist-400">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-snug text-mist-500">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-baseline gap-1.5">
            {body}
            <ExternalIcon />
          </a>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

export function ExternalIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 translate-y-px fill-none stroke-mist-500 stroke-[1.5]"
    >
      <path d="M4.5 1.5h6v6M10.5 1.5L4 8M8.5 7v3.5h-7v-9H5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LiveBadge({ label = "Live on Coston2" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border hairline bg-ink-850 px-3 py-1">
      <span className="live-dot size-1.5 rounded-full bg-signal-500" />
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-400">
        {label}
      </span>
    </span>
  );
}


export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border hairline bg-ink-850 px-1.5 py-0.5 font-mono text-[0.85em] text-signal-300">
      {children}
    </code>
  );
}
