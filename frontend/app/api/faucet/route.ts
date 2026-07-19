import { createWalletClient, createPublicClient, http, isAddress, parseEther } from "viem";
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
const DRIP = parseEther("2"); // C2FLR per top-up — plenty for many ops at testnet gas
const ENOUGH = parseEther("1"); // don't top up an address already above this

export async function POST(req: Request) {
  const key = process.env.FAUCET_KEY as `0x${string}` | undefined;
  if (!key) {
    return Response.json(
      { ok: false, disabled: true, faucet: "https://faucet.flare.network/coston2" },
      { status: 501 },
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
  const balance = await pub.getBalance({ address });
  if (balance >= ENOUGH) {
    return Response.json({ ok: true, funded: false, balance: balance.toString() });
  }

  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: coston2, transport: http() });
  try {
    const hash = await wallet.sendTransaction({ to: address, value: DRIP });
    await pub.waitForTransactionReceipt({ hash });
    return Response.json({ ok: true, funded: true, hash });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
