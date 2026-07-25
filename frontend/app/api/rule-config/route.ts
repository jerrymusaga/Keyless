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
    { name: "walletId", type: "bytes32", indexed: true }, { name: "maxPerPeriod", type: "uint256" }, { name: "period", type: "uint64" },
  ] } as AbiEvent,
  planConfigured: { type: "event", name: "PlanConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "merchant", type: "string" },
    { name: "maxPerPeriod", type: "uint256" }, { name: "period", type: "uint64" },
  ] } as AbiEvent,
  planCancelled: { type: "event", name: "PlanCancelled", inputs: [{ name: "walletId", type: "bytes32", indexed: true }] } as AbiEvent,
  escrowConfigured: { type: "event", name: "EscrowConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
    { name: "maxAmount", type: "uint256" }, { name: "conditionHash", type: "bytes32" },
  ] } as AbiEvent,
  escrowCancelled: { type: "event", name: "EscrowCancelled", inputs: [{ name: "walletId", type: "bytes32", indexed: true }] } as AbiEvent,
  escrowReleased: { type: "event", name: "EscrowReleased", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "votingRound", type: "uint64" },
  ] } as AbiEvent,
};

type Tagged = { ev: AbiEvent; block: bigint; index: bigint; args: Record<string, unknown> };

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
    if (rule === "exchange" || rule === "allowlist" || rule === "rateLimit") {
      const allowEv = rule === "exchange" ? E.allowedTagged : E.allowed;
      const extra = rule === "exchange" ? [E.maxPerTxSet] : rule === "rateLimit" ? [E.limitConfigured] : [];
      const events = await replay(rule, [allowEv, E.removed, ...extra], walletId);
      const map = new Map<string, { requireTag: boolean; tag: number }>();
      let capDrops: string | undefined;
      let limit: { maxPerPeriod: string; period: string } | undefined;
      for (const e of events) {
        if (e.ev.name === "RecipientAllowed") map.set(String(e.args.recipient), { requireTag: !!e.args.requireTag, tag: Number(e.args.tag ?? 0) });
        else if (e.ev.name === "RecipientRemoved") map.delete(String(e.args.recipient));
        else if (e.ev.name === "MaxPerTxSet") capDrops = String(e.args.maxDrops);
        else if (e.ev.name === "LimitConfigured") limit = { maxPerPeriod: String(e.args.maxPerPeriod), period: String(e.args.period) };
      }
      const recipients = [...map.entries()].map(([address, v]) => ({ address, requireTag: v.requireTag, tag: v.tag }));
      return Response.json({ recipients, capDrops, limit });
    }

    if (rule === "subscription") {
      const events = await replay(rule, [E.planConfigured, E.planCancelled], walletId);
      let plan: { merchant: string; maxPerPeriod: string; period: string } | null = null;
      for (const e of events) {
        if (e.ev.name === "PlanConfigured") plan = { merchant: String(e.args.merchant), maxPerPeriod: String(e.args.maxPerPeriod), period: String(e.args.period) };
        else plan = null; // PlanCancelled
      }
      return Response.json({ plan });
    }

    // escrow
    const events = await replay(rule, [E.escrowConfigured, E.escrowCancelled, E.escrowReleased], walletId);
    let escrow: { recipient: string; maxAmount: string; conditionHash: string; released: boolean } | null = null;
    for (const e of events) {
      if (e.ev.name === "EscrowConfigured") escrow = { recipient: String(e.args.recipient), maxAmount: String(e.args.maxAmount), conditionHash: String(e.args.conditionHash), released: false };
      else if (e.ev.name === "EscrowReleased") { if (escrow) escrow.released = true; }
      else escrow = null; // EscrowCancelled
    }
    return Response.json({ escrow });
  } catch (e) {
    return Response.json({ error: `explorer unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
