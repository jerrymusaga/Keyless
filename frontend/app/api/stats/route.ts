import { createPublicClient, http } from "viem";
import { ADDRESSES, ACCOUNTS_ABI, coston2 } from "@/lib/keyless";

/**
 * Network-wide Keyless stats, read straight from the chain via an O(1) on-chain counter (walletCount) —
 * no log scanning, because the public Coston2 RPC caps eth_getLogs at 30 blocks. Degrades gracefully:
 * if the deployed contract predates the counter, this returns available:false and the UI hides the bar.
 */
const client = createPublicClient({ chain: coston2, transport: http() });

export async function GET() {
  try {
    const [count, active] = (await Promise.all([
      client.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "walletCount" }),
      client.readContract({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "activeCount" }),
    ])) as [bigint, bigint];
    return Response.json({ ok: true, available: true, totalAccounts: Number(count), activeAccounts: Number(active) });
  } catch {
    // Older contract without the counter, or a transient RPC error — don't break the UI.
    return Response.json({ ok: true, available: false });
  }
}
