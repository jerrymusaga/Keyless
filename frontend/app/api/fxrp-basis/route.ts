import { createPublicClient, http, toEventSelector, decodeFunctionData, type AbiEvent } from "viem";
import { ADDRESSES, RULES, RULE_ABIS, coston2 } from "@/lib/keyless";

/**
 * What an account actually put into each FXRP vault, so a position can show a gain rather than just a
 * value.
 *
 * The number isn't recorded anywhere directly. A vault deposit is an XRPL payment whose 32-byte
 * `paymentReference` encodes the instruction, the vault and the amount — and `PaymentAuthorized` emits
 * `(walletId, instructionId, recipient, amount)`, where `amount` is the XRPL trigger payment, not the FXRP
 * being deposited. So the deposit size exists only in the calldata of the `pay()` that authorized it.
 *
 * Hence: find this wallet's payments by event (walletId is indexed), then read back each transaction to
 * recover the reference it carried. Server-side because the public RPC caps `getLogs` at 30 blocks — the
 * same reason /api/accounts-of and /api/rule-config read here.
 */
export const runtime = "nodejs";

const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";

const PAYMENT_AUTHORIZED = {
  type: "event",
  name: "PaymentAuthorized",
  inputs: [
    { name: "walletId", type: "bytes32", indexed: true },
    { name: "instructionId", type: "bytes32", indexed: true },
    { name: "recipient", type: "string" },
    { name: "amount", type: "uint256" },
  ],
} as const satisfies AbiEvent;

const PAY_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [
      { name: "walletId", type: "bytes32" },
      { name: "recipient", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "paymentReference", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

// Vault instruction ids, by type: Firelight 0x11/0x12/0x13, Upshift 0x21/0x22/0x23.
const DEPOSIT = new Set([0x11, 0x21]);
const EXIT = new Set([0x12, 0x22]);
// 0x13 / 0x23 are claims, and their `value` field holds a PERIOD NUMBER, not an amount. Adding one to a
// basis would corrupt it silently and in the direction that flatters us, so they are ignored outright.

const client = createPublicClient({ chain: coston2, transport: http(undefined, { timeout: 20_000, retryCount: 2 }) });

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

  try {
    const url =
      `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest` +
      `&address=${ADDRESSES.accounts}` +
      `&topic0=${toEventSelector(PAYMENT_AUTHORIZED)}` +
      `&topic1=${walletId.toLowerCase()}` +
      `&topic0_1_opr=and`;

    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    const rows: { transactionHash?: string; blockNumber?: string; logIndex?: string }[] =
      Array.isArray(json.result) ? json.result : [];

    // Chronological, so "deposits since the last exit" means what it says.
    const ordered = [...rows].sort((a, b) => {
      const bn = parseInt(a.blockNumber ?? "0", 16) - parseInt(b.blockNumber ?? "0", 16);
      return bn !== 0 ? bn : parseInt(a.logIndex ?? "0", 16) - parseInt(b.logIndex ?? "0", 16);
    });

    // Only payments to the FSA provider wallet are vault instructions — the same test FxrpRule applies,
    // and it has to be applied here too. An account on this policy also pays the Core Vault to mint and
    // approved payees to cash out, and THOSE references are arbitrary bytes: a memo or a destination tag.
    // Decoded as an instruction, one whose first byte happened to be 0x11 would enter the basis as a
    // deposit that never happened. Observed in the wild while testing this: a reference decoding to
    // "id=0x1d, vault=19806, value=1.3e22".
    const fsaWallet = (await client.readContract({
      address: RULES.fxrp as `0x${string}`,
      abi: RULE_ABIS.fxrp as never,
      functionName: "fsaProviderWallet",
    })) as string;

    // One transaction can carry only one pay(), but the same tx hash can appear once per matching log.
    const hashes = [...new Set(ordered.map((r) => r.transactionHash).filter(Boolean))] as `0x${string}`[];
    const byHash = new Map<string, bigint>();
    for (const hash of hashes) {
      const tx = await client.getTransaction({ hash });
      const { functionName, args } = decodeFunctionData({ abi: PAY_ABI, data: tx.input });
      if (functionName !== "pay") continue;
      // XRPL addresses are case-sensitive base58 — compare exactly, don't normalise.
      if ((args[1] as string) !== fsaWallet) continue;
      byHash.set(hash.toLowerCase(), BigInt(args[3] as `0x${string}`));
    }

    // Deposits accumulate; an exit zeroes the vault. The app only ever exits a whole position
    // (`runExit` passes the full `assets`), so anything deposited afterwards starts a fresh basis.
    const basis = new Map<number, bigint>();
    for (const row of ordered) {
      const ref = byHash.get((row.transactionHash ?? "").toLowerCase());
      if (ref === undefined) continue;
      const id = Number(ref >> 248n);
      const vaultId = Number((ref >> 128n) & 0xffffn);
      const value = (ref >> 160n) & ((1n << 80n) - 1n);
      if (DEPOSIT.has(id)) basis.set(vaultId, (basis.get(vaultId) ?? 0n) + value);
      else if (EXIT.has(id)) basis.set(vaultId, 0n);
    }

    return Response.json({
      basis: Object.fromEntries([...basis].map(([v, b]) => [String(v), b.toString()])),
    });
  } catch (e) {
    // No basis is a fine answer — the position simply shows its value and no gain. A guess would not be.
    return Response.json(
      { error: `basis unavailable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
