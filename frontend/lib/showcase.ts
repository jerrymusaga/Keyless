import { encodeFunctionData, BaseError, ContractFunctionRevertedError } from "viem";
import { publicClient } from "./clients";
import { ADDRESSES, RULES } from "./keyless";

// The Exchange-&-allowlist demo account below was provisioned on the standalone AllowlistRule, which is
// now folded into ExchangeRule (allowlist == exchange with no tag/cap) and no longer a pickable template.
// The contract stays deployed, so the read-only dry-run still faithfully demonstrates the allowlist
// behaviour. Hardcoded here rather than via RULES since it's no longer in the template map.
const DEPRECATED_ALLOWLIST_RULE = "0x7aE1dC15Acd4766132ac11A67DfdCde03bd8DeC2" as const;
// The Spending-limit demo account was provisioned on RateLimitRule v1; the app now uses v2 (adds optional
// allowlist + per-payment cap). The v1 contract stays deployed, so the read-only demo still works.
const RATELIMIT_V1_RULE = "0xDED9303f6b72bd88c3F6a34414Ee2935422ab27d" as const;

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
    if (e instanceof BaseError) {
      const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (rev instanceof ContractFunctionRevertedError) {
        const reason = (rev.data?.args?.[0] as string) ?? rev.reason ?? rev.shortMessage;
        if (reason) return { allowed: false, reason };
      }
      return { allowed: false, reason: e.shortMessage };
    }
    return { allowed: false, reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

export const XRP = 1_000_000n;

/** A tryable scenario shown in the showcase. */
export type Scenario = { label: string; recipient: string; amountXrp: number; attack?: boolean };

export type Demo = {
  key: string;
  name: string;
  walletId: `0x${string}`;
  rule: `0x${string}`;
  /** Human summary of the account's live configuration. */
  config: string;
  /** What this account is for, in one line. */
  scene: string;
  presets: Scenario[];
};

/** The four demo accounts, pre-configured on-chain (see backend/script/SetupDemo). walletIds are
 *  deterministic (walletIdFor(deployer, fixed salt)), so they're stable. */
export const DEMOS: Demo[] = [
  {
    key: "exchange",
    name: "Exchange & allowlist",
    walletId: "0x3c555a3896ec2481f3ef5f5025f85fcc3bccafc2d9f8c8b3089442b931693a54",
    rule: DEPRECATED_ALLOWLIST_RULE,
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
    walletId: "0xdc2006bef11900f063e4b8d1f6d2d54d5214798aae5a8f6e2e5eec8ab6a1019a",
    rule: RATELIMIT_V1_RULE,
    config: "Allowlisted recipient + a cap of 10 XRP per day.",
    scene: "An allowance for a bot: it can spend to the allowlist, up to 10 XRP/day. Try to blow past it.",
    presets: [
      { label: "Spend 5 XRP to the exchange", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 5 },
      { label: "A hijacked bot tries 50 XRP", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 50, attack: true },
      { label: "…and tries a new address", recipient: "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT", amountXrp: 5, attack: true },
    ],
  },
  {
    key: "escrow",
    name: "Conditional (FDC)",
    walletId: "0x250249f40da38df77ac238a53ef85c7509683379b0a4f8ff611d42bc6e99f59b",
    rule: RULES.escrow,
    config: "Pays a supplier up to 100 XRP — but only once Flare's Data Connector proves “delivery == true”.",
    scene: "An escrow that stays locked until the world proves the condition. It hasn't been proven yet.",
    presets: [
      { label: "Try to pay the supplier now", recipient: "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC", amountXrp: 50, attack: true },
    ],
  },
];
