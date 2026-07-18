import {
  ALLOWLISTED_RECIPIENT,
  ENCLAVE_XRPL_ACCOUNT,
  PAYMENT_EVIDENCE,
  xrplAccount,
} from "@/lib/keyless";
import { Callout, ExternalIcon, Panel, Section } from "./ui";

/**
 * The payment that already happened. Deliberately framed as recorded, with the
 * arithmetic shown, because the ledger is checkable by anyone and overclaiming
 * here would undermine everything the rest of the page earns.
 */

const { fundedDrops, sentDrops, xrplFeeDrops, enclaveBalanceAfterDrops } = PAYMENT_EVIDENCE;

export function Evidence() {
  return (
    <Section
      id="evidence"
      index="04"
      eyebrow="Watch it pay"
      title={<>15 real XRP, moved by a contract&rsquo;s decision.</>}
      lede={
        <>
          The refusal above is live. This part is a recording — and the difference matters, so
          here it is plainly: the enclave holds its key in memory only, and the machine that ran
          this payment is gone. The key went with it. What survives is the ledger, which is the
          part you shouldn&rsquo;t have to take our word for anyway.
        </>
      }
    >
      <Panel className="overflow-hidden">
        <div className="border-b hairline bg-ink-850/50 px-5 py-3.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            XRPL testnet — verify every number below
          </span>
        </div>

        <div className="grid gap-px bg-ink-800 md:grid-cols-2">
          <Ledger
            role="From — the enclave"
            account={ENCLAVE_XRPL_ACCOUNT}
            note="Key generated inside the TEE. No human ever saw the seed."
            before={fundedDrops}
            after={enclaveBalanceAfterDrops}
          />
          <Ledger
            role="To — the allowlisted destination"
            account={ALLOWLISTED_RECIPIENT}
            note="The one address the policy permits."
            before={0n}
            after={sentDrops}
          />
        </div>

        <div className="border-t hairline px-5 py-5 md:px-6">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            The arithmetic closes exactly
          </div>
          <div className="mt-3 overflow-x-auto">
            <div className="flex items-center gap-2 whitespace-nowrap font-mono text-sm">
              <Num v={fundedDrops} label="funded" />
              <Op>−</Op>
              <Num v={sentDrops} label="sent" tone="signal" />
              <Op>−</Op>
              <Num v={xrplFeeDrops} label="XRPL fee" />
              <Op>=</Op>
              <Num v={enclaveBalanceAfterDrops} label="remaining" tone="allow" />
            </div>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-mist-400">
            No rounding, no reconciliation, no trust required: the enclave&rsquo;s balance fell by
            precisely the amount the contract authorized, plus the ledger&rsquo;s own 12-drop fee.
          </p>
        </div>
      </Panel>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Callout title="What the TEE does and doesn’t buy us" tone="warn">
          Honestly stated: there are <span className="text-mist-300">no private inputs</span>{" "}
          here — redemption data is public. The enclave buys key custody and code integrity: the key
          is born inside it, and the code hash is pinned on-chain. We don&rsquo;t claim input
          privacy, because we don&rsquo;t have it.
        </Callout>
        <Callout title="Why a recording, not a live button">
          Re-running this needs the enclave stack back up, and Flare has said Confidential Compute
          on Coston2 is being reworked. Rather than stake the demo on infrastructure we don&rsquo;t
          control, the live half of this page is the half that runs on permanent chain state.
        </Callout>
      </div>
    </Section>
  );
}

function Ledger({
  role,
  account,
  note,
  before,
  after,
}: {
  role: string;
  account: string;
  note: string;
  before: bigint;
  after: bigint;
}) {
  const rose = after > before;
  return (
    <div className="bg-ink-900 p-5 md:p-6">
      <div className="text-[13px] text-mist-400">{role}</div>
      <a
        href={xrplAccount(account)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-baseline gap-1.5 break-all font-mono text-[13px] text-signal-400 underline decoration-ink-600 underline-offset-4 transition-colors hover:decoration-signal-500"
      >
        {account}
        <ExternalIcon />
      </a>
      <p className="mt-2 text-xs leading-relaxed text-mist-500">{note}</p>

      <div className="mt-5 flex items-center gap-3 font-mono text-sm">
        <span className="text-mist-500">{fmt(before)}</span>
        <span className="text-mist-600">→</span>
        <span className={rose ? "text-allow-500" : "text-mist-100"}>{fmt(after)}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-mist-500">drops</div>
    </div>
  );
}

function Num({ v, label, tone = "default" }: { v: bigint; label: string; tone?: "default" | "signal" | "allow" }) {
  const c = tone === "signal" ? "text-signal-400" : tone === "allow" ? "text-allow-500" : "text-mist-100";
  return (
    <span className="inline-flex flex-col items-end">
      <span className={`tabular-nums ${c}`}>{fmt(v)}</span>
      <span className="text-[10px] text-mist-500">{label}</span>
    </span>
  );
}

function Op({ children }: { children: React.ReactNode }) {
  return <span className="pb-3.5 text-mist-500">{children}</span>;
}

function fmt(v: bigint) {
  return v.toLocaleString("en-US");
}
