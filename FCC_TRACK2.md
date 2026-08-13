# Keyless — Confidential Compute (Track 2)

The Track-2 framing of a Track-1 product. Keyless is an XRP account that can't be drained; **this doc is
about the confidential-compute engine that makes that possible.** 

---

## The one line
> Keyless uses Flare Confidential Compute to hold an XRPL signing key that **no one — not the user, not
> the operator, not us — can make sign anything outside an on-chain policy.** The TEE isn't a backend
> optimization; it's the only way to enforce rules on XRP, a chain with no smart contracts.

## Why FCC is *necessary* here (the "isn't this just a backend?" answer)
On an EVM chain you don't need a TEE — a smart-contract wallet enforces policy on-chain. **XRPL has no
smart contracts.** There is nowhere on the XRP Ledger to enforce "only pay what this rule allows." So the
signing key has to live somewhere that (a) can be *bound* to an on-chain rule and (b) *cannot be
extracted* by whoever runs it. That is exactly what a TEE provides. Remove the TEE and the guarantee is
impossible on XRP — which is what makes this confidential compute, not a server with extra steps.

## The trust chain (what a judge should verify on-chain)
1. **Code hash + governance pinned on-chain.** The extension registers a TEE image code hash
   (`addTeeVersion`) **and a governance signer-set** (`set-governance`). A machine can *only* join by
   attesting to that exact hash under that governance — "trust the operator" is replaced with "read the
   code hash." On Coston2 this is **extension 65645**.
2. **Keys born in the enclave.** `createWallet` sends an INIT the enclave answers by **generating a fresh
   XRPL key from its own entropy** — no key is ever imported, and none leaves. (Contrast: `fce-sign`,
   the reference, imports an operator-supplied key.)
3. **The contract is the only boss.** KeylessAccounts is the extension's sole `instructionsSender`
   (verifiable: `getTeeExtensionInstructionsSender(65645)` → `0x57eb332D…`). The enclave acts on
   instructions from that contract **and nothing else** — not the operator, not us.
4. **The rule gates every signature.** `pay` runs the wallet's rule *before* the instruction is sent; the
   enclave signs only what passed. Steal the key? It doesn't exist outside the TEE. Compromise the app?
   It can only pay where the rule allows.

## What's novel vs. the `fce-sign` reference
- **A multi-tenant keyring, not a single signer.** One enclave holds *many* keys — one per account —
  each generated in-TEE and each bound to its *own* on-chain rule. It's a key-management primitive, not
  just a signing endpoint.
- **Policy-bound signing.** The authorization surface is a pluggable on-chain rule (allowlist, rate
  limit, subscription, FDC-escrow, lockable) — the enclave stays generic; the policy is where the
  product lives.

## What's verified on-chain — the stateVerifier
The strongest confidential-compute claim is "the chain *verifies* what the TEE did." Today the enclave's
INIT result (the generated r-address) is written back by a trusted relayer. **`KeylessStateVerifier`**
(`src/KeylessStateVerifier.sol`) replaces that with a contract that accepts the r-address **only if the
TEE attested to it** — set as the extension's `_teeExtensionStateVerifier`. Skeleton is in the repo with
the known parts done (decode + idempotent write path) and the exact attestation-verification interface
marked `TODO`, to finish the moment Flare's updated FCC guides expose it. This is the direct answer to
"what is verified on-chain?"

## Composition: FCC + FDC + XRPL in one flow
The FDC-escrow rule shows the confidential-compute account **composing with Flare's data layer**: the
TEE-held key signs a native XRP payout **only after Flare's Data Connector has attested a real-world
condition** (e.g. delivery proven). Three Flare surfaces — **FCC** (the key), **FDC** (the condition),
**XRPL** (settlement) — in a single, honest flow. (To be precise: FDC ≠ FCC; the escrow *composes* them,
it doesn't make the FDC work "confidential compute.")

## Live proof (2026-07-23) — the loop runs end-to-end
On the current Flare FCC governance baseline (tee-node v0.0.21 / tee-proxy v0.0.18), extension **65645**,
machine **0xD47F3c4E…dD646** (production, governance-attested, code hash `0x194844cf…`, governance hash
`0xc99e27a5…`):
- `createWallet` → enclave generated XRPL address **rnbfVioih6PjuQNfBGRcN44Tin31CebvRA** in-TEE.
- `pay` → non-allowed recipient **reverted on-chain** (`"recipient not allowed"`) — never reached the key.
- `pay` → allowed recipient → enclave signed + submitted **5 XRP** → **tesSUCCESS**, tx
  [`35049922…2A6ABC6A`](https://testnet.xrpl.org/transactions/35049922E5096A090212A0B1B1EAD566F362B7D9268341E30707B24C2A6ABC6A).

## Honest status
- **Runs in Flare's simulated TEE mode (MODE=1) today** — a fixed code hash, not hardware attestation.
  The architecture is attestation-ready; the mainnet path is real Flare TEE machines. We say this plainly
  rather than imply hardware guarantees we don't yet have.
- **The stateVerifier is the remaining hop.** The enclave already emits signed, code-hash-bound state; the
  on-chain contract that verifies it and writes `xrplAddressOf` is in progress (skeleton in the repo).

## What to point a judge at
- `getTeeExtensionInstructionsSender(65645)` → KeylessAccounts `0x57eb332D…` (the enclave obeys the contract).
- `getRandomTeeIds(65645, 1)` → the attested production machine currently serving the extension. (Don't
  expect a fixed address — the simulated enclave gets a new identity on every restart, which is exactly the
  limitation the mainnet threshold-backup path removes.)
- The live XRPL tx above (real XRP moved, deny path reverted on-chain).
- `src/KeylessAccounts.sol` (the keyring manager), `src/rules/*` (the policies), `src/KeylessStateVerifier.sol`
  (verified-on-chain, in progress), and the enclave (`enclave/`, forked from `fce-sign`, keys generated
  in-TEE).
