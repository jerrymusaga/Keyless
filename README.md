# Keyless

**A PMW-controlled XRPL account that can only ever pay what an on-chain policy permits — so the operator holds no key and can steal nothing.**

Keyless is a policy-contract layer on top of Flare's **Protocol Managed Wallets (PMW)**. A PMW-managed XRPL account can only be spent by its registered *authorization address*. Keyless makes that address a **smart contract**. The result: the account can only move funds in ways the contract's on-chain policy allows. Whoever runs the machine holds no key and can sign nothing the policy forbids — hence *Keyless*.

The flagship application is a **trustless FAssets agent**: an agent whose operator is removed from the trust equation, which is what lets agents be funded by anyone and, in turn, lets FXRP capacity scale.

---

## Why this matters

FAssets agents are the bottleneck for FXRP supply. Running one today means custody of a live XRPL key and enough trust to raise collateral — few people clear both bars, so capacity stays thin. Keyless replaces "trust the operator" with "read the contract": the agent's XRPL account is controlled by `KeylessRedemptionPolicy`, which can *only* pay valid FAssets redemptions, with every payment parameter forced from protocol state.

The trust boundary moves from an operator (or a Docker image hash) to a few lines of public Solidity anyone can read.

---

## Repository layout

```
keyless/
├── backend/                  Foundry project (the contracts — the product)
│   ├── src/
│   │   ├── AuthorizedPayPolicy.sol        Abstract base: holds the PMW authorization slot
│   │   ├── policies/
│   │   │   ├── KeylessRedemptionPolicy.sol  FLAGSHIP: pays FAssets redemptions, nothing else
│   │   │   └── KeylessDemoPolicy.sol         Live demo: allowlisted XRP payments, no agent status
│   │   └── interfaces/                     ITeePayments, IAssetManager, PMWTypes (exact ABIs)
│   ├── test/                 Foundry tests incl. the "operator cannot pay self" adversary case
│   ├── script/               Deploy scripts for Coston2
│   └── scripts/              coston2_derisk_check.py — live read-only gate verification
├── frontend/                 Minimal UI skeleton (Vite + React) to build the demo on
└── docs/                     ARCHITECTURE, OPEN_ITEMS, RESEARCH — read these first
```

---

## Quickstart

```bash
# 1. Contracts
cd backend
forge install foundry-rs/forge-std     # populates lib/forge-std
forge build
forge test -vvv                         # includes the adversary-beat test

# 2. Verify the live gates (read-only, no key needed)
pip install web3
python scripts/coston2_derisk_check.py

# 3. Deploy the demo policy to Coston2 (after filling .env from .env.example)
forge script script/Deploy.s.sol:DeployDemo --rpc-url $COSTON2_RPC --broadcast --private-key $PK
```

---

## Status (as of scaffold)

**Confirmed from source / live reads:**
- PMW deployed on Coston2; `TeePayments_F_XRP` live; testXRP source registered.
- `pay()` is gated by `OnlyAuthorizationAddress` — a contract *can* hold that slot. (This was the decisive check.)
- Wallet/project/extension creation is permissionless for your own extension.
- `redemptionRequestInfo()` returns full ground truth and reverts once confirmed → free replay guard.
- Redemption payment window ≈ later of 500 XRPL ledgers / 900s → comfortably beats PMW relay latency.

**Open items (see `docs/OPEN_ITEMS.md`) — none block starting:**
1. Is `pay()` synchronous or asynchronous? (Decides whether a small off-chain keeper is needed.)
2. Exact handshake to bind this contract as a PMW account's authorization address (`addPMWMultisigAccount` proof).
3. FAssets agent whitelist is governance-gated — request needed to take the flagship *live* (the demo policy needs none).

---

## The demo beat

1. Real XRP moves on XRPL testnet, authorized by `KeylessDemoPolicy`.
2. You — holding every key — try to pay your own address. The contract reverts. You show the four lines that make theft impossible.
3. You show `KeylessRedemptionPolicy` bound to real `redemptionRequestInfo` reads.
4. Close: "the only thing between this and a live trustless agent is one governance whitelist call."

Judges read Solidity instead of trusting a hash.
