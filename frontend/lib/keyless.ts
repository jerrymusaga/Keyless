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
  /** Flare's TEE manager diamond. Not ours — Flare's system contract. (Redeployed 2026-07-23.) */
  teeManager: "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
  /** KeylessAccounts — the multi-tenant manager, and the extension's sole instructionsSender.
   *  Every wallet's key obeys this contract and nothing else. (Writeback + lockable rules, bound on 65645.) */
  accounts: "0x57eb332D7000752ee82a35cc1A75941F0a619979",
  /** Legacy single-wallet demo policy (old baseline, dead). Kept only for the historical /see fallback. */
  policy: "0x3CC32eB5d7ef1751f1fd0b81DdEBcca382bf586d",
  /** Deployer. Holds no XRPL key — that is the point. */
  owner: "0xc760AB37E00082202e1659C256E01372f1739886",
  /** The governance-attested TEE machine serving extension 65645. */
  teeMachine: "0xD47F3c4E26173df11667c5Ad3723e66Fa45dD646",
  /** Flare Smart Accounts diamond (SmartAccountManager) on Coston2 — where FXRP mints land and DeFi vaults
   *  live. Its ReaderFacet exposes each personal account's FXRP portfolio + the vault registry. */
  fsaDiamond: "0x434936d47503353f06750Db1A444DBDC5F0AD37c",
} as const;

/** VaultType enum from IVaultsFacet: 0 None, 1 Firelight, 2 Upshift. */
export const VAULT_TYPE_NAME: Record<number, string> = { 0: "—", 1: "Firelight", 2: "Upshift" };

/** FSA ReaderFacet — reads a personal account's whole FXRP portfolio in one call: liquid FXRP + each
 *  vault position (shares + FXRP-equivalent `assets`) + the registered vault list. */
export const FSA_READER_ABI = [
  {
    type: "function",
    name: "getBalances",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "natBalance", type: "uint256" },
          { name: "wNat", type: "tuple", components: [{ name: "token", type: "address" }, { name: "balance", type: "uint256" }] },
          { name: "fXrp", type: "tuple", components: [{ name: "token", type: "address" }, { name: "balance", type: "uint256" }] },
          {
            name: "vaults",
            type: "tuple[]",
            components: [
              { name: "vaultId", type: "uint256" },
              { name: "vaultAddress", type: "address" },
              { name: "vaultType", type: "uint8" },
              { name: "shares", type: "uint256" },
              { name: "assets", type: "uint256" },
            ],
          },
        ],
      },
    ],
  },
] as const;

/** The rule modules. Each is one readable contract; a wallet points at one. */
// Three distinct policy primitives, one axis each: WHO can be paid (exchange), HOW MUCH over time
// (rateLimit), and WHEN — only on a proven condition (escrow). The old `allowlist` and `subscription`
// rules were strict subsets (exchange with no tag/cap; rateLimit with a single recipient) and were
// removed to keep the templates non-overlapping. Their contracts remain deployed but unused.
export const RULES = {
  exchange: "0x2E5e2A1055670b2bc2baBd64f15825e69512d7e4",
  rateLimit: "0x51Cc5c71350d527fDaA188B39f28DE22F4873710", // v3: rolling | calendar-aligned | until-a-date, + optional allowlist + per-tx cap
  // Pay only once Flare's Data Connector proves a real-world condition. Supersedes the old
  // FdcEscrowRule (0x6ef53Ce1…), which could never release (it called a function the live
  // FdcVerification doesn't have) and, worse, could be released by ANYONE with an attestation of any
  // API returning the same value — it bound only the response, not the request. This one pins the whole
  // request. See backend/src/rules/ConditionalRule.sol.
  escrow: "0x2d8517BC464C70c21bBDBA48d3166a77A5019E77",
  // Unified FXRP round-trip: mint XRP->FXRP to your OWN Flare Smart Account (computed on-chain, not
  // configurable), then vault ops + redeem-home; transferring FXRP out is blocked. Supersedes the two
  // separate fxrpMint (0xaa0405f9…) + fxrpDefi (0xB5Ab70B4…) rules — see LEGACY_RULE_NAMES.
  fxrp: "0x12AdbaAbE8409fF2f7B8f12e680a6E5698a7D2eE",
  // Payroll / DCA. Each line pins payee + exact amount + calendar slot, so whoever triggers it has no
  // discretion at all. Skips missed runs rather than accruing them. See backend/src/rules/ScheduledRule.sol.
  scheduled: "0x3C1B2a200137e0E01589f50C469f410706E20177",
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const EXTENSION_ID = 65645;

/** Instruction fee (wei) attached to createWallet / pay. The updated fce-sign scaffold dropped
 *  on-chain fee quoting (no more `quoteFee`); the registry validates msg.value and refunds excess
 *  to claimBackAddress. Override with NEXT_PUBLIC_INIT_FEE if the chain's fee differs. */
export const INIT_FEE: bigint = BigInt(process.env.NEXT_PUBLIC_INIT_FEE ?? "1000");

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
  { type: "function", name: "walletCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "activeCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
  { type: "error", name: "Locked", inputs: [] },
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
  exchange: [
    { type: "function", name: "allow", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "allowWithTag", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }, { name: "tag", type: "uint32" }], outputs: [] },
    { type: "function", name: "remove", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "setMaxPerTx", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "maxDrops", type: "uint256" }], outputs: [] },
    { type: "function", name: "maxPerTx", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  ],
  rateLimit: [
    { type: "function", name: "allow", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "remove", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }], outputs: [] },
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }, { name: "mode", type: "uint8" }, { name: "cap", type: "uint256" }, { name: "param", type: "uint256" }, { name: "maxPerTx", type: "uint256" }, { name: "allowlistOnly", type: "bool" }], outputs: [] },
  ],
  // ConditionalRule. `configure` takes the FULL attestation request — the contract hashes it, so the
  // client can't commit to an encoding the rule won't reproduce — and the expected attested value.
  escrow: [
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [
      { name: "walletId", type: "bytes32" }, { name: "recipient", type: "string" }, { name: "maxAmount", type: "uint256" },
      { name: "request", type: "tuple", components: [
        { name: "url", type: "string" }, { name: "httpMethod", type: "string" }, { name: "headers", type: "string" },
        { name: "queryParams", type: "string" }, { name: "body", type: "string" },
        { name: "postProcessJq", type: "string" }, { name: "abiSignature", type: "string" },
      ] },
      { name: "expectedHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "fallbackRecipient", type: "string" },
    ], outputs: [] },
    { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [] },
    { type: "function", name: "conditionOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
      { name: "recipient", type: "bytes32" }, { name: "maxAmount", type: "uint256" }, { name: "requestHash", type: "bytes32" },
      { name: "expectedHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
      { name: "fallbackRecipient", type: "bytes32" }, { name: "spent", type: "uint256" },
      { name: "released", type: "bool" }, { name: "active", type: "bool" },
    ] },
    { type: "function", name: "isExpired", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  ],
  // Unified FXRP: mint half (mint into your own on-chain-computed FSA personal account) + DeFi half
  // (vault ops + redeem-home). `personalAccountOf` is the only mint target — nothing to configure.
  fxrp: [
    { type: "function", name: "personalAccountOf", stateMutability: "view", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [{ type: "address" }] },
    { type: "function", name: "mintMemo", stateMutability: "pure", inputs: [{ name: "flareRecipient", type: "address" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "coreVaultAddress", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "fsaProviderWallet", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "redeemHomeRef", stateMutability: "pure", inputs: [{ name: "lots", type: "uint80" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "vaultRef", stateMutability: "pure", inputs: [{ name: "id", type: "uint8" }, { name: "vaultId", type: "uint16" }, { name: "value", type: "uint80" }], outputs: [{ type: "bytes32" }] },
  ],
  // ScheduledRule. `configure` replaces the whole schedule; `nextRun` is what lets the account warn
  // "you'll need 500 XRP on 1 September" before the run rather than after it.
  scheduled: [
    { type: "function", name: "configure", stateMutability: "nonpayable", inputs: [
      { name: "walletId", type: "bytes32" },
      { name: "lines", type: "tuple[]", components: [
        { name: "recipient", type: "string" }, { name: "amount", type: "uint256" },
        { name: "unit", type: "uint8" }, { name: "offsetDays", type: "uint8" },
        { name: "runs", type: "uint32" }, { name: "startAt", type: "uint64" },
      ] },
    ], outputs: [] },
    { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "walletId", type: "bytes32" }], outputs: [] },
    { type: "function", name: "lineCount", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "linesOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [
      { name: "payee", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "nextDue", type: "uint64" },
      { name: "runsLeft", type: "uint32" }, { name: "unit", type: "uint8" }, { name: "offsetDays", type: "uint8" },
      { name: "active", type: "bool" },
    ] },
    { type: "function", name: "nextRun", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
      { name: "dueAt", type: "uint64" }, { name: "totalDrops", type: "uint256" },
    ] },
    { type: "function", name: "runsRemaining", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  ],
} as const;

/**
 * Conditions a Conditional account can wait on. Each is a REAL public API the Flare Data Connector can
 * attest. The jq transform carries the predicate, so the attested answer is a plain boolean — which is
 * why every condition commits to the same expected value (`keccak(abi.encode(true))`). That is only safe
 * because ConditionalRule also pins the whole request; see the rule for the attack it defends.
 */
export const EXPECTED_TRUE = "0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6" as const;
const BOOL_SIG = '{"components":[{"internalType":"bool","name":"ok","type":"bool"}],"name":"task","type":"tuple"}';

export type ConditionRequest = {
  url: string; httpMethod: string; headers: string; queryParams: string;
  body: string; postProcessJq: string; abiSignature: string;
};

/** One input a condition template asks for. Templates declare their fields so the UI can render a
 *  labelled control per value instead of asking someone to encode everything into one cryptic string. */
export type ConditionField = {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  width?: "sm" | "md" | "lg";
};

export const CONDITION_TEMPLATES = {
  xrpPrice: {
    name: "XRP price reaches",
    fields: [{ key: "usd", label: "USD", kind: "number", placeholder: "1", width: "sm" }] as ConditionField[],
    describe: (v: Record<string, string>) => `XRP is worth at least $${v.usd}`,
    // Coinbase, NOT CoinGecko. Every attestation provider fetches the API independently and they must
    // agree; CoinGecko's free tier throttles them, so requests against it never reached consensus —
    // measured directly: two attestations submitted seconds apart, Coinbase returned a proof in ~90s
    // while CoinGecko returned none at all. Whatever API a condition pins has to tolerate many
    // independent fetchers. (Query params must go in queryParams, never inline in the url.)
    build: (v: Record<string, string>): ConditionRequest => ({
      url: "https://api.coinbase.com/v2/prices/XRP-USD/spot",
      httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
      postProcessJq: `{ok: ((.data.amount|tonumber) >= ${Number(v.usd)})}`,
      abiSignature: BOOL_SIG,
    }),
  },
  // Parametric trigger, mirroring Flare's own weather-insurance example — but on Open-Meteo rather than
  // OpenWeatherMap: OWM needs an `appid`, and a pinned request is published in full in the
  // ConditionConfigured event, so an API key would be on-chain for anyone to read. Open-Meteo needs none.
  temperature: {
    name: "Temperature at a place",
    fields: [
      { key: "dir", label: "", kind: "select", width: "md", options: [
        { value: "below", label: "drops to or below" },
        { value: "above", label: "rises to or above" },
      ] },
      { key: "celsius", label: "°C", kind: "number", placeholder: "5", width: "sm" },
      { key: "lat", label: "latitude", kind: "number", placeholder: "51.5", width: "sm" },
      { key: "lon", label: "longitude", kind: "number", placeholder: "-0.12", width: "sm" },
    ] as ConditionField[],
    describe: (v: Record<string, string>) =>
      `the temperature at ${v.lat}, ${v.lon} ${v.dir === "above" ? "reaches" : "drops to"} ${v.celsius}°C`,
    build: (v: Record<string, string>): ConditionRequest => ({
      url: "https://api.open-meteo.com/v1/forecast",
      httpMethod: "GET", headers: "{}",
      queryParams: JSON.stringify({ latitude: v.lat, longitude: v.lon, current: "temperature_2m" }),
      body: "{}",
      postProcessJq: `{ok: (.current.temperature_2m ${v.dir === "above" ? ">=" : "<="} ${Number(v.celsius)})}`,
      abiSignature: BOOL_SIG,
    }),
  },
  githubIssueClosed: {
    name: "A GitHub issue is closed",
    fields: [
      { key: "repo", label: "repository", placeholder: "owner/repo", width: "lg" },
      { key: "num", label: "issue #", kind: "number", placeholder: "42", width: "sm" },
    ] as ConditionField[],
    describe: (v: Record<string, string>) => `${v.repo}#${v.num} is closed`,
    build: (v: Record<string, string>): ConditionRequest => ({
      url: `https://api.github.com/repos/${v.repo}/issues/${v.num}`,
      httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
      postProcessJq: '{ok: (.state == "closed")}',
      abiSignature: BOOL_SIG,
    }),
  },
  githubPrMerged: {
    name: "A GitHub pull request is merged",
    fields: [
      { key: "repo", label: "repository", placeholder: "owner/repo", width: "lg" },
      { key: "num", label: "PR #", kind: "number", placeholder: "42", width: "sm" },
    ] as ConditionField[],
    describe: (v: Record<string, string>) => `${v.repo}#${v.num} is merged`,
    build: (v: Record<string, string>): ConditionRequest => ({
      url: `https://api.github.com/repos/${v.repo}/pulls/${v.num}`,
      httpMethod: "GET", headers: "{}", queryParams: "{}", body: "{}",
      postProcessJq: "{ok: (.merged == true)}",
      abiSignature: BOOL_SIG,
    }),
  },
} as const;
export type ConditionKey = keyof typeof CONDITION_TEMPLATES;

/** UI-facing metadata for each rule template: which address, the human story, and its adversary. */
export type RuleKey = keyof typeof RULES;
/** `comingSoon` templates are shown in the picker but not selectable yet (they need the FDC/executor step). */
export const RULE_META: Record<RuleKey, { name: string; tagline: string; useFor: string; protects: string; address: string; comingSoon?: boolean }> = {
  exchange: {
    name: "Exchange & allowlist",
    tagline: "Pay only the addresses you approve.",
    useFor: "Exchange deposits, paying specific people or vendors, cold-storage top-ups.",
    protects: "A stolen key can't send anywhere you didn't approve.",
    address: RULES.exchange,
  },
  rateLimit: {
    name: "Spending limit",
    tagline: "Cap how much can leave — per window or as a fixed budget.",
    useFor: "Bot & AI-agent budgets, allowances, subscriptions, slow-drain savings.",
    protects: "Nothing can exceed the cap — not a hijacked bot, not a stolen key.",
    address: RULES.rateLimit,
  },
  escrow: {
    name: "Conditional",
    tagline: "Pay only once something in the real world is proven true.",
    useFor: "Escrow, milestone payments, pay-on-delivery, price triggers.",
    protects: "Funds stay locked until the world proves it — no early release, no wrong payee.",
    address: RULES.escrow,
  },
  scheduled: {
    name: "Scheduled payments",
    tagline: "A fixed amount, to a fixed payee, on a fixed date. Nothing early, nothing extra.",
    useFor: "Payroll, rent, allowances, moving into FXRP a bit at a time.",
    protects: "Whoever triggers it can only run your schedule on time — never early, never more.",
    address: RULES.scheduled,
  },
  fxrp: {
    name: "FXRP on Flare",
    tagline: "Move XRP to Flare, earn yield, and bring it home — locked to your account.",
    useFor: "Earn on your XRP through Flare DeFi, safely.",
    protects: "Every step lands in your own account — never a thief's.",
    address: RULES.fxrp,
  },
};

/**
 * The policy set, arranged by the question each one answers rather than as a flat list.
 *
 * Every rule constrains exactly one axis of "when may this key sign" — WHO, HOW MUCH, or WHEN — so the
 * picker leads with the question and treats the rule's name as the answer. People shop by the worry they
 * arrived with ("who can this thing pay?"), not by policy names they've never seen.
 *
 * A slot with no `rule` isn't built yet. It stays visible on purpose: seeing the fourth question makes the
 * shape of the set obvious, and makes Conditional read as the harder sibling of a familiar idea rather
 * than a lone piece of machinery.
 */
export type PolicySlot = {
  question: string;
  rule?: RuleKey;
  soon?: { name: string; tagline: string; useFor: string };
};
export const POLICY_SLOTS: PolicySlot[] = [
  { question: "Who can be paid?", rule: "exchange" },
  { question: "How much can leave?", rule: "rateLimit" },
  { question: "When — on a set date?", rule: "scheduled" },
  { question: "When — once it's proven?", rule: "escrow" },
];

/** Older/retired rule deployments, mapped to a display name so accounts created on them still label
 *  correctly (rather than falling back to "custom policy"). Keys are lowercased addresses. */
export const LEGACY_RULE_NAMES: Record<string, string> = {
  "0xded9303f6b72bd88c3f6a34414ee2935422ab27d": "Spending limit", // RateLimitRule v1
  "0xd4dbdfb1de4f2ccd26bddb795dccf7a9c194df6f": "Spending limit", // RateLimitRule v2
  "0x7ae1dc15acd4766132ac11a67dfdcde03bd8dec2": "Allowlist", // retired AllowlistRule (folded into Exchange)
  "0xa828482fab7c149aa6d339b31016cf0d7165aedc": "Subscription", // retired SubscriptionRule (folded into Spending limit)
  "0xaa0405f9dcfa83517469d133143351a07586a23f": "FXRP on Flare", // retired FxrpMintRule (folded into unified FXRP)
  "0xb5ab70b41805f24c995f3ade22a7a533721cb926": "FXRP on Flare", // retired FxrpDefiRule (folded into unified FXRP)
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
    name: "getRandomTeeIds",
    stateMutability: "view",
    inputs: [
      { name: "extensionId", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
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

export function xrplTx(hash: string) {
  return `${XRPL_EXPLORER}/transactions/${hash}`;
}

export function formatDrops(drops: bigint) {
  return `${(Number(drops) / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })} XRP`;
}
