import { toEventSelector, pad, type AbiEvent } from "viem";
import { ADDRESSES } from "@/lib/keyless";

/**
 * Every account a control key has created, read from the chain.
 *
 * The app remembers your accounts in localStorage, which is fine until you move browsers — then your key
 * imports correctly and your accounts don't come with it, which reads as "my funds are gone". They aren't:
 * `WalletCreated` indexes `owner`, so the list is derivable from the key alone and always was.
 *
 * Server-side because the public RPC caps `getLogs` at 30 blocks, far short of an account's history — the
 * same reason /api/rule-config and /api/xrpl read here. See those for the shared rationale.
 */
export const runtime = "nodejs";

const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";

const WALLET_CREATED = {
  type: "event",
  name: "WalletCreated",
  inputs: [
    { name: "walletId", type: "bytes32", indexed: true },
    { name: "owner", type: "address", indexed: true },
    { name: "initInstructionId", type: "bytes32" },
  ],
} as const satisfies AbiEvent;

export async function POST(req: Request) {
  let owner: string;
  try {
    ({ owner } = await req.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "")) {
    return Response.json({ error: "invalid owner address" }, { status: 400 });
  }

  try {
    const url =
      `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest` +
      `&address=${ADDRESSES.accounts}` +
      `&topic0=${toEventSelector(WALLET_CREATED)}` +
      `&topic2=${pad(owner.toLowerCase() as `0x${string}`, { size: 32 })}` +
      `&topic0_2_opr=and`;

    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    const rows = Array.isArray(json.result) ? json.result : [];

    // topic1 is the walletId. Oldest first, so recovered accounts number in creation order.
    const accounts = rows
      .map((l: { topics: string[]; timeStamp?: string; blockNumber?: string }) => ({
        walletId: l.topics?.[1] as `0x${string}`,
        createdAt: l.timeStamp ? parseInt(l.timeStamp, 16) * 1000 : 0,
      }))
      .filter((a: { walletId?: string }) => /^0x[0-9a-fA-F]{64}$/.test(a.walletId ?? ""));

    return Response.json({ accounts });
  } catch (e) {
    return Response.json(
      { error: `explorer unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
