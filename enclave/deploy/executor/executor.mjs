// FXRP mint executor.
//
// After a Keyless FXRP account pays the FAssets Core Vault (an XRPL payment carrying the DIRECT_MINTING
// memo), the mint still needs one permissionless on-chain step: an *executor* proves the XRP payment via
// Flare's Data Connector (FDC) and calls AssetManager.executeDirectMinting(proof). FXRP then mints to the
// Flare address in the memo. ANYONE can do this — including the user — so this script is that tool. It
// signs nothing on the user's behalf and can only complete a mint the user's own policy already paid for.
//
// Why this exists: Flare does NOT relay executeDirectMinting (unlike FSA vault deposit/redeem, which
// Flare's own executor auto-completes). So mint is the one step that otherwise waits for a random bot —
// running this watcher against your own accounts completes mints as soon as the FDC round finalises.
//
// Modes:
//   node executor.mjs <xrpl-payment-tx-hash>   complete one mint (the tx must be a Core-Vault payment)
//   node executor.mjs watch                    poll all Keyless accounts and auto-complete pending mints
//
// FDC flow (Flare's canonical pattern, see dev.flare.network/fdc + flare-hardhat-starter):
//   1. verifier /prepareRequest  -> abiEncodedRequest (validates the XRPL tx)
//   2. FdcHub.requestAttestation(abiEncodedRequest){value: fee}  -> lands in a voting round
//   3. wait until Relay.isFinalized(fdcProtocolId, roundId)
//   4. DA layer /proof-by-request-round-raw -> { response_hex, proof }
//   5. AssetManager.executeDirectMinting({ merkleProof: proof, data: decode(response_hex) })
//
// Required env (see README):
//   EXECUTOR_KEY         0x-prefixed key with a little C2FLR (pays the attestation fee + gas; earns the fee)
//   RPC_URL              Coston2 C-chain RPC (has a default)
//   VERIFIER_URL / VERIFIER_API_KEY / DA_LAYER_URL   FDC verifier + DA layer (public testnet defaults below)
//   KEYLESS_ACCOUNTS     KeylessAccounts manager (default below) — watch mode enumerates its wallets
//   XRPL_RPC             XRPL testnet JSON-RPC (default below) — watch mode reads each account's payments
//   POLL_SECONDS         watch loop interval (default 30)

import { createPublicClient, createWalletClient, http, defineChain, decodeAbiParameters, pad, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const KEY = process.env.EXECUTOR_KEY;
const VERIFIER_URL = (process.env.VERIFIER_URL || "https://fdc-verifiers-testnet.flare.network").replace(/\/$/, "");
// Flare's public, rate-limited testnet verifier key (dev.flare.network/fdc/getting-started). Fine to commit;
// override with VERIFIER_API_KEY for a dedicated (non-rate-limited) verifier in production.
const VERIFIER_API_KEY = process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000";
const DA_LAYER_URL = (process.env.DA_LAYER_URL || "https://ctn2-data-availability.flare.network").replace(/\/$/, "");
// Direct minting verifies IXRPPayment (type "XRPPayment", requestBody {transactionId, proofOwner}) — NOT the
// generic "Payment". Confirmed against verifier/xrp/XRPPayment/prepareRequest.
const ATT_TYPE = process.env.ATTESTATION_TYPE || "XRPPayment";
const SOURCE_ID = process.env.SOURCE_ID || "testXRP";
const XRP_PATH = process.env.VERIFIER_XRP_PATH || "xrp";

// Watch-mode config.
const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";
const KEYLESS_ACCOUNTS = process.env.KEYLESS_ACCOUNTS || "0x57eb332D7000752ee82a35cc1A75941F0a619979";
const XRPL_RPC = process.env.XRPL_RPC || "https://s.altnet.rippletest.net:51234/";
const POLL_MS = (Number(process.env.POLL_SECONDS) || 30) * 1000;
// KeylessAccounts.WalletCreated(bytes32 indexed walletId, address indexed owner, bytes32 initInstructionId)
const WALLET_CREATED_TOPIC = "0xac5b1cdce61c84ea0a95f1a97d5107f0b5fd19743e6400bce9e8a822fb2bc4ba";
// FAssets Core Vault XRPL deposit address (mint destination) + the DIRECT_MINTING memo prefix.
const CORE_VAULT = process.env.CORE_VAULT || "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p";
const MINT_MEMO_PREFIX = "4642505266410018";

// Coston2 addresses (from config/coston2/deployed-addresses.json + AssetManagerFXRP).
const ADDR = {
  fdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  fdcRequestFeeConfigurations: "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e",
  flareSystemsManager: "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52",
  relay: "0xa10B672D1c62e5457b17af63d4302add6A99d7dE",
  fdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
  assetManagerFXRP: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
};

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// --- ABIs (minimal) -----------------------------------------------------------------------------
const FEE_ABI = [{ type: "function", name: "getRequestFee", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "uint256" }] }];
const HUB_ABI = [{ type: "function", name: "requestAttestation", stateMutability: "payable", inputs: [{ type: "bytes" }], outputs: [] }];
const FSM_ABI = [
  { type: "function", name: "firstVotingRoundStartTs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "votingEpochDurationSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
];
const RELAY_ABI = [{ type: "function", name: "isFinalized", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const VERIF_ABI = [{ type: "function", name: "fdcProtocolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];
const ACCOUNTS_ABI = [{ type: "function", name: "xrplAddressOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }] }];

// IXRPPayment.Proof — from flare periphery src/coston2/IXRPPayment.sol (XRP-specific direct-minting type).
const XRP_RESPONSE = {
  type: "tuple",
  components: [
    { name: "attestationType", type: "bytes32" },
    { name: "sourceId", type: "bytes32" },
    { name: "votingRound", type: "uint64" },
    { name: "lowestUsedTimestamp", type: "uint64" },
    { name: "requestBody", type: "tuple", components: [
      { name: "transactionId", type: "bytes32" },
      { name: "proofOwner", type: "address" },
    ] },
    { name: "responseBody", type: "tuple", components: [
      { name: "blockNumber", type: "uint64" },
      { name: "blockTimestamp", type: "uint64" },
      { name: "sourceAddress", type: "string" },
      { name: "sourceAddressHash", type: "bytes32" },
      { name: "receivingAddressHash", type: "bytes32" },
      { name: "intendedReceivingAddressHash", type: "bytes32" },
      { name: "spentAmount", type: "int256" },
      { name: "intendedSpentAmount", type: "int256" },
      { name: "receivedAmount", type: "int256" },
      { name: "intendedReceivedAmount", type: "int256" },
      { name: "hasMemoData", type: "bool" },
      { name: "firstMemoData", type: "bytes" },
      { name: "hasDestinationTag", type: "bool" },
      { name: "destinationTag", type: "uint256" },
      { name: "status", type: "uint8" },
    ] },
  ],
};
const ASSET_MGR_ABI = [{
  type: "function", name: "executeDirectMinting", stateMutability: "payable",
  inputs: [{ name: "_payment", type: "tuple", components: [{ name: "merkleProof", type: "bytes32[]" }, { name: "data", ...XRP_RESPONSE }] }],
  outputs: [],
}];

const type32 = (s) => pad(stringToHex(s), { dir: "right", size: 32 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// executeDirectMinting reverts PaymentAlreadyConfirmed() (selector 0x18dce79f) for an already-minted deposit.
const isAlreadyMinted = (e) => String(e?.message ?? e).includes("0x18dce79f") || /PaymentAlreadyConfirmed/i.test(String(e?.message ?? e));

// Complete one mint: prove the XRPL payment via FDC, then executeDirectMinting. Returns the Flare tx hash.
async function completeMint(pub, wallet, txHash, log = console.log) {
  const tx = txHash.startsWith("0x") ? txHash : `0x${txHash}`;

  // 1) prepare the attestation request at the verifier
  const url = `${VERIFIER_URL}/verifier/${XRP_PATH}/${ATT_TYPE}/prepareRequest`;
  const prep = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ attestationType: type32(ATT_TYPE), sourceId: type32(SOURCE_ID), requestBody: { transactionId: tx, proofOwner: "0x0000000000000000000000000000000000000000" } }),
  });
  if (!prep.ok) throw new Error(`verifier ${prep.status}: ${await prep.text()}`);
  const { abiEncodedRequest } = await prep.json();
  if (!abiEncodedRequest) throw new Error("verifier returned no abiEncodedRequest");

  // 2) submit to FdcHub with the request fee
  const fee = await pub.readContract({ address: ADDR.fdcRequestFeeConfigurations, abi: FEE_ABI, functionName: "getRequestFee", args: [abiEncodedRequest] });
  log(`  requestAttestation (fee ${fee} wei)…`);
  const reqHash = await wallet.writeContract({ address: ADDR.fdcHub, abi: HUB_ABI, functionName: "requestAttestation", args: [abiEncodedRequest], value: fee });
  const rcpt = await pub.waitForTransactionReceipt({ hash: reqHash });
  const block = await pub.getBlock({ blockNumber: rcpt.blockNumber });

  // 3) round id from the block timestamp, then wait for finalization
  const [firstTs, dur] = await Promise.all([
    pub.readContract({ address: ADDR.flareSystemsManager, abi: FSM_ABI, functionName: "firstVotingRoundStartTs" }),
    pub.readContract({ address: ADDR.flareSystemsManager, abi: FSM_ABI, functionName: "votingEpochDurationSeconds" }),
  ]);
  const roundId = Number((BigInt(block.timestamp) - BigInt(firstTs)) / BigInt(dur));
  const protocolId = await pub.readContract({ address: ADDR.fdcVerification, abi: VERIF_ABI, functionName: "fdcProtocolId" });
  log(`  round ${roundId}; waiting for finalization…`);
  while (!(await pub.readContract({ address: ADDR.relay, abi: RELAY_ABI, functionName: "isFinalized", args: [BigInt(protocolId), BigInt(roundId)] }))) {
    await sleep(15000);
  }

  // 4) fetch the proof from the DA layer
  let daResp;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }),
    });
    daResp = await r.json().catch(() => ({}));
    if (daResp?.response_hex) break;
    await sleep(10000);
  }
  if (!daResp?.response_hex) throw new Error("DA layer never returned a proof");
  const [data] = decodeAbiParameters([XRP_RESPONSE], daResp.response_hex);

  // 5) execute the mint
  const hash = await wallet.writeContract({
    address: ADDR.assetManagerFXRP, abi: ASSET_MGR_ABI, functionName: "executeDirectMinting",
    args: [{ merkleProof: daResp.proof, data }],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// --- watch mode helpers ---------------------------------------------------------------------------

// Every Keyless account's XRPL address, from WalletCreated events -> walletId -> xrplAddressOf.
async function keylessXrplAddresses(pub) {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${KEYLESS_ACCOUNTS}&topic0=${WALLET_CREATED_TOPIC}`;
  const json = await (await fetch(url, { cache: "no-store" })).json();
  const walletIds = [...new Set((json.result || []).map((l) => l.topics?.[1]).filter(Boolean))];
  const out = [];
  for (const wid of walletIds) {
    const x = await pub.readContract({ address: KEYLESS_ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [wid] }).catch(() => "");
    if (x) out.push(x);
  }
  return out;
}

// Recent Core-Vault mint payments from one XRPL account (Payment to the Core Vault carrying a DIRECT_MINTING memo).
async function pendingMintTxs(xrplAddr) {
  const r = await fetch(XRPL_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "account_tx", params: [{ account: xrplAddr, ledger_index_min: -1, ledger_index_max: -1, limit: 20 }] }),
  });
  const j = await r.json().catch(() => ({}));
  const txs = j?.result?.transactions || [];
  const out = [];
  for (const t of txs) {
    const tx = t.tx || t.tx_json || {};
    if (tx.TransactionType !== "Payment" || tx.Destination !== CORE_VAULT) continue;
    const memo = (tx.Memos?.[0]?.Memo?.MemoData || "").toLowerCase();
    if (!memo.startsWith(MINT_MEMO_PREFIX)) continue;
    const hash = tx.hash || t.hash;
    if (hash) out.push(hash);
  }
  return out;
}

async function watch(pub, wallet) {
  const seen = new Set(); // tx hashes already minted or in flight this run
  let bootstrapped = false; // first pass records existing deposits WITHOUT minting them (avoid backfilling
                            // ~90s + a fee onto already-minted history); we only complete mints seen afterwards
  console.log(`[watch] polling Keyless accounts every ${POLL_MS / 1000}s for new FXRP mints…`);
  for (;;) {
    try {
      const addrs = await keylessXrplAddresses(pub);
      let backlog = 0;
      for (const a of addrs) {
        let hashes = [];
        try { hashes = await pendingMintTxs(a); } catch { /* XRPL RPC hiccup — try next loop */ }
        for (const h of hashes) {
          if (seen.has(h)) continue;
          if (!bootstrapped) { seen.add(h); backlog++; continue; } // skip pre-existing deposits on startup
          console.log(`[watch] completing mint ${h} (${a})`);
          try {
            const minted = await completeMint(pub, wallet, h, (m) => console.log(`   ${m}`));
            seen.add(h);
            console.log(`[watch] ✓ minted ${h} -> ${minted}`);
          } catch (e) {
            if (isAlreadyMinted(e)) { seen.add(h); /* someone (Flare bot or us) already did it */ }
            else console.error(`[watch] mint ${h} failed: ${e.message || e}`);
          }
        }
      }
      if (!bootstrapped) { bootstrapped = true; console.log(`[watch] ${addrs.length} accounts, ${backlog} existing deposits skipped — watching for new mints. (Use the single-tx mode to backfill a specific one.)`); }
    } catch (e) {
      console.error("[watch] loop error:", e.message || e);
    }
    await sleep(POLL_MS);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!KEY) throw new Error("set EXECUTOR_KEY");
  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  if (arg === "watch") {
    await watch(pub, wallet);
  } else if (arg) {
    console.log(`completing mint for ${arg}…`);
    const hash = await completeMint(pub, wallet, arg);
    console.log(`✓ minted. executeDirectMinting tx: ${hash}`);
  } else {
    throw new Error("usage: node executor.mjs <xrpl-payment-tx-hash> | watch");
  }
}

main().catch((e) => { console.error("executor failed:", e.message || e); process.exit(1); });
