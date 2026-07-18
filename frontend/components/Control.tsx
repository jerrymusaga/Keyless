"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ADDRESSES,
  EXTENSION_ID,
  ENCLAVE_XRPL_ACCOUNT,
  addr,
  explorerAddress,
  xrplAccount,
} from "@/lib/keyless";
import { Fact, LiveBadge, Panel, Section, Code } from "./ui";

type ChainState = {
  ok: boolean;
  readAt?: string;
  blockNumber?: string;
  instructionsSender?: string;
  senderIsAccounts?: boolean;
  activeMachines?: string[];
  isBound?: boolean;
  owner?: string;
  extensionId?: string;
  error?: string;
};

export function Control() {
  const [state, setState] = useState<ChainState | null>(null);
  const [loading, setLoading] = useState(true);

  const read = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chain", { cache: "no-store" });
      setState(await res.json());
    } catch (e) {
      setState({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    read();
  }, [read]);

  return (
    <Section
      id="control"
      index="01"
      eyebrow="Who is in control"
      title="A contract holds the key. Not a human."
      lede={
        <>
          Flare&rsquo;s TEE machines accept instructions from exactly one address per extension — the
          registered <Code>instructionsSender</Code>. Ours is <Code>KeylessAccounts</Code>. Every
          wallet&rsquo;s key, sealed inside the enclave, can only ever sign what that contract&rsquo;s
          rules permit — and the operator cannot ask it for anything else.
        </>
      }
    >
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline bg-ink-850/50 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <LiveBadge label={loading ? "Reading chain…" : "Read from Coston2"} />
            {state?.blockNumber && (
              <span className="font-mono text-[11px] text-mist-500">
                block {Number(state.blockNumber).toLocaleString()}
              </span>
            )}
          </div>
          <button
            onClick={read}
            disabled={loading}
            className="rounded-md border hairline bg-ink-800 px-3 py-1.5 font-mono text-[11px] text-mist-300 transition-colors hover:border-ink-600 hover:text-mist-100 disabled:opacity-50"
          >
            {loading ? "reading…" : "read again ↻"}
          </button>
        </div>

        <div className="px-5 py-1">
          {state?.ok === false ? (
            <div className="py-8 text-center text-sm text-refuse-500">
              Could not reach Coston2: {state.error}
            </div>
          ) : (
            <>
              <Fact
                label="Instructions sender"
                hint="The only address the enclave obeys"
                value={
                  state?.instructionsSender ? (
                    <>
                      {state.instructionsSender}
                      {state.senderIsAccounts && (
                        <span className="ml-2 text-allow-500">— KeylessAccounts ✓</span>
                      )}
                    </>
                  ) : (
                    <Skeleton />
                  )
                }
                href={state?.instructionsSender ? explorerAddress(state.instructionsSender) : undefined}
                tone="signal"
              />
              <Fact
                label="Rules bound"
                hint="isBound() on KeylessAccounts"
                value={
                  state ? (
                    state.isBound ? (
                      "true — the extension takes orders from this contract and nothing else"
                    ) : (
                      "false"
                    )
                  ) : (
                    <Skeleton />
                  )
                }
                tone={state?.isBound ? "allow" : "default"}
              />
              <Fact
                label="Extension"
                hint="Our own FCE extension"
                value={state?.extensionId ? `${state.extensionId}` : <Skeleton />}
              />
              <Fact
                label="TEE machine"
                hint="FDC-attested, serving ext 454"
                value={
                  state?.activeMachines ? (
                    state.activeMachines.length ? (
                      state.activeMachines.join(", ")
                    ) : (
                      "none active"
                    )
                  ) : (
                    <Skeleton />
                  )
                }
                href={
                  state?.activeMachines?.[0] ? explorerAddress(state.activeMachines[0]) : undefined
                }
              />
              <Fact
                label="Enclave XRPL account"
                hint="Key generated inside the TEE — no human saw the seed"
                value={ENCLAVE_XRPL_ACCOUNT}
                href={xrplAccount(ENCLAVE_XRPL_ACCOUNT)}
              />
              <Fact
                label="Operator / deployer"
                hint="Owns the box. Holds no XRPL key."
                value={state?.owner ?? <Skeleton />}
                href={state?.owner ? explorerAddress(state.owner) : undefined}
              />
            </>
          )}
        </div>
      </Panel>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Guarantee
          n="1"
          title="What can be signed"
          body={
            <>
              Only what a wallet&rsquo;s rule permits. The enclave takes orders from KeylessAccounts
              and nobody else — Flare&rsquo;s InstructionsFacet enforces it at the chain level.
            </>
          }
        />
        <Guarantee
          n="2"
          title="What code signs it"
          body={
            <>
              The enclave&rsquo;s code hash is pinned on-chain. A machine may only join the extension
              by attesting to that hash, so the operator cannot swap in an image that ignores the
              policy.
            </>
          }
        />
      </div>
    </Section>
  );
}

function Guarantee({ n, title, body }: { n: string; title: string; body: React.ReactNode }) {
  return (
    <div className="rounded-lg border hairline bg-ink-900/50 p-5">
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-xs text-signal-500">{n}</span>
        <h3 className="text-sm font-medium text-mist-100">{title}</h3>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">{body}</p>
    </div>
  );
}

function Skeleton() {
  return <span className="inline-block h-3.5 w-48 animate-pulse rounded bg-ink-700 align-middle" />;
}
