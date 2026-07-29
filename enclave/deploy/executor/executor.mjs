// FXRP mint executor.
//
// After a Keyless "FXRP mint" account pays the FAssets Core Vault (an XRPL payment carrying the
// DIRECT_MINTING memo), the mint still needs one permissionless on-chain step: an *executor* proves the
// XRP payment via Flare's Data Connector (FDC) and calls AssetManager.executeDirectMinting(proof). FXRP
// then mints to the Flare address encoded in the memo. ANYONE can do this — including the user — so this
// script is that tool. It signs nothing on the user's behalf and can only complete a mint the user's own
// policy already authorised and paid for.
//
// Flow (Flare's canonical FDC pattern, see dev.flare.network/fdc + flare-hardhat-starter):
//   1. verifier /prepareRequest  -> abiEncodedRequest (validates the XRPL tx)
//   2. FdcHub.requestAttestation(abiEncodedRequest){value: fee}  -> lands in a voting round
//   3. wait until Relay.isFinalized(fdcProtocolId, roundId)
//   4. DA layer /proof-by-request-round-raw -> { response_hex, proof }
//   5. AssetManager.executeDirectMinting({ merkleProof: proof, data: decode(response_hex) })
//
// Usage:  node executor.mjs <xrpl-payment-tx-hash>
//
// Required env (see README):
//   RPC_URL              Coston2 C-chain RPC (default below)
//   EXECUTOR_KEY         0x-prefixed key with a little C2FLR (pays the attestation fee + gas; earns the fee)
//   VERIFIER_URL         Flare FDC verifier base, e.g. https://fdc-verifiers-testnet.flare.network
//   VERIFIER_API_KEY     testnet verifier X-API-KEY (obtain from Flare / the hackathon) -- REQUIRED
//   DA_LAYER_URL         Coston2 DA layer, e.g. https://ctn2-data-availability.flare.network
//   ATTESTATION_TYPE     default "Payment"  (confirm the type used for XRP direct-minting proofs)
//   SOURCE_ID            default "testXRP"
//   VERIFIER_XRP_PATH    default "xrp"      (verifier/<path>/<type>/prepareRequest)

import { createPublicClient, createWalletClient, http, defineChain, decodeAbiParameters, parseAbiParameters, toHex, pad, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const KEY = process.env.EXECUTOR_KEY;
const VERIFIER_URL = (process.env.VERIFIER_URL || "https://fdc-verifiers-testnet.flare.network").replace(/\/$/, "");
// Flare's public, rate-limited testnet verifier key — documented at dev.flare.network/fdc/getting-started
// and empirically confirmed against verifier/xrp/Payment/prepareRequest (200 vs 401 without it). Fine to
// commit; override with VERIFIER_API_KEY for a dedicated (non-rate-limited) verifier in production.
const VERIFIER_API_KEY = process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000";
const DA_LAYER_URL = (process.env.DA_LAYER_URL || "https://ctn2-data-availability.flare.network").replace(/\/$/, "");
const ATT_TYPE = process.env.ATTESTATION_TYPE || "Payment";
const SOURCE_ID = process.env.SOURCE_ID || "testXRP";
const XRP_PATH = process.env.VERIFIER_XRP_PATH || "xrp";

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

async function main() {
  const txHash = process.argv[2];
  if (!txHash) throw new Error("usage: node executor.mjs <xrpl-payment-tx-hash>");
  if (!KEY) throw new Error("set EXECUTOR_KEY");
  if (!VERIFIER_API_KEY) throw new Error("set VERIFIER_API_KEY (Flare testnet FDC verifier key)");
  if (!DA_LAYER_URL) throw new Error("set DA_LAYER_URL (Coston2 DA layer)");

  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  // 1) prepare the attestation request at the verifier
  const reqBody = { transactionId: txHash.startsWith("0x") ? txHash : `0x${txHash}`, proofOwner: "0x0000000000000000000000000000000000000000" };
  const url = `${VERIFIER_URL}/verifier/${XRP_PATH}/${ATT_TYPE}/prepareRequest`;
  console.log(`[1/5] prepareRequest -> ${url}`);
  const prep = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ attestationType: type32(ATT_TYPE), sourceId: type32(SOURCE_ID), requestBody: reqBody }),
  });
  if (!prep.ok) throw new Error(`verifier ${prep.status}: ${await prep.text()}`);
  const { abiEncodedRequest } = await prep.json();
  if (!abiEncodedRequest) throw new Error("verifier returned no abiEncodedRequest");

  // 2) submit to FdcHub with the request fee
  const fee = await pub.readContract({ address: ADDR.fdcRequestFeeConfigurations, abi: FEE_ABI, functionName: "getRequestFee", args: [abiEncodedRequest] });
  console.log(`[2/5] FdcHub.requestAttestation (fee ${fee} wei)`);
  const reqHash = await wallet.writeContract({ address: ADDR.fdcHub, abi: HUB_ABI, functionName: "requestAttestation", args: [abiEncodedRequest], value: fee });
  const rcpt = await pub.waitForTransactionReceipt({ hash: reqHash });
  const block = await pub.getBlock({ blockNumber: rcpt.blockNumber });

  // 3) round id from the block timestamp
  const [firstTs, dur] = await Promise.all([
    pub.readContract({ address: ADDR.flareSystemsManager, abi: FSM_ABI, functionName: "firstVotingRoundStartTs" }),
    pub.readContract({ address: ADDR.flareSystemsManager, abi: FSM_ABI, functionName: "votingEpochDurationSeconds" }),
  ]);
  const roundId = Number((BigInt(block.timestamp) - BigInt(firstTs)) / BigInt(dur));
  const protocolId = await pub.readContract({ address: ADDR.fdcVerification, abi: VERIF_ABI, functionName: "fdcProtocolId" });
  console.log(`[3/5] round ${roundId}; waiting for finalization…`);
  while (!(await pub.readContract({ address: ADDR.relay, abi: RELAY_ABI, functionName: "isFinalized", args: [BigInt(protocolId), BigInt(roundId)] }))) {
    await sleep(15000);
  }

  // 4) fetch the proof from the DA layer
  console.log(`[4/5] fetching proof from DA layer…`);
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
  console.log(`[5/5] AssetManager.executeDirectMinting…`);
  const hash = await wallet.writeContract({
    address: ADDR.assetManagerFXRP, abi: ASSET_MGR_ABI, functionName: "executeDirectMinting",
    args: [{ merkleProof: daResp.proof, data }],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`✓ minted. executeDirectMinting tx: ${hash}`);
}

main().catch((e) => { console.error("executor failed:", e.message || e); process.exit(1); });
