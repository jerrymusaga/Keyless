import { createPublicClient, createWalletClient, http, type PrivateKeyAccount } from "viem";
import { coston2 } from "./keyless";

/**
 * viem clients for the app. No wagmi, no connect modal: Keyless is the wallet, so the signer is the
 * embedded account (see lib/embedded). Reads go through a shared public client; writes go through a
 * wallet client bound to the embedded account.
 */

export const publicClient = createPublicClient({ chain: coston2, transport: http() });

export function walletClientFor(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: coston2, transport: http() });
}
