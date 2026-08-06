import { encodeFunctionData, BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem";
import { publicClient } from "./clients";
import { ADDRESSES, RULES } from "./keyless";

// The Exchange-&-allowlist demo account below was provisioned on the standalone AllowlistRule, which is
// now folded into ExchangeRule (allowlist == exchange with no tag/cap) and no longer a pickable template.
// The contract stays deployed, so the read-only dry-run still faithfully demonstrates the allowlist
// behaviour. Hardcoded here rather than via RULES since it's no longer in the template map.
// The Spending-limit demo account was provisioned on RateLimitRule v1; the app now uses v2 (adds optional
// allowlist + per-payment cap). The v1 contract stays deployed, so the read-only demo still works.

/**
 * The engine behind the no-login showcase (/see). Each "try" is a READ-ONLY dry-run of the real
 * deployed rule's `authorize()` — we `eth_call` it with `from` spoofed as KeylessAccounts (to pass the
 * rule's onlyAccounts gate). The verdict (allowed, or the refusal reason) is genuinely computed by the
 * live rule contract on Coston2. No gas, no wallet, no XRP moved, no enclave needed — it only reads
 * on-chain rule config, so the showcase works even when the app/enclave is down.
 */

// Every rule implements this one function (IKeylessRule), plus the shared Rejected(reason) error.
const AUTHORIZE_ABI = [
  {
    type: "function",
    name: "authorize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "walletId", type: "bytes32" },
      { name: "recipient", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "paymentReference", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "error", name: "Rejected", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "NotAccounts", inputs: [] },
] as const;

const REF = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export type Verdict = { allowed: boolean; reason?: string };

/** Dry-run the real rule. `allowed` means the enclave would sign; otherwise `reason` is why it refused. */
export async function dryRunAuthorize(
  rule: `0x${string}`,
  walletId: `0x${string}`,
  recipient: string,
  amountDrops: bigint,
): Promise<Verdict> {
  try {
    await publicClient.call({
      account: ADDRESSES.accounts, // spoof msg.sender = KeylessAccounts to pass onlyAccounts
      to: rule,
      data: encodeFunctionData({ abi: AUTHORIZE_ABI, functionName: "authorize", args: [walletId, recipient, amountDrops, REF] }),
    });
    return { allowed: true };
  } catch (e) {
    const reason = revertReason(e);
    if (reason) return { allowed: false, reason };
    if (e instanceof BaseError) return { allowed: false, reason: e.shortMessage };
    return { allowed: false, reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/** The custom errors every rule can throw, from KeylessRuleBase. */
const RULE_ERRORS = [
  { type: "error", name: "Rejected", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "NotAccounts", inputs: [] },
  { type: "error", name: "NotWalletOwner", inputs: [] },
  { type: "error", name: "Locked", inputs: [] },
] as const;

/**
 * Pull the rule's own words out of a failed call.
 *
 * `publicClient.call` is given raw calldata and no ABI, so viem has nothing to decode a custom error
 * against and reports "an unknown reason" — which is how a perfectly good refusal ("condition not proven
 * yet") reached the page as a shrug. The whole point of this page is that the rule explains itself.
 *
 * The revert bytes are not where you would expect: viem surfaces them on the RpcRequestError deep in the
 * cause chain, and ExecutionRevertedError above it drops them. So walk the chain for the first thing
 * carrying hex rather than matching on any one error class.
 */
type MaybeCause = { data?: unknown; cause?: unknown };

function revertData(e: unknown): `0x${string}` | undefined {
  let c = e as MaybeCause | undefined;
  for (let depth = 0; c && depth < 8; depth++) {
    const d = c.data;
    const nested = (d as MaybeCause | undefined)?.data;
    const hex = typeof d === "string" ? d : typeof nested === "string" ? nested : undefined;
    if (hex?.startsWith("0x") && hex.length >= 10) return hex as `0x${string}`;
    c = c.cause as MaybeCause | undefined;
  }
  return undefined;
}

function revertReason(e: unknown): string | undefined {
  const hex = revertData(e);
  if (hex) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: RULE_ERRORS, data: hex });
      if (errorName === "Rejected") {
        const r = args?.[0];
        if (typeof r === "string" && r) return r;
      }
      if (errorName === "Locked") return "this account's policy is locked";
      if (errorName) return errorName;
    } catch { /* not one of ours — fall through */ }
  }
  if (e instanceof BaseError) {
    const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const r = (rev.data?.args?.[0] as string) ?? rev.reason;
      if (r) return r;
    }
  }
  return undefined;
}

export const XRP = 1_000_000n;

/** A tryable scenario shown in the showcase. */
export type Scenario = { label: string; recipient: string; amountXrp: number; attack?: boolean };

export type Demo = {
  key: string;
  name: string;
  walletId: `0x${string}`;
  rule: `0x${string}`;
  /** The account's real XRPL address, reported back by the enclave after INIT. Shown so "test it" means
   *  testing a specific account you can go and look up, not an anonymous one we assert exists. */
  xrplAddress: string;
  /** Human summary of the account's live configuration. */
  config: string;
  /** What this account is for, in one line. */
  scene: string;
  presets: Scenario[];
};

/** The demo accounts, pre-configured on-chain. walletIds are deterministic (walletIdFor(deployer, fixed
 *  salt)), so they're stable. Every one runs on the SAME rule deployment a new account gets today — the
 *  first pair used to point at a retired AllowlistRule and RateLimit v1, on wallets that didn't even exist
 *  on the current manager, so the page was proving contracts nobody is given any more. */
export const DEMOS: Demo[] = [
  {
    key: "exchange",
    name: "Exchange & allowlist",
    walletId: "0x9af6b2cd05b4db3079859565acfb0841af124e6b150aacf97c90f78df5db6630",
    xrplAddress: "rGKXFNqj71DaSTRyv1Sg8xKLeozyDuBT1",
    rule: RULES.exchange,
    config: "May only pay one allowlisted address: rw15K…VDMC (a demo exchange).",
    scene: "A savings account that can only ever pay your exchange. Try to send it somewhere else.",
    presets: [
      { label: "Pay the exchange", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 25 },
      { label: "A thief tries another address", recipient: "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT", amountXrp: 25, attack: true },
    ],
  },
  {
    key: "rateLimit",
    name: "Spending limit",
    walletId: "0xce79663f7ad7953383057a5dc98490e8e940c455b9b8556aea88ee443a04ae3e",
    xrplAddress: "rNJrYUrmiHGTnQghR1vK2F76cgSFaxwtqy",
    rule: RULES.rateLimit,
    config: "Allowlisted recipient + a cap of 10 XRP per day.",
    scene: "An allowance for a bot: it can spend to the allowlist, up to 10 XRP/day. Try to blow past it.",
    presets: [
      { label: "Spend 5 XRP to the exchange", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 5 },
      { label: "A hijacked bot tries 50 XRP", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 50, attack: true },
      { label: "…and tries a new address", recipient: "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT", amountXrp: 5, attack: true },
    ],
  },
  {
    key: "scheduled",
    name: "Scheduled payments",
    // A live schedule on the deployed rule: 500 XRP to one payee on the 1st of each month, 12 runs.
    walletId: "0x0eeb7caab035ac20471fca4662b7a6bc920c937d66fc0c4f5021179368aafac4",
    xrplAddress: "r33g8KFgJRe8zkqwv3vsr4A82vXKUebUiP",
    rule: RULES.scheduled,
    config: "Pays exactly 500 XRP to one payee on the 1st of each month, 12 times, and nothing else.",
    scene: "A standing order nobody can bend. The payee, the amount and the date are all pinned — try paying early, paying a bit more, or paying someone else.",
    presets: [
      { label: "Pay the payee today", recipient: "rNayb1SABfnBH4MzuoAbKTsXu6kWeV6cHL", amountXrp: 500, attack: true },
      { label: "Shave 1 XRP off", recipient: "rNayb1SABfnBH4MzuoAbKTsXu6kWeV6cHL", amountXrp: 499, attack: true },
      { label: "Pay someone else instead", recipient: "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT", amountXrp: 500, attack: true },
    ],
  },
  {
    key: "escrow",
    name: "Conditional",
    // Configured on the live ConditionalRule against a REAL pinned API (Coinbase XRP-USD spot). The
    // threshold is above today's price, so the condition genuinely hasn't been met — the refusal below is
    // real. Coinbase rather than CoinGecko: attestation providers each fetch the API and must agree, and
    // CoinGecko's rate limiting means requests against it never reach consensus.
    walletId: "0x03a0009e67a07f1ca58024123cf5a83619e9aac3f54813637cfc99fc4e2062c7",
    xrplAddress: "rUxiFBkn444QeMBwMJSuLZ7ixKbKPHoEpu",
    rule: RULES.escrow,
    config: "Pays a supplier up to 100 XRP — but only once Flare's Data Connector proves XRP is worth at least $5. If that hasn't happened by 31 Jan 2027, the funds return to the payer instead.",
    scene: "A payment that waits on the real world. Flare hasn't proven the condition yet, so nothing can leave — not even back to the payer.",
    presets: [
      { label: "Try to pay the supplier now", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 50, attack: true },
      { label: "Try to take it back early", recipient: "randbAijaVXWYaMxLEvSv8twud84xUF3dv", amountXrp: 50, attack: true },
    ],
  },
];
