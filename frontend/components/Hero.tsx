import { LiveBadge } from "./ui";

export function Hero() {
  return (
    <header className="relative overflow-hidden px-6 pb-24 pt-20 md:pb-32 md:pt-28">
      <div className="pointer-events-none absolute inset-0 aurora" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 grid-field" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <KeyholeMark />
            <span className="font-mono text-sm tracking-[0.2em] text-mist-100">KEYLESS</span>
          </div>
          <LiveBadge />
        </div>

        <h1 className="mt-16 max-w-4xl text-balance text-4xl font-medium leading-[1.08] tracking-[-0.03em] text-mist-100 md:mt-24 md:text-7xl">
          An FAssets agent{" "}
          <span className="text-mist-500">anyone can fund,</span>{" "}
          because the operator can&rsquo;t steal.
        </h1>

        <p className="mt-8 max-w-2xl text-pretty text-lg leading-relaxed text-mist-400 md:text-xl">
          Running an FAssets agent means holding a live XRPL key{" "}
          <em className="not-italic text-mist-300">and</em>{" "}
          being trusted with other people&rsquo;s collateral. Almost nobody clears both bars, so
          agents stay scarce and FXRP supply stays tight.
        </p>
        <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-mist-300 md:text-xl">
          Keyless puts the agent&rsquo;s XRPL account under an on-chain policy contract. The operator
          runs the machine and holds no key — so the question stops being{" "}
          <span className="text-mist-100">&ldquo;do you trust them?&rdquo;</span> and becomes{" "}
          <span className="text-mist-100">&ldquo;have you read the contract?&rdquo;</span>
        </p>

        <div className="mt-12 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href="#refuse"
            className="group inline-flex items-center justify-center gap-2 rounded-lg bg-mist-100 px-5 py-3 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
          >
            Try to make it steal
            <span className="text-ink-950/40 transition-transform group-hover:translate-x-0.5">→</span>
          </a>
          <a
            href="#control"
            className="inline-flex items-center justify-center gap-2 rounded-lg border hairline bg-ink-850/80 px-5 py-3 text-sm text-mist-300 transition-colors hover:border-ink-600 hover:text-mist-100"
          >
            See who&rsquo;s in control
          </a>
        </div>

        <p className="mt-6 font-mono text-xs text-mist-500">
          No wallet. No signature. The contract answers you directly.
        </p>
      </div>
    </header>
  );
}

/** A keyhole whose shackle is open — the mark carries the whole thesis. */
function KeyholeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        d="M8 10V7a4 4 0 0 1 7.5-1.9"
        className="fill-none stroke-signal-500 stroke-[1.6]"
        strokeLinecap="round"
      />
      <rect x="4" y="10" width="16" height="11" rx="2.5" className="fill-none stroke-mist-100 stroke-[1.6]" />
      <circle cx="12" cy="15" r="1.6" className="fill-signal-500" />
      <path d="M12 16.6V18.2" className="stroke-signal-500 stroke-[1.6]" strokeLinecap="round" />
    </svg>
  );
}
