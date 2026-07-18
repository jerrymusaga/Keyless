import { createPublicClient, http, keccak256, toHex } from "viem";
import {
  ADDRESSES,
  ALLOWLISTED_RECIPIENT,
  EXTENSION_ID,
  POLICY_ABI,
  TEE_MANAGER_ABI,
  coston2,
} from "@/lib/keyless";

/**
 * Live chain state for the "who's in control" panel.
 *
 * Read on the server so the page never depends on a visitor's RPC access, and
 * uncached (route handlers are uncached by default in Next 16) so a judge
 * hitting refresh genuinely re-reads Coston2.
 */

const client = createPublicClient({ chain: coston2, transport: http() });

export async function GET() {
  try {
    const [instructionsSender, activeMachines, isBound, fee, owner, extensionId, allowlisted] =
      await Promise.all([
        client.readContract({
          address: ADDRESSES.teeManager,
          abi: TEE_MANAGER_ABI,
          functionName: "getTeeExtensionInstructionsSender",
          args: [BigInt(EXTENSION_ID)],
        }),
        client.readContract({
          address: ADDRESSES.teeManager,
          abi: TEE_MANAGER_ABI,
          functionName: "getActiveTeeMachines",
          args: [BigInt(EXTENSION_ID)],
        }),
        client.readContract({
          address: ADDRESSES.policy,
          abi: POLICY_ABI,
          functionName: "isBound",
        }),
        client.readContract({
          address: ADDRESSES.policy,
          abi: POLICY_ABI,
          functionName: "quotePayFee",
        }),
        client.readContract({
          address: ADDRESSES.policy,
          abi: POLICY_ABI,
          functionName: "owner",
        }),
        client.readContract({
          address: ADDRESSES.policy,
          abi: POLICY_ABI,
          functionName: "extensionId",
        }),
        client.readContract({
          address: ADDRESSES.policy,
          abi: POLICY_ABI,
          functionName: "allowedRecipient",
          args: [keccak256(toHex(ALLOWLISTED_RECIPIENT))],
        }),
      ]);

    const blockNumber = await client.getBlockNumber();

    return Response.json({
      ok: true,
      readAt: new Date().toISOString(),
      blockNumber: blockNumber.toString(),
      instructionsSender,
      /** The whole thesis, as a boolean: the sender is a contract, not a person. */
      senderIsPolicy: instructionsSender.toLowerCase() === ADDRESSES.policy.toLowerCase(),
      activeMachines,
      isBound,
      quotePayFeeWei: fee.toString(),
      owner,
      extensionId: extensionId.toString(),
      allowlistedRecipientIsAllowed: allowlisted,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
