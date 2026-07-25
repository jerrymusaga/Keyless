import { createWalletClient, createPublicClient, http, isAddress, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "@/lib/keyless";

/**
 * Gas sponsor for embedded Keyless wallets. The whole "no MetaMask, no gas" experience rests here: a
 * user's control key is born empty, and this route tops it up with a little C2FLR so it can pay for its
 * own Coston2 transactions (create account, set rule, edit rule). It only ever *sends* gas to an
 * address — it signs nothing on the user's behalf.
 *
 * Testnet only. Requires FAUCET_KEY (a funded Coston2 key) in the server env; without it the route is
 * disabled and the UI falls back to the public Flare faucet. Caps the top-up and refuses to re-fund an
 * address that already has enough, so a funded key can't be drained by spamming.
 */
export const runtime = "nodejs";
export const maxDuration = 30; // allow the send + receipt wait to finish inside the function window

const DRIP = parseEther("2"); // C2FLR per top-up — plenty for many ops at testnet gas
const ENOUGH = parseEther("1"); // don't top up an address already above this
const GAS = 21_000n; // plain value transfer — fixed, so we never hang on eth_estimateGas retries
const FAUCET_MIN = DRIP + parseEther("0.05"); // faucet must cover the drip + its own gas

export async function POST(req: Request) {
  const key = process.env.FAUCET_KEY as `0x${string}` | undefined;
  if (!key) {
    return Response.json(
      { ok: false, disabled: true, faucet: "https://faucet.flare.network/coston2" },
      { status: 501 },
    );
  }

  let account;
  try {
    account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  } catch {
    return Response.json(
      { ok: false, error: "FAUCET_KEY is not a valid private key (need 0x + 64 hex chars)" },
      { status: 500 },
    );
  }

  let address: string;
  try {
    ({ address } = await req.json());
  } catch {
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  if (!isAddress(address)) {
    return Response.json({ ok: false, error: "invalid address" }, { status: 400 });
  }

  const pub = createPublicClient({ chain: coston2, transport: http() });

  try {
    // Already has enough? Nothing to do (and this is the anti-drain guard).
    const balance = await pub.getBalance({ address });
    if (balance >= ENOUGH) {
      return Response.json({ ok: true, funded: false, balance: balance.toString() });
    }

    // Fail FAST and LEGIBLY if the faucet account itself is empty — the common misconfig is funding a
    // different address than the key that's set here. Without this the send would retry-then-time-out
    // and the caller would just see an opaque hang.
    const faucetBalance = await pub.getBalance({ address: account.address });
    if (faucetBalance < FAUCET_MIN) {
      return Response.json(
        {
          ok: false,
          error: `faucet account ${account.address} is underfunded (${formatEther(faucetBalance)} C2FLR). Fund THIS address, or set FAUCET_KEY to a key whose address you funded.`,
          faucetAddress: account.address,
          faucetBalance: faucetBalance.toString(),
        },
        { status: 503 },
      );
    }

    const wallet = createWalletClient({ account, chain: coston2, transport: http() });
    const hash = await wallet.sendTransaction({ to: address, value: DRIP, gas: GAS });
    await pub.waitForTransactionReceipt({ hash });
    return Response.json({ ok: true, funded: true, hash, faucetAddress: account.address });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), faucetAddress: account.address },
      { status: 502 },
    );
  }
}
