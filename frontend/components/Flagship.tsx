import { Code, Panel, Section } from "./ui";

/**
 * Where this goes. The demo policy is an allowlist; the flagship policy reads
 * the redemption request itself, so the "allowlist" becomes the FAssets protocol.
 */

export function Flagship() {
  return (
    <Section
      index="04"
      eyebrow="The flagship"
      title="Swap the rule, and the agent runs itself."
      lede={
        <>
          The allowlist you just tested is the simplest policy we could write. The real one replaces
          it with a single question asked of the FAssets protocol:{" "}
          <span className="text-mist-300">is this the address and amount that this redemption
          actually requires?</span> Nothing else can be paid, by anyone, ever.
        </>
      }
    >
      <Panel className="overflow-hidden">
        <div className="border-b hairline bg-ink-850/50 px-5 py-3.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            KeylessRedemptionPolicy — the rule
          </span>
        </div>
        <div className="overflow-x-auto px-5 py-5 md:px-6">
          <pre className="font-mono text-[12.5px] leading-relaxed text-mist-300">
{`// The destination and amount are not supplied by the caller.
// They are read from the redemption request on-chain.
Redemption memory r = assetManager.redemptionRequestInfo(id);

if (recipient != r.paymentAddress)  revert PolicyRejected("wrong destination");
if (amount    != r.valueUBA - r.feeUBA) revert PolicyRejected("wrong amount");`}
          </pre>
        </div>
      </Panel>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Point title="No key to steal">
          The agent&rsquo;s XRPL key never leaves the enclave, and the enclave only signs what the
          redemption request already specifies.
        </Point>
        <Point title="No discretion to abuse">
          The operator cannot choose the destination — the protocol chose it. There is no
          &ldquo;retry with different details&rdquo; entrypoint, because that would be a hole
          straight through the policy.
        </Point>
        <Point title="Already future-proof">
          It reads <Code>valueUBA − feeUBA</Code> from <Code>redemptionRequestInfo()</Code>, so it
          survives the deprecation of redemption-by-lots.
        </Point>
      </div>

      <div className="mt-16 border-t hairline pt-12">
        <h3 className="text-2xl font-medium tracking-[-0.02em] text-mist-100 md:text-3xl">
          Why this becomes a business
        </h3>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist-400">
          An FAssets agent earns minting and redemption fees in proportion to the collateral behind
          it. Today the addressable collateral for any agent is{" "}
          <span className="text-mist-300">&ldquo;people who personally trust the operator&rdquo;</span> —
          which is a small number, and the reason agents are scarce. Remove the trust requirement and
          it becomes <span className="text-mist-300">&ldquo;anyone who wants yield.&rdquo;</span>
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Step n="1" title="Anyone deposits collateral">
            They don&rsquo;t need to know or trust whoever runs the box. They need to read one
            contract.
          </Step>
          <Step n="2" title="The agent earns fees">
            Keyless runs it under policy. Fees accrue exactly as they would for any agent.
          </Step>
          <Step n="3" title="Depositors get yield">
            Keyless takes a protocol cut. A model that only exists once the operator provably
            can&rsquo;t steal.
          </Step>
        </div>

        <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-mist-500">
          Stated honestly: this needs the governance agent whitelist, the revenue is post-mainnet,
          and it scales with FXRP volume — which is the very thing more trustworthy agents would
          help unlock. A redeemer never picks an agent (redemptions are FIFO); the point isn&rsquo;t
          that anyone chooses Keyless, it&rsquo;s that the queue has more agents in it that nobody
          had to trust.
        </p>
      </div>
    </Section>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border hairline bg-ink-900/50 p-5">
      <h3 className="text-sm font-medium text-mist-100">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border hairline bg-ink-900/50 p-5">
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-xs text-signal-500">{n}</span>
        <h4 className="text-sm font-medium text-mist-100">{title}</h4>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{children}</p>
    </div>
  );
}
