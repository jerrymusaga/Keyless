import { createWalletClient, createPublicClient, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES, ACCOUNTS_ABI, coston2 } from "@/lib/keyless";

/**
 * The relayer that puts a wallet's XRPL address on-chain. After createWallet, the enclave generates the
 * wallet's XRPL key and exposes its r-address at GET /state. This route reads that address and records
 * it via KeylessAccounts.reportXrplAddress, so the app (and anyone) can read a wallet's deposit address
 * straight from the chain — no enclave-API dependency at view time, and the value is verifiable.
 *
 * The enclave stays byte-identical (no code-hash change): the address flows enclave -> /state -> this
 * relayer -> chain. Requires ENCLAVE_URL and ENCLAVE_REPORTER_KEY (the key set as `enclaveReporter` at
 * deploy) in the server env. reportXrplAddress is idempotent on-chain, so calling this twice is safe.
 */
type StateResponse = {
  state?: { wallets?: Record<string, string>; xrplAddress?: string };
};

export async function POST(req: Request) {
  const enclaveUrl = process.env.ENCLAVE_URL;
  const reporterKey = process.env.ENCLAVE_REPORTER_KEY as `0x${string}` | undefined;
  if (!enclaveUrl || !reporterKey) {
    return Response.json({ ok: false, disabled: true, reason: "relayer not configured" }, { status: 501 });
  }

  let walletId: string;
  try {
    ({ walletId } = await req.json());
  } catch {
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  if (!isHex(walletId) || walletId.length !== 66) {
    return Response.json({ ok: false, error: "invalid walletId" }, { status: 400 });
  }

  // Ask the enclave for this wallet's r-address (generated in-enclave by INIT).
  let xrplAddress: string | undefined;
  try {
    const res = await fetch(`${enclaveUrl.replace(/\/$/, "")}/state`, {
      cache: "no-store",
      // ngrok serves a browser-warning interstitial to non-browser fetches without this header.
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const body = (await res.json()) as StateResponse;
    const wallets = body.state?.wallets ?? {};
    xrplAddress = wallets[walletId.toLowerCase()] ?? wallets[walletId] ?? body.state?.xrplAddress;
  } catch (e) {
    return Response.json(
      { ok: false, error: `enclave unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
  if (!xrplAddress) {
    // The enclave may not have processed INIT yet; the client should retry.
    return Response.json({ ok: false, pending: true }, { status: 202 });
  }

  const pub = createPublicClient({ chain: coston2, transport: http() });
  // Short-circuit if already recorded (idempotent on-chain too, but this saves a tx).
  const existing = (await pub.readContract({
    address: ADDRESSES.accounts,
    abi: ACCOUNTS_ABI,
    functionName: "xrplAddressOf",
    args: [walletId as `0x${string}`],
  })) as string;
  if (existing && existing.length > 0) {
    return Response.json({ ok: true, xrplAddress: existing, alreadyOnChain: true });
  }

  const wallet = createWalletClient({ account: privateKeyToAccount(reporterKey), chain: coston2, transport: http() });
  try {
    const hash = await wallet.writeContract({
      address: ADDRESSES.accounts,
      abi: ACCOUNTS_ABI,
      functionName: "reportXrplAddress",
      args: [walletId as `0x${string}`, xrplAddress],
    });
    await pub.waitForTransactionReceipt({ hash });
    return Response.json({ ok: true, xrplAddress, hash });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
