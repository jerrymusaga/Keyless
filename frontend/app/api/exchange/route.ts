import { decodeEventLog, toEventSelector, type AbiEvent } from "viem";
import { RULES } from "@/lib/keyless";

/**
 * Current ExchangeRule allowlist for a wallet, rebuilt from chain.
 *
 * The rule stores recipients as keccak(recipient) => Dest, so the mapping can't be enumerated and the
 * r-addresses can't be recovered from it. But every change emits RecipientAllowed / RecipientRemoved with
 * the recipient string in the event data — so we replay those events in order to reconstruct the live
 * set. Read on the server via the explorer's log API because the public RPC caps getLogs at 30 blocks,
 * too small to scan an account's whole history.
 */
export const runtime = "nodejs";

const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";

const ALLOWED: AbiEvent = {
  type: "event",
  name: "RecipientAllowed",
  inputs: [
    { name: "walletId", type: "bytes32", indexed: true },
    { name: "recipient", type: "string", indexed: false },
    { name: "requireTag", type: "bool", indexed: false },
    { name: "tag", type: "uint32", indexed: false },
  ],
};
const REMOVED: AbiEvent = {
  type: "event",
  name: "RecipientRemoved",
  inputs: [
    { name: "walletId", type: "bytes32", indexed: true },
    { name: "recipient", type: "string", indexed: false },
  ],
};
const ALLOWED_T0 = toEventSelector(ALLOWED);
const REMOVED_T0 = toEventSelector(REMOVED);

type RawLog = { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]]; blockNumber: string; logIndex: string };

async function getLogs(topic0: string, walletId: string): Promise<RawLog[]> {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${RULES.exchange}&topic0=${topic0}&topic1=${walletId}&topic0_1_opr=and`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  return Array.isArray(json.result) ? (json.result as RawLog[]) : [];
}

export async function POST(req: Request) {
  let walletId: string;
  try {
    ({ walletId } = await req.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletId ?? "")) {
    return Response.json({ error: "invalid walletId" }, { status: 400 });
  }

  let allowed: RawLog[];
  let removed: RawLog[];
  try {
    [allowed, removed] = await Promise.all([getLogs(ALLOWED_T0, walletId), getLogs(REMOVED_T0, walletId)]);
  } catch (e) {
    return Response.json({ error: `explorer unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  // Replay both streams in on-chain order. A later event for the same recipient wins.
  const events = [
    ...allowed.map((l) => ({ l, kind: "allow" as const })),
    ...removed.map((l) => ({ l, kind: "remove" as const })),
  ].sort((a, b) => {
    const bn = Number(BigInt(a.l.blockNumber) - BigInt(b.l.blockNumber));
    return bn !== 0 ? bn : Number(BigInt(a.l.logIndex) - BigInt(b.l.logIndex));
  });

  const map = new Map<string, { requireTag: boolean; tag: number }>();
  for (const { l, kind } of events) {
    try {
      const decoded = decodeEventLog({ abi: [kind === "allow" ? ALLOWED : REMOVED], data: l.data, topics: l.topics });
      const args = decoded.args as { recipient: string; requireTag?: boolean; tag?: number };
      if (kind === "allow") map.set(args.recipient, { requireTag: !!args.requireTag, tag: Number(args.tag ?? 0) });
      else map.delete(args.recipient);
    } catch {
      /* skip an undecodable log rather than fail the whole list */
    }
  }

  const recipients = [...map.entries()].map(([address, v]) => ({ address, requireTag: v.requireTag, tag: v.tag }));
  return Response.json({ recipients });
}
