"use client";

import { useState } from "react";
import { ALLOWLISTED_RECIPIENT, EXPLORER, ADDRESSES } from "@/lib/keyless";
import { Callout, Code, Panel, Section } from "./ui";

/**
 * The money shot. A stranger types an address, the live contract refuses it.
 *
 * Everything here is an eth_call — no wallet, no gas, no state change — but the
 * verdict is produced by the deployed policy on Coston2, not by this page. We
 * could not fake a "yes" if we wanted to.
 */

type Result = {
  verdict: "allowed" | "rejected" | "error";
  reason: string;
  errorName?: string;
  instructionId?: string;
  preflight?: boolean;
};

/** A valid, well-formed XRPL address that is simply not on the allowlist. */
const OPERATOR_ADDRESS = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

export function Refuse() {
  const [recipient, setRecipient] = useState(OPERATOR_ADDRESS);
  const [amount, setAmount] = useState("15000000");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);

  async function ask() {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient, amountDrops: amount }),
      });
      const json = await res.json();
      setResult(
        json.ok
          ? { verdict: json.verdict, reason: json.reason, errorName: json.errorName, instructionId: json.instructionId, preflight: json.preflight }
          : { verdict: "error", reason: json.error ?? "Request failed." },
      );
    } catch (e) {
      setResult({ verdict: "error", reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Section
      id="refuse"
      index="03"
      eyebrow="Watch it refuse"
      title="You are the operator. Try to pay yourself."
      lede={
        <>
          Imagine you have root on the machine and every credential on the box. Ask the enclave to
          send 15 XRP somewhere it isn&rsquo;t allowed to send it. The answer below comes from the
          policy contract deployed on Coston2 — this page cannot talk it into a yes.
        </>
      }
    >
      <Panel className="overflow-hidden">
        <div className="border-b hairline bg-ink-850/50 px-5 py-3.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            policy.pay(recipient, amount, reference)
          </span>
        </div>

        <div className="p-5 md:p-6">
          <label className="block font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            Destination
          </label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            spellCheck={false}
            className="mt-2 w-full rounded-lg border hairline bg-ink-950 px-4 py-3 font-mono text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60"
            placeholder="r…"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <Preset
              active={recipient === OPERATOR_ADDRESS}
              onClick={() => setRecipient(OPERATOR_ADDRESS)}
              label="Your own address"
              tone="refuse"
            />
            <Preset
              active={recipient === ALLOWLISTED_RECIPIENT}
              onClick={() => setRecipient(ALLOWLISTED_RECIPIENT)}
              label="The allowlisted destination"
              tone="allow"
            />
            <span className="self-center font-mono text-[11px] text-mist-500">
              …or paste any XRPL address you like
            </span>
          </div>

          <label className="mt-6 block font-mono text-[11px] uppercase tracking-[0.14em] text-mist-500">
            Amount (drops)
          </label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            className="mt-2 block w-full rounded-lg border hairline bg-ink-950 px-4 py-3 font-mono text-sm text-mist-100 outline-none transition-colors focus:border-signal-500/60 md:w-64"
          />

          <button
            onClick={ask}
            disabled={pending}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-mist-100 px-5 py-3 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-60 md:w-auto"
          >
            {pending ? "Asking the contract…" : "Order the enclave to pay"}
          </button>

          {result && <Verdict result={result} />}
        </div>
      </Panel>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Callout title="Why this is the whole product">
          A refusal here isn&rsquo;t a permission check in a web app — it happens before any
          instruction exists. The enclave never sees the request, so there is nothing for a
          compromised operator to replay, retry, or leak. The payment is not blocked; it is{" "}
          <span className="text-mist-300">unrepresentable</span>.
        </Callout>
        <Callout title="Read the rule yourself" tone="note">
          The entire security argument is two lines of{" "}
          <Code>_checkPolicy</Code> in{" "}
          <a
            href={`${EXPLORER}/address/${ADDRESSES.policy}`}
            target="_blank"
            rel="noreferrer"
            className="text-signal-400 underline decoration-ink-600 underline-offset-4"
          >
            the deployed contract
          </a>
          . Not a whitepaper, not an audit you have to trust — a rule you can read in ten seconds.
        </Callout>
      </div>
    </Section>
  );
}

function Preset({
  label,
  onClick,
  active,
  tone,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  tone: "allow" | "refuse";
}) {
  const dot = tone === "allow" ? "bg-allow-500" : "bg-refuse-500";
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
        active
          ? "border-ink-600 bg-ink-800 text-mist-100"
          : "hairline bg-ink-900 text-mist-400 hover:border-ink-600 hover:text-mist-300"
      }`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </button>
  );
}

function Verdict({ result }: { result: Result }) {
  if (result.verdict === "rejected") {
    return (
      <div className="rise mt-6 overflow-hidden rounded-lg border border-refuse-500/30 bg-refuse-500/[0.06]">
        <div className="flex items-center gap-2.5 border-b border-refuse-500/20 px-5 py-3">
          <CrossIcon />
          <span className="font-mono text-xs uppercase tracking-[0.14em] text-refuse-500">
            Transaction reverted on-chain
          </span>
        </div>
        <div className="px-5 py-4">
          <div className="font-mono text-sm text-refuse-500">
            PolicyRejected(&ldquo;{result.reason}&rdquo;)
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-mist-400">
            The policy refused before any instruction was created. No TEE machine was contacted, no
            XRPL transaction was built, and nothing was signed. The operator&rsquo;s root access is
            irrelevant — there is no path from here to a signature.
          </p>
        </div>
      </div>
    );
  }

  if (result.verdict === "allowed") {
    return (
      <div className="rise mt-6 overflow-hidden rounded-lg border border-allow-500/30 bg-allow-500/[0.06]">
        <div className="flex items-center gap-2.5 border-b border-allow-500/20 px-5 py-3">
          <CheckIcon />
          <span className="font-mono text-xs uppercase tracking-[0.14em] text-allow-500">
            Policy authorized
          </span>
        </div>
        <div className="px-5 py-4">
          <p className="text-[13px] leading-relaxed text-mist-400">
            The policy allows this payment. On a real (non-simulated) call the enclave would sign it
            and the XRP would move — which is exactly what happened in{" "}
            <a href="#evidence" className="text-signal-400 underline decoration-ink-600 underline-offset-4">
              the recorded payment below
            </a>
            .
          </p>
          {result.instructionId && (
            <div className="mt-3 break-all font-mono text-[11px] text-mist-500">
              instructionId {result.instructionId}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rise mt-6 rounded-lg border hairline bg-ink-850 px-5 py-4">
      <div className="font-mono text-xs uppercase tracking-[0.14em] text-warn-500">
        {result.preflight ? "Not sent to the chain" : "Could not complete"}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{result.reason}</p>
    </div>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 fill-none stroke-refuse-500 stroke-2">
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5 fill-none stroke-allow-500 stroke-2">
      <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
