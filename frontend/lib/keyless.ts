import { defineChain } from "viem";

/**
 * Every address here is live on Coston2 and independently checkable in the block
 * explorer. Nothing in this file is illustrative — if a value changes on-chain,
 * this file is wrong, not the chain.
 */

export const coston2 = defineChain({
  id: 114,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://coston2-api.flare.network/ext/C/rpc",
        "https://rpc.ankr.com/flare_coston2",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
});

export const EXPLORER = coston2.blockExplorers.default.url;
export const XRPL_EXPLORER = "https://testnet.xrpl.org";

export const ADDRESSES = {
  /** Flare's TEE manager diamond. Not ours — Flare's system contract. */
  teeManager: "0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F",
  /** KeylessAccounts — the multi-tenant manager, and the extension's sole instructionsSender.
   *  Every wallet's key obeys this contract and nothing else. (Writeback + lockable rules, bound on 454.) */
  accounts: "0x870456e4e13461850D8e7E4b749BE8881A99a266",
  /** Legacy single-wallet demo policy. Still deployed; the live "refuse" demo runs its allowlist
   *  check against it (a real on-chain revert) until the interactive demo is moved to `accounts`. */
  policy: "0x3CC32eB5d7ef1751f1fd0b81DdEBcca382bf586d",
  /** Deployer. Holds no XRPL key — that is the point. */
  owner: "0xc760AB37E00082202e1659C256E01372f1739886",
  /** The FDC-attested TEE machine serving extension 454. */
  teeMachine: "0x27a7A5D0968F8948F65536B34125A7b2748Ad316",
} as const;

/** The rule modules. Each is one readable contract; a wallet points at one. `escrow` is built + tested
 *  but ships with the next full redeploy, so its address is the zero address until then — the UI treats
 *  a zero-address rule as "available soon" and won't let a wallet point at it. */
export const RULES = {
  allowlist: "0x02094bbE30C33361315959a77003F9856163F40C",
  rateLimit: "0x60c9Fec17e077bC711A138b85dBd552109E552c9",
  subscription: "0xa190C9Ac3aED7E7BaFaCa9292dd9a7130e77f9F1",
  escrow: "0x824e88CE4fF25f4B0d0F4517c571A965Efb5800e",
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const EXTENSION_ID = 454;

/**
 * The enclave's XRPL account, generated *inside* the TEE — no human ever saw the
 * seed. The policy's own `xrplAccount()` field still reads "pending-init"
 * (it is informational and was never written back post-INIT), so this constant
 * comes from the ledger itself, which is the stronger source anyway.
 */
export const ENCLAVE_XRPL_ACCOUNT = "randbAijaVXWYaMxLEvSv8twud84xUF3dv";

/** The allowlisted destination that actually received the 15 XRP. */
export const ALLOWLISTED_RECIPIENT = "rw15KUmEBEERnbNFys2gVpc26FTABwVDMC";

/** The recorded payment, in drops. 100M funded − 15M sent − 12 fee = 84,999,988. */
export const PAYMENT_EVIDENCE = {
  fundedDrops: 100_000_000n,
  sentDrops: 15_000_000n,
  xrplFeeDrops: 12n,
  enclaveBalanceAfterDrops: 84_999_988n,
} as const;

export const POLICY_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "paymentReference", type: "bytes32" },
    ],
    outputs: [{ name: "instructionId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "isBound",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "teeMachines",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "quotePayFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowedRecipient",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "extensionId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "walletId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  { type: "error", name: "PolicyRejected", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "NoTeeMachines", inputs: [] },
  {
    type: "error",
    name: "InsufficientFee",
    inputs: [
      { name: "required", type: "uint256" },
      { name: "provided", type: "uint256" },
    ],
  },
] as const;

/** KeylessAccounts — the multi-tenant manager. Reads the UI needs now, writes for the app page. */
export const ACCOUNTS_ABI = [
  { type: "function", name: "isBound", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "extensionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "walletIdFor",
    stateMutability: "pure",
    inputs: [{ name: "owner", type: "address" }, { name: "salt", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "ruleOf",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "xrplAddressOf",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "reportXrplAddress",
    stateMutability: "nonpayable",
    inputs: [{ name: "walletId", type: "bytes32" }, { name: "xrplAddress", type: "string" }],
    outputs: [],
  },
  {
    type: "event",
    name: "WalletCreated",
    inputs: [
      { name: "walletId", type: "bytes32", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "initInstructionId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "quoteFee",
    stateMutability: "view",
    inputs: [{ name: "opCommand", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "createWallet",
    stateMutability: "payable",
    inputs: [{ name: "salt", type: "bytes32" }],
    outputs: [{ name: "walletId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "setRule",
    stateMutability: "nonpayable",
    inputs: [{ name: "walletId", type: "bytes32" }, { name: "rule", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isLocked",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "lockRule",
    stateMutability: "nonpayable",
    inputs: [{ name: "walletId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [
      { name: "walletId", type: "bytes32" },
      { name: "recipient", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "paymentReference", type: "bytes32" },
    ],
    outputs: [{ name: "instructionId", type: "bytes32" }],
  },
  { type: "error", name: "NoRule", inputs: [] },
  { type: "error", name: "NoTeeMachines", inputs: [] },
  { type: "error", name: "WalletExists", inputs: [] },
  { type: "error", name: "NotWalletOwner", inputs: [] },
  // Raised by every rule when it refuses a payment — carries the human reason ("recipient not allowed",
  // "over cap", …). Included here so viem can decode the refusal that bubbles up through pay().
  { type: "error", name: "Rejected", inputs: [{ name: "reason", type: "string" }] },
  {
    type: "error",
    name: "InsufficientFee",
    inputs: [{ name: "required", type: "uint256" }, { name: "provided", type: "uint256" }],
  },
] as const;

/** The four rule modules, with the config calls each exposes. A wallet points at one; its owner then
 *  configures it through these. All are `onlyWalletOwner(walletId)` on-chain. */
export const RULE_ABIS = {
  allowlist: [
    { type: "function", name: "allow", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "remove", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "allowed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
  ],
  rateLimit: [
    { type: "function", name: "allow", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "maxPerWindow", type: "uint256" }, { name: "window", type: "uint64" }], outputs: [] },
  ],
  subscription: [
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "merchant", type: "string" }, { name: "maxPerPeriod", type: "uint256" }, { name: "period", type: "uint64" }], outputs: [] },
    { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [] },
  ],
  escrow: [
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }, { name: "maxAmount", type: "uint256" }, { name: "conditionHash", type: "bytes32" }], outputs: [] },
    { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [] },
  ],
} as const;

/** UI-facing metadata for each rule template: which address, the human story, and its adversary. */
export type RuleKey = keyof typeof RULES;
export const RULE_META: Record<RuleKey, { name: string; tagline: string; protects: string; address: string }> = {
  allowlist: {
    name: "Exchange-only",
    tagline: "Pay only addresses you've allowlisted. Everything else is refused.",
    protects: "A stolen key, a poisoned address, a compromised app — none can send anywhere new.",
    address: RULES.allowlist,
  },
  rateLimit: {
    name: "Agent wallet",
    tagline: "An allowance: a cap per time window, to allowlisted addresses only.",
    protects: "A hijacked or prompt-injected agent can spend up to the cap — never drain the account.",
    address: RULES.rateLimit,
  },
  subscription: {
    name: "Subscription",
    tagline: "One merchant may pull up to a fixed amount per period. Cancel anytime.",
    protects: "The merchant provably cannot overcharge, redirect, or bill after you cancel.",
    address: RULES.subscription,
  },
  escrow: {
    name: "Conditional (FDC)",
    tagline: "Pay a supplier only once Flare's Data Connector proves the condition.",
    protects: "Funds stay locked until the world proves delivery — no early release, no wrong payee.",
    address: RULES.escrow,
  },
};

export const TEE_MANAGER_ABI = [
  {
    type: "function",
    name: "getTeeExtensionInstructionsSender",
    stateMutability: "view",
    inputs: [{ name: "extensionId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getActiveTeeMachines",
    stateMutability: "view",
    inputs: [{ name: "extensionId", type: "uint256" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

/** XRPL classic addresses: base58 (no 0, O, I, l), starting with `r`. */
export const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function addr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function explorerAddress(a: string) {
  return `${EXPLORER}/address/${a}`;
}

export function xrplAccount(a: string) {
  return `${XRPL_EXPLORER}/accounts/${a}`;
}

export function formatDrops(drops: bigint) {
  return `${(Number(drops) / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })} XRP`;
}
