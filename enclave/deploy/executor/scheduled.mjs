// Scheduled-payments executor.
//
// A Keyless "Scheduled payments" account holds a standing order: a fixed amount, to a fixed payee, on a
// fixed calendar slot. The rule refuses everything else — but it doesn't move money on its own. Something
// has to notice a line has come due and call pay(). That is this.
//
// Usage:
//   node scheduled.mjs watch              # run every line the moment it falls due
//   node scheduled.mjs due                # what's due right now, across every account (no tx)
//   node scheduled.mjs run <walletId>     # run one account's due lines now
//
// Nothing privileged is happening here. `pay` is permissionless and every field of a line is pinned
// on-chain, so this executor has no discretion at all: it cannot choose a payee, an amount, or a moment.
// The worst a hostile copy of this script can do is run your payroll on time. That is exactly why the
// automation is safe to hand to a stranger's machine — see ScheduledRule.sol.
//
// Two things it deliberately does NOT do:
//
//   * Catch up. If this has been down for three months, the rule pays once and moves the slot forward.
//     The executor doesn't try to make up the difference, because the rule wouldn't let it anyway.
//   * Pay from an account that can't cover it. authorize() advances nextDue BEFORE the enclave submits,
//     so an underfunded attempt burns the slot — a missed run, not a late one. Checking the ledger first
//     costs nothing and is the difference between a skipped payday and a paid one.
//
// Env: EXECUTOR_KEY (funded Coston2 key) · RPC_URL · SCHEDULED_RULE · KEYLESS_ACCOUNTS ·
//      COSTON2_EXPLORER_API · XRPL_RPC · POLL_SECONDS (default 60)

import { createPublicClient, createWalletClient, http, defineChain, decodeEventLog, toEventSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const KEY = process.env.EXECUTOR_KEY;
const RULE = process.env.SCHEDULED_RULE || "0x683bDB59E9B7Fb43fAfdf9B84A86d794dBf7Be84";
const ACCOUNTS = process.env.KEYLESS_ACCOUNTS || "0x57eb332D7000752ee82a35cc1A75941F0a619979";
const EXPLORER = process.env.COSTON2_EXPLORER_API || "https://coston2-explorer.flare.network/api";
const XRPL_RPC = process.env.XRPL_RPC || "https://s.altnet.rippletest.net:51234";
const POLL_MS = (Number(process.env.POLL_SECONDS) || 60) * 1000;

// KeylessAccounts.pay is payable: the fee funds the enclave instruction, same as INIT.
const PAY_FEE = BigInt(process.env.PAY_FEE || "1000");

const coston2 = defineChain({
  id: 114, name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const RULE_ABI = [
  // Carries the payee in the clear — the rule stores only keccak(recipient), so replaying these events is
  // the only way an executor can learn who to pay. No off-chain registry, nothing to keep in sync.
  { type: "event", name: "LineAdded", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "index", type: "uint256", indexed: true },
    { name: "recipient", type: "string" }, { name: "amount", type: "uint256" },
    { name: "unit", type: "uint8" }, { name: "offsetDays", type: "uint8" },
    { name: "runs", type: "uint32" }, { name: "firstDue", type: "uint64" },
  ] },
  { type: "event", name: "ScheduleConfigured", inputs: [
    { name: "walletId", type: "bytes32", indexed: true }, { name: "lineCount", type: "uint256" },
  ] },
  { type: "event", name: "ScheduleCancelled", inputs: [{ name: "walletId", type: "bytes32", indexed: true }] },
  { type: "function", name: "lineCount", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "linesOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [
    { name: "payee", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "nextDue", type: "uint64" },
    { name: "runsLeft", type: "uint32" }, { name: "unit", type: "uint8" }, { name: "offsetDays", type: "uint8" },
    { name: "active", type: "bool" },
  ] },
];

const ACCOUNTS_ABI = [
  { type: "function", name: "pay", stateMutability: "payable", inputs: [
    { name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" },
    { name: "amount", type: "uint256" }, { name: "paymentReference", type: "bytes32" },
  ], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "xrplAddressOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ruleOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
];

const ZERO_REF = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DROPS = 1_000_000n;
const xrp = (d) => `${(Number(d) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} XRP`;
const short = (id) => `${id.slice(0, 10)}…`;

/** A gateway that answers with plain text on a bad day would otherwise kill the whole tick. */
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url} returned ${res.status} ${body.slice(0, 120)}`);
  }
}

/** Every payee this rule has ever been told about, keyed by keccak(recipient) so a line can be matched. */
const LINE_ADDED_TOPIC = toEventSelector(RULE_ABI.find((f) => f.type === "event" && f.name === "LineAdded"));

async function knownPayees() {
  const url = `${EXPLORER}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${RULE}&topic0=${LINE_ADDED_TOPIC}`;
  const j = await fetchJson(url, { cache: "no-store" });
  const logs = Array.isArray(j?.result) ? j.result : [];
  const byWallet = new Map(); // walletId -> Set<recipient string>
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: RULE_ABI, data: l.data, topics: l.topics });
      if (!byWallet.has(d.args.walletId)) byWallet.set(d.args.walletId, new Set());
      byWallet.get(d.args.walletId).add(d.args.recipient);
    } catch { /* skip undecodable */ }
  }
  return byWallet;
}

/** Live XRP balance in drops, or null if the ledger can't be reached (never guess — see the header). */
async function xrplBalance(address) {
  if (!address) return null;
  try {
    const j = await fetchJson(XRPL_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "account_info", params: [{ account: address, ledger_index: "validated" }] }),
    });
    const err = j?.result?.error;
    if (err === "actNotFound") return 0n; // never funded: a real answer, not a failure
    if (err) return null;
    return BigInt(j?.result?.account_data?.Balance ?? 0);
  } catch {
    return null;
  }
}

/**
 * Lines that have come due for one account, resolved back to their payee strings.
 *
 * The rule keeps only keccak(recipient), so this walks the wallet's own LineAdded history and hashes each
 * candidate to find which one a stored line refers to.
 */
async function dueLines(pub, walletId, payees) {
  const count = await pub.readContract({ address: RULE, abi: RULE_ABI, functionName: "lineCount", args: [walletId] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { keccak256, stringToHex } = await import("viem");
  const byHash = new Map([...(payees ?? [])].map((r) => [keccak256(stringToHex(r)).toLowerCase(), r]));

  const due = [];
  for (let i = 0n; i < count; i++) {
    const [payee, amount, nextDue, runsLeft, , , active] =
      await pub.readContract({ address: RULE, abi: RULE_ABI, functionName: "linesOf", args: [walletId, i] });
    if (!active || now < nextDue) continue;
    const recipient = byHash.get(payee.toLowerCase());
    if (!recipient) {
      console.warn(`[scheduled] ${short(walletId)} line ${i} is due but its payee isn't in any LineAdded event — skipping`);
      continue;
    }
    due.push({ index: Number(i), recipient, amount, runsLeft: Number(runsLeft) });
  }
  return due;
}

/** Run one account's due lines, cheapest checks first. */
async function runAccount(pub, wallet, walletId, payees, { dryRun = false } = {}) {
  const due = await dueLines(pub, walletId, payees);
  if (!due.length) return 0;

  // A line whose account can't cover it must not be attempted: authorize() would advance nextDue and the
  // submission would fail, turning a fundable payment into a permanently missed one.
  const xrplAddr = await pub.readContract({ address: ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "xrplAddressOf", args: [walletId] });
  const balance = await xrplBalance(xrplAddr);
  const owed = due.reduce((t, d) => t + d.amount, 0n);
  if (balance === null) {
    console.warn(`[scheduled] ${short(walletId)} can't read the ledger right now — leaving ${due.length} line(s) for the next tick`);
    return 0;
  }
  // The ledger's 1 XRP base reserve can never be spent, so it isn't available to pay anyone.
  const spendable = balance > DROPS ? balance - DROPS : 0n;
  if (spendable < owed) {
    console.warn(`[scheduled] ${short(walletId)} underfunded: ${xrp(owed)} due, ${xrp(spendable)} spendable — skipping (the slot stays open until it's funded)`);
    return 0;
  }

  let ran = 0;
  for (const d of due) {
    if (dryRun) {
      console.log(`[scheduled] ${short(walletId)} line ${d.index}: ${xrp(d.amount)} -> ${d.recipient} (${d.runsLeft} run(s) left)`);
      ran++;
      continue;
    }
    try {
      const h = await wallet.writeContract({
        address: ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "pay",
        args: [walletId, d.recipient, d.amount, ZERO_REF], value: PAY_FEE,
      });
      await pub.waitForTransactionReceipt({ hash: h });
      console.log(`[scheduled] ✓ ${short(walletId)} paid ${xrp(d.amount)} -> ${d.recipient}  ${h}`);
      ran++;
    } catch (e) {
      // Someone else may have run this line first — pay is permissionless, so a lost race is normal.
      console.warn(`[scheduled] ${short(walletId)} line ${d.index} didn't go through: ${e.shortMessage || e.message || e}`);
    }
  }
  return ran;
}

async function watch(pub, wallet) {
  console.log(`[scheduled] polling every ${POLL_MS / 1000}s — rule ${RULE}`);
  for (;;) {
    try {
      const payees = await knownPayees();
      for (const [walletId, set] of payees) {
        // Isolate each account: one flaky read must not abort the tick for everyone else.
        try {
          // An account that has moved off this rule keeps its stored lines, but the rule no longer governs
          // it — paying would revert anyway, so don't spend gas discovering that.
          const activeRule = await pub.readContract({ address: ACCOUNTS, abi: ACCOUNTS_ABI, functionName: "ruleOf", args: [walletId] });
          if (activeRule.toLowerCase() !== RULE.toLowerCase()) continue;
          await runAccount(pub, wallet, walletId, set);
        } catch (e) {
          console.error(`[scheduled] ${short(walletId)} tick failed (will retry): ${e.shortMessage || e.message || e}`);
        }
      }
    } catch (e) {
      console.error("[scheduled] loop error:", e.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main() {
  const [mode, walletId] = process.argv.slice(2);
  if (!KEY && mode !== "due") throw new Error("set EXECUTOR_KEY (a funded Coston2 key)");

  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = KEY
    ? createWalletClient({ account: privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`), chain: coston2, transport: http(RPC) })
    : null;

  if (mode === "watch") return watch(pub, wallet);

  const payees = await knownPayees();
  if (mode === "due") {
    let n = 0;
    for (const [id, set] of payees) n += await runAccount(pub, wallet, id, set, { dryRun: true });
    return console.log(n ? `${n} line(s) due now.` : "Nothing is due.");
  }
  if (mode === "run") {
    if (!walletId) throw new Error("usage: node scheduled.mjs run <walletId>");
    const n = await runAccount(pub, wallet, walletId, payees.get(walletId) ?? new Set());
    return console.log(n ? `Ran ${n} line(s).` : "Nothing was due for that account.");
  }
  throw new Error("usage: node scheduled.mjs <watch|due|run> [walletId]");
}

main().catch((e) => { console.error("failed:", e.message || e); process.exit(1); });
