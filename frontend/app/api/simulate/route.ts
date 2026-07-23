import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
} from "viem";
import { ADDRESSES, POLICY_ABI, XRPL_ADDRESS_RE, coston2 } from "@/lib/keyless";

/**
 * Ask the live policy contract whether it would authorize a payment.
 *
 * This is an `eth_call` against the deployed contract on Coston2 — the same code
 * path a real `pay()` takes, stopped one step before it costs anything. The
 * verdict below is the contract's, not ours: we cannot make it say yes.
 *
 * No wallet, no gas, no signature, no state change. Which is what makes it safe
 * to hand to a stranger with a text box.
 */

const client = createPublicClient({ chain: coston2, transport: http() });

type Verdict = "allowed" | "rejected" | "error";

export async function POST(request: Request) {
  let recipient: string;
  let amountDrops: string;

  try {
    const body = await request.json();
    recipient = String(body.recipient ?? "").trim();
    amountDrops = String(body.amountDrops ?? "15000000").trim();
  } catch {
    return Response.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  // Reject junk before spending an RPC round-trip on it. The contract would also
  // reject it, but a format error is a different message than a policy refusal
  // and conflating the two would muddy the very distinction this page exists to draw.
  if (!XRPL_ADDRESS_RE.test(recipient)) {
    return Response.json({
      ok: true,
      verdict: "error" as Verdict,
      reason: "That is not a valid XRPL classic address (they start with `r`).",
      preflight: true,
    });
  }

  let amount: bigint;
  try {
    amount = BigInt(amountDrops);
  } catch {
    return Response.json({ ok: false, error: "Amount must be an integer in drops." }, { status: 400 });
  }
  // Note the asymmetry: a zero amount is deliberately NOT caught here. The policy
  // has its own `zero amount` branch, and letting the contract be the one to
  // refuse it is both more honest and a second live demonstration of the policy.
  // Only genuinely un-encodable values are stopped early.
  if (amount < 0n || amount > 100_000_000_000_000n) {
    return Response.json({
      ok: true,
      verdict: "error" as Verdict,
      reason: "Amount is outside the range this form will encode.",
      preflight: true,
    });
  }

  try {
    const fee = await client.readContract({
      address: ADDRESSES.policy,
      abi: POLICY_ABI,
      functionName: "quotePayFee",
    });

    const { result } = await client.simulateContract({
      address: ADDRESSES.policy,
      abi: POLICY_ABI,
      functionName: "pay",
      args: [recipient, amount, `0x${"00".repeat(31)}01`],
      value: fee,
      account: ADDRESSES.owner,
    });

    return Response.json({
      ok: true,
      verdict: "allowed" as Verdict,
      instructionId: result,
      feeWei: fee.toString(),
      reason:
        "The policy authorized this payment. On a real call the enclave would sign it and the XRP would move.",
    });
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const name = revert.data?.errorName;

        if (name === "PolicyRejected") {
          return Response.json({
            ok: true,
            verdict: "rejected" as Verdict,
            errorName: name,
            reason: String(revert.data?.args?.[0] ?? "policy rejected"),
          });
        }

        // Not a policy decision — the machine registry is empty or the fee moved.
        // Surfaced honestly rather than dressed up as a refusal.
        return Response.json({
          ok: true,
          verdict: "error" as Verdict,
          errorName: name,
          reason:
            name === "NoTeeMachines"
              ? "No TEE machine is currently serving extension 65645."
              : `Reverted with ${name ?? "an unrecognized error"}.`,
        });
      }
    }
    return Response.json(
      { ok: false, error: e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
