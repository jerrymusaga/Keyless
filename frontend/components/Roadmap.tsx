import { Code, Section } from "./ui";
import { StaggerGroup, StaggerItem, Reveal } from "./motion";
import { EXPLORER } from "@/lib/keyless";

/**
 * Where this goes. Not a wishlist — a consequence of the architecture. A new
 * capability is one new rule contract; the key, the enclave, and the account
 * never change. Each item below is a thing native XRP structurally cannot do
 * today, made possible by the same primitive already running.
 */

export function Roadmap() {
  return (
    <Section
      id="roadmap"
      index="05"
      eyebrow="Where this goes"
      title="Three things XRP couldn't do yesterday."
      lede={
        <>
          A new capability is one new rule contract — the key, the enclave, and the account never
          change. Because the rules live on Flare, they can depend on things the XRP Ledger cannot
          see. Same wallet, new brain.
        </>
      }
    >
      <StaggerGroup className="grid gap-4 md:grid-cols-3">
        <StaggerItem>
          <Card
            title="Payments that react to the world"
            body={
              <>
                XRPL escrow does time-locks and hash-locks — nothing else. A rule on Flare can gate a
                payment on an <Code>FTSO</Code> price or an <Code>FDC</Code>-attested real-world
                event: pay the supplier when delivery is proven, release when a price is hit.
              </>
            }
          />
        </StaggerItem>
        <StaggerItem>
          <Card
            title="Wallets for AI agents"
            body={
              <>
                Give an autonomous agent an XRP account it can spend from but can never drain — an
                allowlist and a cap it cannot exceed, even prompt-injected or hijacked. The wallet
                the coming agent economy needs, on the ledger the assets already live on.
              </>
            }
          />
        </StaggerItem>
        <StaggerItem>
          <Card
            title="DAO-controlled XRP"
            body={
              <>
                A DAO on Flare votes; native XRP moves on XRPL. No wrapped asset, no bridge, no
                custodian — the treasury stays real XRP, and a contract decides what it can pay.
              </>
            }
          />
        </StaggerItem>
      </StaggerGroup>

      <Reveal className="mt-16 border-t hairline pt-12">
        <h3 className="text-2xl font-medium tracking-[-0.02em] text-mist-100 md:text-3xl">
          Why it stays this cheap to extend
        </h3>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist-400">
          The enclave is a keyring: it signs whatever payment a wallet&rsquo;s rule authorizes, and
          nothing else. So a new product isn&rsquo;t a new TEE workload — it&rsquo;s{" "}
          <span className="text-mist-300">one Solidity contract</span> a wallet can point at. The
          hard part (a key that can only ever obey a contract, on a chain with no contracts) is
          already built and running.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Step n="1" title="The account is fixed">
            One key per wallet, born in the enclave, bound to Flare&rsquo;s TEE. It never leaves and
            never changes.
          </Step>
          <Step n="2" title="The rules are open">
            Anyone can write a rule module. It governs only its own wallet, so a bad rule is
            self-harm — never someone else&rsquo;s funds.
          </Step>
          <Step n="3" title="Composition is the moat">
            Conditions come from Flare — FTSO, FDC — and settle as native XRP on XRPL. Nobody else can
            do that without moving the asset off its ledger.
          </Step>
        </div>

        <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-mist-500">
          Stated plainly: the three above are roadmap, not shipped. What is shipped — the account,
          the keyring, the rule engine, a real payment that refused to be redirected — is{" "}
          <a
            href={`${EXPLORER}/address/0x0020014c038610E8062A6F4BFF62ea1f08dC01A7`}
            target="_blank"
            rel="noreferrer"
            className="text-mist-300 underline decoration-ink-600 underline-offset-4 hover:decoration-signal-500"
          >
            live on Coston2
          </a>{" "}
          and checkable above.
        </p>
      </Reveal>
    </Section>
  );
}

function Card({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="h-full rounded-xl border hairline bg-ink-900/50 p-6">
      <h3 className="text-[15px] font-medium text-mist-100">{title}</h3>
      <p className="mt-2.5 text-[13px] leading-relaxed text-mist-400">{body}</p>
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
