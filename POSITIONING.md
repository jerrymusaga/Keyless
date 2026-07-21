# Keyless — Positioning: native-XRP-first (and where FXRP fits)

Locking the reasoning so we don't drift. Short version: **the TEE is Keyless's edge, the TEE only earns
its keep on native XRP, so Keyless is native-XRP-first. FXRP is an optional on-ramp, never a pillar.**

## The core thesis: why the TEE matters for XRP and not for FXRP

- **XRP lives on the XRP Ledger, which has no smart contracts.** There's nowhere on XRPL to enforce a
  spending rule. So the signing key has to live somewhere that *can* enforce rules — and that somewhere
  is a TEE. **This is the entire reason Keyless exists, and nobody can copy it without a TEE.**
- **FXRP lives on Flare's EVM, which *has* smart contracts.** To make FXRP behave by rules you'd just
  hold it in a **smart-contract vault** that enforces the rules on-chain — **no TEE needed.**

Consequence: **the moment the asset is FXRP, our unique advantage evaporates.** An "undrainable FXRP
account" is a plain EVM policy vault — generic account abstraction, the same neighborhood Flare Smart
Accounts and every EVM smart wallet already occupy. We win on native XRP; we're undifferentiated on FXRP.

## Versus Flare Smart Accounts (FSA)

FSA is Flare's own first-party product: XRPL users act on Flare gaslessly (mint FXRP, DeFi vaults) via a
32-byte memo instruction + FDC + operator, integrated into Xaman. **It has no TEE — the user's XRPL key
controls the account.** So:

- **FSA = access.** Unlock what your XRP can *do* (gasless Flare DeFi/FXRP).
- **Keyless = safety.** Control what your XRP is *allowed* to do — so it can't be drained.

The sharp differentiator: **in FSA your XRPL key controls everything — steal it, drain it. Keyless is the
only one where a stolen key still can't move your funds**, because the money-moving key isn't yours; it's
in the enclave, bound by rules. Never frame Keyless as "a smart account for XRP" — that's FSA's category.
Frame it as the undrainable one, complementary to FSA.

## Where FXRP fits: an optional on-ramp, nothing more

If (and only if) we want an FXRP touch:

- **The flow:** a "mint FXRP" rule on a native-XRP Keyless account. The account can *only* pay the FAssets
  Core Vault with a memo minting FXRP to **the user's control-key EVM address** (the app already knows
  it). Reuses existing plumbing — the 32-byte mint memo fits `pay`'s `bytes32 paymentReference`, so no
  enclave change. See `memory/flare-mint-to-tag-fxrp.md` for the exact encoding + Coston2 addresses.
- **What it protects:** only that the mint can't be redirected. Low value — you're minting to your own
  address anyway.
- **What it does NOT protect:** the FXRP once minted. It sits at the control-key EOA and is drainable by
  control-key theft, exactly like any wallet / like FSA. **The "can't be drained" guarantee covers the
  native-XRP account, NOT the FXRP balance — say so plainly.**

**Do NOT build "undrainable FXRP custody."** It needs either the enclave to sign EVM txs (big lift, and
pointless since EVM has contracts) or an EVM policy vault (no TEE → generic AA, FSA territory). Both leave
the ground where we're differentiated.

## The moat, in one line

> An undrainable **native-XRP** account — because XRPL has no contracts, the key has to live in a TEE, and
> ours can't be made to sign outside your rules. FSA can't say that. An EVM vault can't say that.

Keep the core there. Treat FXRP as an optional exit ramp, only if there's spare time after the core is
live and demoed.

---

## Revenue model

Keyless charges a cut of the **flows it secures**, never a fee to "be safe" (bad look, hard to price).
Fees stay off the trust path — a transparent on-chain fee on the payment, or a B2B plan beside it.

Five layers, roughly in order of margin:

1. **Enterprise plans (the money).** Businesses pay a subscription + volume tier for undrainable
   **treasury, AI-agent, and escrow** accounts. High willingness to pay at the business level.
2. **Licensing / white-label (the scale lever).** Wallets, exchanges, fintechs embed Keyless accounts
   and pay a license or rev-share. Turns would-be competitors (wallets) into customers.
3. **Take-rate on escrow / high-value flows (the first wedge).** A % of escrowed value or a flat fee per
   release — how an escrow/payments processor earns. Tied to the delivery-escrow first-client use case,
   which has a candidate customer and an obvious fee.
4. **Developer API / platform.** Devs integrate Keyless policy-based signing into their apps.
5. **Per-signature usage fee (baseline).** A tiny fee each time the enclave signs — usage-aligned floor
   (reuses the existing `quoteFee` plumbing). Low margin on cheap XRP txns; it's the floor, not the play.

Nuance: "premium templates" = **hosted / audited / supported** rules + UI + SLA, NOT gatekeeping the
primitive (anyone can still write a rule) — otherwise it fights the open/composable story.

## Long-term vision: the undrainable *policy engine* for XRP (integrate, don't compete)

Reframe Keyless from "a wallet/product" to **the authorization layer wallets and apps integrate rather
than compete with.** You stop being *a wallet* (competing with Xaman / Flare Smart Accounts) and become
**the policy engine they call** — competitors become customers. Bigger TAM, more defensible, and it
sidesteps the "isn't this just FSA?" problem.

**Three caveats that keep it honest (do not lose these):**
1. **Not open space — real incumbents.** Turnkey, Fireblocks, Privy, Dfns already sell "policy engine /
   programmable signing for wallets & fintechs," well-funded. The edge is NOT the idea — it's the
   specific guarantee (a TEE-held key that can't be drained even by its holder) on the chain they
   underserve (XRP/XRPL).
2. **The moat is chain-specific.** Per the top of this doc: the TEE only earns its keep where the chain
   has no contracts (XRPL). On EVM, native AA already does policy-signing WITHOUT a TEE. So the
   defensible framing is **"the policy engine for XRP / non-programmable chains,"** expanding carefully —
   NOT "every chain," which throws away the moat.
3. **Earn the platform, don't start there.** "Be the layer everyone integrates" is a destination reached
   through a wedge use case (escrow / first client), one integration at a time — not a launch posture.

**The reconciled one-liner:** *the undrainable policy engine for XRP — prove it with escrow + enterprise,
become the layer XRP wallets and apps integrate, then expand to any chain where the key needs to be safer
than its holder.* Same ambition, moat intact, anchored to the ground where the TEE actually matters.
