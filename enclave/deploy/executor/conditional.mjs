// Conditional-policy release executor.
//
// A Keyless "Conditional" account stays locked until a real-world condition is proven on-chain by Flare's
// Data Connector. This tool produces that proof: it asks the FDC to attest a LIVE Web2 API (the exact
// request the account pinned), waits for the voting round, fetches the Merkle proof, and calls
// ConditionalRule.release(). After that the account may pay its payee, up to its cap — and not before.
//
// Permissionless by design: release() trusts the PROOF, not the sender. That is only safe because the rule
// pins the whole request (url + query + jq + abi signature), so a proof of some *other* API returning the
// same value cannot release your condition. See ConditionalRule.sol for the attack this defends.
//
// Usage:
//   node conditional.mjs watch                         # poll every conditional account, auto-prove when true
//   node conditional.mjs check   <walletId>            # is the condition true right now? (no tx, no fee)
//   node conditional.mjs release <walletId> [key args] # attest + release one account now
//
// WATCH MODE is the intended deployment: accounts don't wait for anyone to press a button. The watcher
// replays `ConditionConfigured` events — which carry the FULL request, not just its hash — so it can
// rebuild each account's exact pinned question, read the live API to see whether it's true yet, and only
// then spend a fee on an attestation. Nothing privileged: the condition is self-describing on-chain, so
// anyone can run this, and the rule's request-pinning means a watcher cannot prove the wrong question.
//
// Env: EXECUTOR_KEY (funded Coston2 key) · RPC_URL · CONDITIONAL_RULE · VERIFIER_URL / VERIFIER_API_KEY /
//      DA_LAYER_URL · COSTON2_EXPLORER_API · POLL_SECONDS (default 60)

import { createPublicClient, createWalletClient, http, defineChain, decodeAbiParameters, decodeEventLog, toEventSelector, pad, stringToHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const KEY = process.env.EXECUTOR_KEY;
const RULE = process.env.CONDITIONAL_RULE || "0x2d8517BC464C70c21bBDBA48d3166a77A5019E77";
const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";
const POLL_MS = (Number(process.env.POLL_SECONDS) || 60) * 1000;
const VERIFIER_URL = (process.env.VERIFIER_URL || "https://fdc-verifiers-testnet.flare.network").replace(/\/$/, "");
const VERIFIER_API_KEY = process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000";
const DA_LAYER_URL = (process.env.DA_LAYER_URL || "https://ctn2-data-availability.flare.network").replace(/\/$/, "");
const ATT_TYPE = "Web2Json";
const SOURCE_ID = "PublicWeb2";

const ADDR = {
  fdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  fee: "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e",
  fsm: "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52",
  relay: "0xa10B672D1c62e5457b17af63d4302add6A99d7dE",
  fdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
};

// Coston2 explorer, so a logged transaction is one click from being verified rather than a hash you have
// to go and paste somewhere. Railway linkifies full URLs in its log viewer.
const EXPLORER_TX = (h) => `${(process.env.COSTON2_EXPLORER_URL || "https://coston2-explorer.flare.network").replace(/\/$/, "")}/tx/${h}`;

const coston2 = defineChain({
  id: 114, name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const BOOL_SIG = '{"components":[{"internalType":"bool","name":"ok","type":"bool"}],"name":"task","type":"tuple"}';

/** The condition templates a Keyless account can pin. Each is a REAL public API; jq carries the predicate,
 *  so the attested answer is a plain boolean and the committed value is always keccak(abi.encode(true)). */
export const CONDITIONS = {
  // Coinbase, NOT CoinGecko: providers each fetch the API and must agree, and CoinGecko's free tier
  // throttles them — measured, a CoinGecko attestation never reached consensus while a Coinbase one
  // submitted seconds later returned a proof in ~90s.
  xrpPriceAbove: (usd) => ({
    label: `XRP price is at or above $${usd}`,
    url: "https://api.coinbase.com/v2/prices/XRP-USD/spot",
    httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
    postProcessJq: `{ok: ((.data.amount|tonumber) >= ${usd})}`,
    abiSignature: BOOL_SIG,
  }),
  // Parametric trigger, mirroring Flare's weather-insurance example — but on Open-Meteo (no API key;
  // OpenWeatherMap's appid would end up published on-chain in the ConditionConfigured event).
  // Direction matters: frost cover wants "below", heat/drought cover wants "above".
  temperature: (dir, celsius, lat, lon) => ({
    label: `temperature at ${lat},${lon} ${dir === "above" ? "reaches" : "drops to"} ${celsius}C`,
    url: "https://api.open-meteo.com/v1/forecast",
    httpMethod: "GET", headers: "{}",
    queryParams: JSON.stringify({ latitude: String(lat), longitude: String(lon), current: "temperature_2m" }),
    body: "{}",
    postProcessJq: `{ok: (.current.temperature_2m ${dir === "above" ? ">=" : "<="} ${celsius})}`,
    abiSignature: BOOL_SIG,
  }),
  githubIssueClosed: (repo, num) => ({
    label: `${repo}#${num} is closed (milestone complete)`,
    url: `https://api.github.com/repos/${repo}/issues/${num}`,
    httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
    postProcessJq: '{ok: (.state == "closed")}',
    abiSignature: BOOL_SIG,
  }),
  githubPrMerged: (repo, num) => ({
    label: `${repo}#${num} is merged (work delivered)`,
    url: `https://api.github.com/repos/${repo}/pulls/${num}`,
    httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
    postProcessJq: "{ok: (.merged == true)}",
    abiSignature: BOOL_SIG,
  }),
};

const REQ_ABI = { type: "tuple", components: [
  { name: "url", type: "string" }, { name: "httpMethod", type: "string" }, { name: "headers", type: "string" },
  { name: "queryParams", type: "string" }, { name: "body", type: "string" },
  { name: "postProcessJq", type: "string" }, { name: "abiSignature", type: "string" },
] };
const RESP_ABI = { type: "tuple", components: [
  { name: "attestationType", type: "bytes32" }, { name: "sourceId", type: "bytes32" },
  { name: "votingRound", type: "uint64" }, { name: "lowestUsedTimestamp", type: "uint64" },
  { name: "requestBody", ...REQ_ABI },
  { name: "responseBody", type: "tuple", components: [{ name: "abiEncodedData", type: "bytes" }] },
] };
const RULE_ABI = [
  { type: "function", name: "requestHashOf", stateMutability: "pure", inputs: [{ name: "requestBody", ...REQ_ABI }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "conditionOf", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ name: "recipient", type: "bytes32" }, { name: "maxAmount", type: "uint256" }, { name: "requestHash", type: "bytes32" },
      { name: "expectedHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
      { name: "fallbackRecipient", type: "bytes32" }, { name: "spent", type: "uint256" },
      { name: "released", type: "bool" }, { name: "active", type: "bool" }] },
  { type: "function", name: "release", stateMutability: "nonpayable",
    inputs: [{ name: "walletId", type: "bytes32" }, { name: "proof", type: "tuple", components: [{ name: "merkleProof", type: "bytes32[]" }, { name: "data", ...RESP_ABI }] }], outputs: [] },
  // Carries the FULL request — this is what makes a watcher possible without any off-chain registry.
  { type: "event", name: "ConditionConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "recipient", type: "string" },
    { name: "maxAmount", type: "uint256" }, { name: "requestHash", type: "bytes32" },
    { name: "expectedHash", type: "bytes32" }, { name: "request", ...REQ_ABI },
    { name: "deadline", type: "uint256" }, { name: "fallbackRecipient", type: "string" },
  ] },
];

/**
 * Fetch JSON, tolerating an infrastructure error page. The explorer and DA layer front-ends return
 * plain-text gateway errors ("upstream connect error…") under load, and calling .json() on those throws —
 * which previously took down a whole watcher tick. Returns null instead so the caller can just retry.
 */
async function fetchJson(url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { console.error(`[fetch] ${res.status} non-JSON from ${new URL(url).host}: ${text.slice(0, 60)}`); return null; }
  } catch (e) {
    console.error(`[fetch] ${e.message || e}`);
    return null;
  }
}

const t32 = (s) => pad(stringToHex(s), { dir: "right", size: 32 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (c) => { const { label, ...r } = c; return r; };

/** Ask the FDC verifier to prepare (and thereby validate) an attestation of this request. */
async function prepare(cond) {
  const res = await fetch(`${VERIFIER_URL}/verifier/web2/${ATT_TYPE}/prepareRequest`, {
    method: "POST", headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ attestationType: t32(ATT_TYPE), sourceId: t32(SOURCE_ID), requestBody: strip(cond) }),
  });
  const j = await res.json();
  if (j.status !== "VALID") throw new Error(`verifier: ${j.status ?? JSON.stringify(j).slice(0, 200)}`);
  return j.abiEncodedRequest;
}

/**
 * What WOULD be attested right now — free, instant, no voting round. The verifier's `prepareResponse`
 * runs the exact same fetch + jq + abi-encode the real attestation performs, so this is a faithful
 * preview of the answer rather than a guess. Used to decide whether it's worth paying for an attestation
 * at all, and to show a live "true / not yet" readout.
 */
async function peek(cond) {
  const res = await fetch(`${VERIFIER_URL}/verifier/web2/${ATT_TYPE}/prepareResponse`, {
    method: "POST", headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ attestationType: t32(ATT_TYPE), sourceId: t32(SOURCE_ID), requestBody: strip(cond) }),
  });
  const j = await res.json();
  if (j.status !== "VALID") throw new Error(`verifier: ${j.status ?? "unknown"}`);
  return j.response.responseBody.abiEncodedData;
}

/** Fetch an attestation proof for a request in one specific round, or null if it isn't there. */
async function fetchProofInRound(abiEncodedRequest, round) {
  const j = await fetchJson(`${DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ votingRoundId: round, requestBytes: abiEncodedRequest }),
  });
  return j?.response_hex ? j : null;
}

/**
 * Find the proof for a request near a round. We can't just check the round WE submitted in: release() is
 * permissionless, so several watchers may be running, and the FDC deduplicates identical requests — only
 * the first one submitted gets attested, and everyone else's round stays empty forever. Whoever lost the
 * race would otherwise poll its own round indefinitely, re-request, get deduplicated again, and never
 * release. A proof stays valid regardless of who asked for it, so scanning a small window around the round
 * finds the winner's proof and lets any watcher finish the job. (Also absorbs an off-by-one at a round
 * boundary.)
 */
async function fetchProof(abiEncodedRequest, round, span = 3) {
  for (let d = 0; d <= span; d++) {
    for (const r of d === 0 ? [round] : [round - d, round + d]) {
      const hit = await fetchProofInRound(abiEncodedRequest, r);
      if (hit) return hit;
    }
  }
  return null;
}

/** Submit `proof` to release the account. Returns the tx hash, or null if the world said "not yet". */
async function releaseWith(pub, wallet, walletId, da, expectedHash, log = console.log) {
  const [data] = decodeAbiParameters([RESP_ABI], da.response_hex);
  const attested = data.responseBody.abiEncodedData;
  if (keccak256(attested) !== expectedHash.toLowerCase()) {
    log(`→ attested ${attested} — the condition is not met. Nothing released.`);
    return null;
  }
  const tx = await wallet.writeContract({ address: RULE, abi: RULE_ABI, functionName: "release", args: [walletId, { merkleProof: da.proof, data }] });
  await pub.waitForTransactionReceipt({ hash: tx });
  return tx;
}

/** Prove one account's condition: attest its pinned request via FDC, then release() on-chain. */
async function proveAndRelease(pub, wallet, walletId, cond, expectedHash, log = console.log) {
  log("[1/5] verifier prepareRequest…");
  const abiEncodedRequest = await prepare(cond);

  const fee = await pub.readContract({ address: ADDR.fee, abi: [{ type: "function", name: "getRequestFee", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "uint256" }] }], functionName: "getRequestFee", args: [abiEncodedRequest] });
  log(`[2/5] FdcHub.requestAttestation (fee ${fee} wei)…`);
  const h = await wallet.writeContract({ address: ADDR.fdcHub, abi: [{ type: "function", name: "requestAttestation", stateMutability: "payable", inputs: [{ type: "bytes" }], outputs: [] }], functionName: "requestAttestation", args: [abiEncodedRequest], value: fee });
  const rcpt = await pub.waitForTransactionReceipt({ hash: h });
  const blk = await pub.getBlock({ blockNumber: rcpt.blockNumber });

  const FSM = [{ type: "function", name: "firstVotingRoundStartTs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }, { type: "function", name: "votingEpochDurationSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
  const [first, dur] = await Promise.all([
    pub.readContract({ address: ADDR.fsm, abi: FSM, functionName: "firstVotingRoundStartTs" }),
    pub.readContract({ address: ADDR.fsm, abi: FSM, functionName: "votingEpochDurationSeconds" }),
  ]);
  const round = Number((BigInt(blk.timestamp) - BigInt(first)) / BigInt(dur));
  const pid = await pub.readContract({ address: ADDR.fdcVerification, abi: [{ type: "function", name: "fdcProtocolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "fdcProtocolId" });
  log(`[3/5] round ${round}; waiting for finalisation…`);
  while (!(await pub.readContract({ address: ADDR.relay, abi: [{ type: "function", name: "isFinalized", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "isFinalized", args: [BigInt(pid), BigInt(round)] }))) await sleep(15000);

  log("[4/5] fetching proof from the DA layer…");
  let da;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ votingRoundId: round, requestBytes: abiEncodedRequest }) });
    da = await r.json().catch(() => ({}));
    if (da?.response_hex) break;
    await sleep(10000);
  }
  if (!da?.response_hex) throw new Error("DA layer never returned a proof");
  const [data] = decodeAbiParameters([RESP_ABI], da.response_hex);
  const attested = data.responseBody.abiEncodedData;
  log(`   attested: ${attested}`);
  if (keccak256(attested) !== expectedHash.toLowerCase()) {
    log("→ the world has NOT met the condition yet. Nothing released.");
    return null;
  }

  log("[5/5] ConditionalRule.release…");
  const tx = await wallet.writeContract({ address: RULE, abi: RULE_ABI, functionName: "release", args: [walletId, { merkleProof: da.proof, data }] });
  await pub.waitForTransactionReceipt({ hash: tx });
  return tx;
}

const CONFIGURED_TOPIC = toEventSelector(RULE_ABI.find((f) => f.type === "event" && f.name === "ConditionConfigured"));

/** Every configured condition, rebuilt from ConditionConfigured events (which carry the full request). */
async function configuredConditions() {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${RULE}&topic0=${CONFIGURED_TOPIC}`;
  const j = await fetchJson(url, { cache: "no-store" });
  const logs = Array.isArray(j?.result) ? j.result : [];
  const out = new Map(); // walletId -> latest config
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: RULE_ABI, data: l.data, topics: l.topics });
      out.set(d.args.walletId, { walletId: d.args.walletId, request: d.args.request, expectedHash: d.args.expectedHash });
    } catch { /* skip undecodable */ }
  }
  return [...out.values()];
}

/** Is the condition satisfied right now? Free — so the watcher only pays a fee when it will actually pass. */
async function isTrueNow(request, expectedHash) {
  try {
    const attested = await peek(request);
    return { ok: keccak256(attested) === expectedHash.toLowerCase(), attested };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function watch(pub, wallet) {
  console.log(`[watch] polling conditional accounts every ${POLL_MS / 1000}s…`);
  // walletId -> { abiEncodedRequest, round, since }. Once an attestation is submitted we POLL that round
  // across ticks instead of re-requesting: the FDC deduplicates identical requests, so re-submitting the
  // same question never yields a second proof — it just burns a fee and waits forever. (Verified on
  // Coston2: the first request produced a proof; identical later ones returned "attestation request not
  // found" in every round.) An existing proof stays valid, so polling is also the cheapest path.
  const pending = new Map();

  for (;;) {
    try {
      const configs = await configuredConditions();
      for (const c of configs) {
       // Isolate each account: a flaky RPC/DA/verifier call for one must not abort the whole tick.
       try {
        const [, , , expectedHash, deadline, , , released, active] = await pub.readContract({ address: RULE, abi: RULE_ABI, functionName: "conditionOf", args: [c.walletId] });
        const short = c.walletId.slice(0, 10);
        if (!active || released) { pending.delete(c.walletId); continue; }
        // Past its deadline the rule refuses release(), so attesting would just burn a fee.
        if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) > deadline) {
          if (pending.delete(c.walletId)) console.log(`[watch] ${short}… deadline passed unproven — no longer attesting`);
          continue;
        }

        // Already waiting on a round? Just look for the proof — never re-request.
        const p = pending.get(c.walletId);
        if (p) {
          const da = await fetchProof(p.abiEncodedRequest, p.round);
          if (!da) {
            if (Date.now() - p.since > 20 * 60 * 1000) { console.log(`[watch] ${short}… round ${p.round} yielded nothing after 20m, will re-request`); pending.delete(c.walletId); }
            continue;
          }
          const tx = await releaseWith(pub, wallet, c.walletId, da, expectedHash, (m) => console.log(`   ${m}`));
          if (tx) console.log(`[watch] ✓ released ${short}…\n              ${EXPLORER_TX(tx)}`);
          pending.delete(c.walletId);
          continue;
        }

        // Not waiting yet: preview the answer for free, and only pay when it's actually true.
        const live = await isTrueNow(c.request, expectedHash);
        if (!live.ok) continue;

        console.log(`[watch] ${short}… condition is TRUE — requesting attestation (${c.request.url})`);
        const abiEncodedRequest = await prepare(c.request);
        // If this exact question was attested recently, reuse that proof rather than paying again.
        const fee = await pub.readContract({ address: ADDR.fee, abi: [{ type: "function", name: "getRequestFee", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "uint256" }] }], functionName: "getRequestFee", args: [abiEncodedRequest] });
        const h = await wallet.writeContract({ address: ADDR.fdcHub, abi: [{ type: "function", name: "requestAttestation", stateMutability: "payable", inputs: [{ type: "bytes" }], outputs: [] }], functionName: "requestAttestation", args: [abiEncodedRequest], value: fee });
        const rcpt = await pub.waitForTransactionReceipt({ hash: h });
        const blk = await pub.getBlock({ blockNumber: rcpt.blockNumber });
        const FSM = [{ type: "function", name: "firstVotingRoundStartTs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }, { type: "function", name: "votingEpochDurationSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
        const [first, dur] = await Promise.all([
          pub.readContract({ address: ADDR.fsm, abi: FSM, functionName: "firstVotingRoundStartTs" }),
          pub.readContract({ address: ADDR.fsm, abi: FSM, functionName: "votingEpochDurationSeconds" }),
        ]);
        const round = Number((BigInt(blk.timestamp) - BigInt(first)) / BigInt(dur));
        console.log(`[watch] ${short}… submitted, round ${round} — will collect the proof when it finalises`);
        pending.set(c.walletId, { abiEncodedRequest, round, since: Date.now() });
       } catch (e) {
        console.error(`[watch] ${c.walletId.slice(0, 10)}… tick failed (will retry): ${e.shortMessage || e.message || e}`);
       }
      }
    } catch (e) {
      console.error("[watch] loop error:", e.message || e);
    }
    await sleep(POLL_MS);
  }
}

async function main() {
  const [mode, walletId, ...rest] = process.argv.slice(2);
  if (!KEY) throw new Error("set EXECUTOR_KEY");
  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  if (mode === "watch") return watch(pub, wallet);
  if (!mode || !walletId) throw new Error("usage: node conditional.mjs <watch|check|release> [walletId] [conditionKey args…]");

  const key = rest[0] || "xrpPriceAbove";
  const args = rest.slice(1).length ? rest.slice(1) : [1];
  const cond = CONDITIONS[key](...args);
  console.log(`condition: ${cond.label}`);

  const [, maxAmount, requestHash, expectedHash, , released, active] =
    await pub.readContract({ address: RULE, abi: RULE_ABI, functionName: "conditionOf", args: [walletId] });
  if (!active) throw new Error("no active condition on this account");
  if (released) { console.log("already proven — the account can pay its payee."); return; }
  const ours = await pub.readContract({ address: RULE, abi: RULE_ABI, functionName: "requestHashOf", args: [strip(cond)] });
  if (ours.toLowerCase() !== requestHash.toLowerCase()) {
    throw new Error(`this account pinned a different request (${requestHash}); refusing to attest the wrong question`);
  }

  if (mode === "check") {
    const live = await isTrueNow(strip(cond), expectedHash);
    console.log(`right now: ${live.ok ? "TRUE — ready to prove" : "not true yet"}${live.attested ? ` (attested ${live.attested})` : ""}`);
    console.log(`cap ${maxAmount} drops`);
    return;
  }

  const tx = await proveAndRelease(pub, wallet, walletId, strip(cond), expectedHash);
  if (tx) {
    console.log(`✓ condition proven on-chain. release tx: ${tx}`);
    console.log("  the account may now pay its pinned payee, up to its cap.");
  }
}

main().catch((e) => { console.error("failed:", e.message || e); process.exit(1); });
