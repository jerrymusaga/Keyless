// Keyless frontend config.
// Fill in POLICY_ADDRESS after deploying, and verify PMW/AssetManager addresses live.

export const COSTON2 = {
  chainId: 114,
  rpc: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
};

export const ADDRESSES = {
  teePaymentsFXRP: "0xD02384dcbA8bBb42E4E8b417b8542410AE0CF484",
  // Set after `forge script Deploy.s.sol:DeployDemo`:
  demoPolicy: "0x0000000000000000000000000000000000000000",
  // Set after `forge script Deploy.s.sol:DeployRedemption`:
  redemptionPolicy: "0x0000000000000000000000000000000000000000",
};

// Minimal ABIs the demo UI needs. Extend as the build grows.
export const DEMO_POLICY_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "reference", type: "bytes32" },
    ],
    outputs: [{ name: "paymentId", type: "uint64" }],
  },
  {
    type: "function",
    name: "allowRecipient",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isBound",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowedRecipient",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
];

export const REDEMPTION_POLICY_ABI = [
  {
    type: "function",
    name: "payRedemption",
    stateMutability: "nonpayable",
    inputs: [{ name: "redemptionRequestId", type: "uint256" }],
    outputs: [{ name: "paymentId", type: "uint64" }],
  },
];
