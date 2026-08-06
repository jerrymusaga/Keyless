// Set up the frost-cover demo, ready to film.
//
// Parametric crop insurance settled on real weather: an insurer locks XRP against a vineyard freezing.
// If it frosts, the grower is paid automatically. If it doesn't by the deadline, the money returns to the
// insurer. Nobody adjudicates — Flare's Data Connector attests the weather, and the payment unlocks itself.
//
//   node demo-frost.mjs armed     cover that has NOT triggered  (act 1 — nobody can be paid)
//   node demo-frost.mjs triggered cover that HAS triggered      (act 2 — the watcher proves it, grower paid)
//
// `triggered` picks whichever real vineyard is coldest right now and sets the threshold just above the live
// reading, so the frost being proven is genuine — not a number bent to fit. Run it immediately before
// filming: the condition starts UNPROVEN, and the watcher takes ~2-3 minutes to prove it, which is the arc.
//
// Env: EXECUTOR_KEY (the account owner's key) · CONDITIONAL_RULE · KEYLESS_ACCOUNTS · DEMO_WALLET

import { createPublicClient, createWalletClient, http, defineChain, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const RULE = process.env.CONDITIONAL_RULE || "0x2d8517BC464C70c21bBDBA48d3166a77A5019E77";
const ACCOUNTS = process.env.KEYLESS_ACCOUNTS || "0x57eb332D7000752ee82a35cc1A75941F0a619979";
const WALLET = process.env.DEMO_WALLET || "0x147e6e30f059efec279fcc3fd0e98a81f3edb7b7b5a89e3ecb675d2bb4145aa5";
const KEY = process.env.EXECUTOR_KEY;
const GROWER = process.env.DEMO_GROWER || "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC";
const INSURER = process.env.DEMO_INSURER || "randbAijaVXWYaMxLEvSv8twud84xUF3dv";

// Real wine regions in the southern hemisphere, where it is currently winter and frost is a genuine risk.
const VINEYARDS = [
  { name: "Marlborough, New Zealand", lat: -41.5, lon: 173.9 },
  { name: "Central Otago, New Zealand", lat: -45.0, lon: 169.2 },
  { name: "Río Negro, Argentina", lat: -39.0, lon: -67.6 },
  { name: "Bariloche, Argentina", lat: -41.1, lon: -71.3 },
  { name: "Casablanca Valley, Chile", lat: -33.3, lon: -71.4 },
];

const coston2 = defineChain({
  id: 114, name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const REQ = { type: "tuple", components: [
  { name: "url", type: "string" }, { name: "httpMethod", type: "string" }, { name: "headers", type: "string" },
  { name: "queryParams", type: "string" }, { name: "body", type: "string" },
  { name: "postProcessJq", type: "string" }, { name: "abiSignature", type: "string" },
] };
const RULE_ABI = [{ type: "function", name: "configure", stateMutability: "nonpayable", inputs: [
  { name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }, { name: "maxAmount", type: "uint256" },
  { name: "request", ...REQ }, { name: "expectedHash", type: "bytes32" },
  { name: "deadline", type: "uint256" }, { name: "fallbackRecipient", type: "string" },
], outputs: [] }];
const ACC_ABI = [{ type: "function", name: "setRule", stateMutability: "nonpayable",
  inputs: [{ name: "walletId", type: "bytes32" }, { name: "rule", type: "address" }], outputs: [] }];
const BOOL_SIG = '{"components":[{"internalType":"bool","name":"ok","type":"bool"}],"name":"task","type":"tuple"}';

async function tempAt({ lat, lon }) {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`);
  const j = await r.json();
  return j?.current?.temperature_2m;
}

async function main() {
  const mode = (process.argv[2] || "triggered").toLowerCase();
  if (!KEY) throw new Error("set EXECUTOR_KEY (the demo account's owner key)");
  if (!["armed", "triggered"].includes(mode)) throw new Error("usage: node demo-frost.mjs <armed|triggered>");

  const readings = [];
  for (const v of VINEYARDS) {
    const t = await tempAt(v).catch(() => undefined);
    if (typeof t === "number") readings.push({ ...v, t });
  }
  if (!readings.length) throw new Error("couldn't read any weather station");
  readings.sort((a, b) => a.t - b.t);
  const site = readings[0]; // the coldest right now

  // `triggered`: threshold just above the live reading, so the frost proven is real.
  // `armed`: a severe frost that plainly hasn't happened, so cover is live but unclaimed.
  const threshold = mode === "triggered" ? Math.ceil(site.t) + 1 : Math.floor(site.t) - 10;

  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  const request = {
    url: "https://api.open-meteo.com/v1/forecast",
    httpMethod: "GET", headers: "{}",
    queryParams: JSON.stringify({ latitude: String(site.lat), longitude: String(site.lon), current: "temperature_2m" }),
    body: "{}",
    postProcessJq: `{ok: (.current.temperature_2m <= ${threshold})}`,
    abiSignature: BOOL_SIG,
  };

  let h = await wallet.writeContract({ address: ACCOUNTS, abi: ACC_ABI, functionName: "setRule", args: [WALLET, RULE] });
  await pub.waitForTransactionReceipt({ hash: h });
  h = await wallet.writeContract({
    address: RULE, abi: RULE_ABI, functionName: "configure",
    args: [WALLET, GROWER, 3_000_000n, request, keccak256("0x0000000000000000000000000000000000000000000000000000000000000001"),
           BigInt(Math.floor(Date.now() / 1000) + 60 * 86400), INSURER],
  });
  await pub.waitForTransactionReceipt({ hash: h });

  const deadline = new Date(Date.now() + 60 * 86400e3).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  console.log(`
  ${site.name}  —  ${site.t}°C right now
  Cover: pay the grower up to 3 XRP if it drops to ${threshold}°C.
         Unclaimed by ${deadline}, it returns to the insurer.

  Status: ${mode === "triggered"
    ? `the frost HAS happened (${site.t} <= ${threshold}). It is not proven yet — the watcher takes ~2-3 min.`
    : `no frost this severe (${site.t} > ${threshold}). Cover is live and unclaimed; nobody can be paid.`}
`);
}

main().catch((e) => { console.error("failed:", e.message || e); process.exit(1); });
