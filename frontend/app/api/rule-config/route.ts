import { decodeEventLog, toEventSelector, type AbiEvent } from "viem";
import { RULES, type RuleKey } from "@/lib/keyless";

/**
 * Current on-chain configuration for a wallet's rule, rebuilt from events.
 *
 * Every rule stores recipients/merchants as keccak(recipient) => … , so the mappings can't be
 * enumerated and the r-addresses can't be recovered from them. But each rule emits its changes with the
 * human string in the event data, so we replay those events to reconstruct the live config. Read on the
 * server via the explorer's log API because the public RPC caps getLogs at 30 blocks — far too small to
 * scan an account's whole history. See /api/xrpl and /api/chain for the same server-read rationale.
 */
export const runtime = "nodejs";

const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";

// --- event ABIs ---------------------------------------------------------------------------------
const E = {
  allowedTagged: { type: "event", name: "RecipientAllowed", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
    { name: "requireTag", type: "bool" }, { name: "tag", type: "uint32" },
  ] } as AbiEvent,
  allowed: { type: "event", name: "RecipientAllowed", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
  ] } as AbiEvent,
  removed: { type: "event", name: "RecipientRemoved", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
  ] } as AbiEvent,
  maxPerTxSet: { type: "event", name: "MaxPerTxSet", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "maxDrops", type: "uint256" },
  ] } as AbiEvent,
  limitConfigured: { type: "event", name: "LimitConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "mode", type: "uint8" }, { name: "cap", type: "uint256" },
    { name: "param", type: "uint256" }, { name: "maxPerTx", type: "uint256" }, { name: "allowlistOnly", type: "bool" },
  ] } as AbiEvent,
  // ConditionalRule. ConditionConfigured carries the FULL pinned request, so the UI can describe the
  // condition in words without any off-chain registry.
  escrowConfigured: { type: "event", name: "ConditionConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
    { name: "maxAmount", type: "uint256" }, { name: "requestHash", type: "bytes32" },
    { name: "expectedHash", type: "bytes32" },
    { name: "request", type: "tuple", components: [
      { name: "url", type: "string" }, { name: "httpMethod", type: "string" }, { name: "headers", type: "string" },
      { name: "queryParams", type: "string" }, { name: "body", type: "string" },
      { name: "postProcessJq", type: "string" }, { name: "abiSignature", type: "string" },
    ] },
    { name: "deadline", type: "uint256" }, { name: "fallbackRecipient", type: "string" },
  ] } as AbiEvent,
  escrowCancelled: { type: "event", name: "ConditionCancelled", inputs: [{ name: "walletId", type: "bytes32", indexed: true }] } as AbiEvent,
  escrowReleased: { type: "event", name: "ConditionProven", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "votingRound", type: "uint64" },
  ] } as AbiEvent,
};

type Tagged = { ev: AbiEvent; block: bigint; index: bigint; args: Record<string, unknown> };

/**
 * Turn a pinned attestation request back into a phrase a person can read ("XRP is worth at least $1").
 * The request is on-chain in full, so this is a faithful description of what the account is waiting on —
 * derived from the commitment itself, not from anything we store off-chain.
 */
function describeCondition(request?: { url?: string; postProcessJq?: string }): string | undefined {
  const url = request?.url ?? "";
  const jq = request?.postProcessJq ?? "";
  if (!url) return undefined;
  const price = jq.match(/\.ripple\.usd\s*>=\s*([\d.]+)/);
  if (price) return `XRP is worth at least $${price[1]}`;
  const gh = url.match(/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)/);
  if (gh) return `${gh[1]}#${gh[3]} is ${gh[2] === "pulls" ? "merged" : "closed"}`;
  try {
    return `${new URL(url).hostname} reports it`;
  } catch {
    return "the pinned condition";
  }
}

async function getLogs(rule: RuleKey, ev: AbiEvent, walletId: string): Promise<Tagged[]> {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${RULES[rule]}&topic0=${toEventSelector(ev)}&topic1=${walletId}&topic0_1_opr=and`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  const rows = Array.isArray(json.result) ? json.result : [];
  const out: Tagged[] = [];
  for (const l of rows) {
    try {
      const d = decodeEventLog({ abi: [ev], data: l.data, topics: l.topics });
      out.push({ ev, block: BigInt(l.blockNumber), index: BigInt(l.logIndex), args: d.args as Record<string, unknown> });
    } catch { /* skip undecodable */ }
  }
  return out;
}

async function replay(rule: RuleKey, evs: AbiEvent[], walletId: string): Promise<Tagged[]> {
  const groups = await Promise.all(evs.map((ev) => getLogs(rule, ev, walletId)));
  return groups.flat().sort((a, b) => (a.block !== b.block ? Number(a.block - b.block) : Number(a.index - b.index)));
}

export async function POST(req: Request) {
  let rule: RuleKey, walletId: string;
  try {
    ({ rule, walletId } = await req.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!RULES[rule]) return Response.json({ error: "unknown rule" }, { status: 400 });
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletId ?? "")) return Response.json({ error: "invalid walletId" }, { status: 400 });

  try {
    if (rule === "exchange" || rule === "rateLimit") {
      const allowEv = rule === "exchange" ? E.allowedTagged : E.allowed;
      const extra = rule === "exchange" ? [E.maxPerTxSet] : [E.limitConfigured];
      const events = await replay(rule, [allowEv, E.removed, ...extra], walletId);
      const map = new Map<string, { requireTag: boolean; tag: number }>();
      let capDrops: string | undefined;
      let limit: { mode: number; cap: string; param: string; maxPerTx: string; allowlistOnly: boolean } | undefined;
      for (const e of events) {
        if (e.ev.name === "RecipientAllowed") map.set(String(e.args.recipient), { requireTag: !!e.args.requireTag, tag: Number(e.args.tag ?? 0) });
        else if (e.ev.name === "RecipientRemoved") map.delete(String(e.args.recipient));
        else if (e.ev.name === "MaxPerTxSet") capDrops = String(e.args.maxDrops);
        else if (e.ev.name === "LimitConfigured") limit = { mode: Number(e.args.mode), cap: String(e.args.cap), param: String(e.args.param), maxPerTx: String(e.args.maxPerTx ?? 0), allowlistOnly: !!e.args.allowlistOnly };
      }
      const recipients = [...map.entries()].map(([address, v]) => ({ address, requireTag: v.requireTag, tag: v.tag }));
      return Response.json({ recipients, capDrops, limit });
    }

    // conditional
    const events = await replay(rule, [E.escrowConfigured, E.escrowCancelled, E.escrowReleased], walletId);
    let escrow: { recipient: string; maxAmount: string; released: boolean; condition?: string; deadline?: string; fallback?: string } | null = null;
    for (const e of events) {
      if (e.ev.name === "ConditionConfigured") {
        escrow = {
          recipient: String(e.args.recipient),
          maxAmount: String(e.args.maxAmount),
          released: false,
          condition: describeCondition(e.args.request as { url?: string; postProcessJq?: string } | undefined),
          deadline: String(e.args.deadline ?? "0"),
          fallback: String(e.args.fallbackRecipient ?? ""),
        };
      } else if (e.ev.name === "ConditionProven") { if (escrow) escrow.released = true; }
      else escrow = null; // ConditionCancelled
    }
    return Response.json({ escrow });
  } catch (e) {
    return Response.json({ error: `explorer unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
