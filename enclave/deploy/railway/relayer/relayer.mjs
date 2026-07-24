// Keyless address relayer.
//
// The enclave generates each wallet's XRPL key in-TEE and exposes only the r-address at GET /state.
// This service runs on Railway's PRIVATE network (so it can reach the enclave's :7702, which is never
// public), reads that state, and records any not-yet-on-chain address via KeylessAccounts.reportXrplAddress.
// The browser then reads xrplAddressOf straight from chain — no enclave-API dependency at view time, and
// no public exposure of the enclave's /state or /action. reportXrplAddress is idempotent on-chain.
//
// Env:
//   CHAIN_URL          Coston2 RPC (default below)
//   ENCLAVE_STATE_URL  the enclave's private URL, e.g. http://${{extension-tee.RAILWAY_PRIVATE_DOMAIN}}:7702
//   KEYLESS_ACCOUNTS   KeylessAccounts address
//   REPORTER_KEY       the enclaveReporter key (0x-prefixed hex)
//   POLL_INTERVAL_MS   optional, default 15000

import { createPublicClient, createWalletClient, http, defineChain, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.CHAIN_URL || "https://coston2-api.flare.network/ext/C/rpc";
const STATE_URL = (process.env.ENCLAVE_STATE_URL || "").replace(/\/$/, "");
const ACCOUNTS = process.env.KEYLESS_ACCOUNTS;
const KEY = process.env.REPORTER_KEY;
const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 15000);

for (const [k, v] of Object.entries({ ENCLAVE_STATE_URL: STATE_URL, KEYLESS_ACCOUNTS: ACCOUNTS, REPORTER_KEY: KEY })) {
  if (!v) {
    console.error(`[relayer] missing required env ${k}`);
    process.exit(1);
  }
}

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const ACCOUNTS_ABI = [
  { type: "function", name: "xrplAddressOf", stateMutability: "view", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [{ type: "string" }] },
  { type: "function", name: "reportXrplAddress", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "xrplAddress", type: "string" }], outputs: [] },
];

const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const wallet = createWalletClient({ account: privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`), chain: coston2, transport: http(RPC) });

async function fetchState() {
  const res = await fetch(`${STATE_URL}/state`, { headers: { "ngrok-skip-browser-warning": "true" } });
  if (!res.ok) throw new Error(`/state HTTP ${res.status}`);
  const body = await res.json();
  return body?.state?.wallets ?? {};
}

async function tick() {
  let wallets;
  try {
    wallets = await fetchState();
  } catch (e) {
    console.error(`[relayer] cannot read enclave /state: ${e.message}`);
    return;
  }
  for (const [walletId, xrplAddress] of Object.entries(wallets)) {
    if (!xrplAddress || !isHex(walletId) || walletId.length !== 66) continue;
    try {
      const existing = await pub.readContract({ address: ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [walletId] });
      if (existing && existing.length > 0) continue; // already on-chain
      const hash = await wallet.writeContract({ address: ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "reportXrplAddress", args: [walletId, xrplAddress] });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`[relayer] reported ${walletId} -> ${xrplAddress} (${hash})`);
    } catch (e) {
      console.error(`[relayer] report failed for ${walletId}: ${e.shortMessage || e.message}`);
    }
  }
}

console.log(`[relayer] polling ${STATE_URL}/state every ${INTERVAL}ms -> reportXrplAddress on ${ACCOUNTS}`);
await tick();
setInterval(() => { tick().catch((e) => console.error(`[relayer] tick error: ${e.message}`)); }, INTERVAL);
