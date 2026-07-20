# Keyless — Staking / Yield Roadmap

Status: **roadmap**, not built. This is the design + feasibility write-up so we can commit to it with
eyes open. Verified against XRPL and Flare docs (July 2026); sources at the bottom.

---

## The framing (read this first)

**Keyless is not going to build a staking protocol.** Sourcing yield means either running validators or
reinventing the XRPL AMM / sFLR — a different, much larger business, and one where we'd be a worse
version of things that already work.

What Keyless builds is the thing none of them have: **a staked position that can't be drained.** Same
promise as the rest of the product — the key can only do what the rule allows — pointed at yield:

> **"Keyless doesn't chase yield. It makes yield safe. Stake it, LP it, delegate it — the position can
> only ever move between you and the protocol, never to whoever gets in."**

Two routes below. Route A stays 100% native XRP (on-brand). Route B is more powerful but crosses into
FLR (a deliberate scope decision — flagged).

---

## Route A — Native XRPL AMM yield ("LP-safe account")

The only *native* XRP yield that exists: provide liquidity to an XRP Ledger AMM pool and earn a share of
its trading fees. No bridge, no wrapped asset — the XRP never leaves the ledger.

### How the underlying works (verified)
- An AMM pool holds two assets and issues **LP Tokens** to depositors in proportion to their share.
- **`AMMDeposit`** adds liquidity → you receive LP Tokens. Two modes: *double-asset* (both pool assets,
  proportional, no fee) or *single-asset* (one asset, charged a fee based on how much it shifts the
  pool).
- **`AMMWithdraw`** returns LP Tokens → you get back your share of the pool **plus accrued fees**. The
  assets return to the account that holds the LP Tokens.
- Pricing is a constant-product formula (Uniswap-V2-like).

### What Keyless adds
The account's XRP key is in the enclave and today signs only `Payment` (our `XRPSEND` op). To LP, the
enclave also signs `AMMDeposit` / `AMMWithdraw`, and a rule authorizes:
- **Deposit** only into an **owner-approved pool** (a specific asset pair / AMM account).
- **Withdraw** returns assets **into the same account** (inherent to `AMMWithdraw`) — never elsewhere.
- **Getting funds out** still goes through the account's normal payment rule. So even after a withdraw,
  an attacker can't pay them anywhere the payment rule doesn't already allow.

**The guarantee:** you (or a yield bot you authorize) can enter, exit, and compound an LP position, but
the position and its fees can only ever land back in *your* account. An attacker who owns the key/app
can't redirect your liquidity to themselves.

### What we'd build
1. **Enclave:** new ops `AMM_DEPOSIT` / `AMM_WITHDRAW` that construct + sign those XRPL txs. (Enclave
   code changes → code-hash changes → the machine must re-attest. Plan it with a redeploy.)
2. **Contract:** an `AmmRule` (owner sets the approved pool + optional caps) and an instruction path in
   `KeylessAccounts` for AMM ops, gated by the rule — same shape as `pay`.
3. **UI:** an "Earn" panel on the dashboard — pick a pool, deposit, see LP position + accrued fees,
   withdraw.

### Honest caveats
- **This is yield *with impermanent-loss risk*, not risk-free "staking."** XRP-vs-token pools move; a
  single-asset deposit also pays a fee. We market it as **"yield made undrainable,"** never "safe yield."
- Most XRP pools are **XRP + an issued token**, so LPing usually needs a second asset. Single-asset
  deposit into an existing pool is possible but carries the fee + IL exposure above.

**Scope:** medium. One enclave op-pair + one rule + one panel. Stays fully native XRP.

---

## Route B — Enclave-held Flare staking key ("a staking key that can't abscond")

The bigger swing. Flare *does* have staking (FLR does; XRP doesn't), and it's mostly EVM contract calls,
which an enclave key can sign.

### How the underlying works (verified)
Flare has two earn mechanisms, both usable from the EVM C-chain:
- **FTSO delegation** — wrap FLR → **WFLR** (an ERC-20), then `delegate()` to up to **two** providers.
  Stays liquid/unlocked; rewards on **3.5-day** epochs, claimed on-chain.
- **Liquid staking (sFLR / Sceptre)** — deposit FLR, receive **sFLR** (auto-compounding ERC-20). A
  single contract call; the simplest to integrate.
- **Validator staking (P-chain)** — min **50k FLR**, min **14 days**, funds moved C-chain → P-chain and
  back. Heavier (different chain + key handling) — a *later* phase, not the entry point.

### What Keyless adds
The enclave already mints keys per account. Here it mints an **EVM (secp256k1) key** whose rule allows
**only** staking-shaped calls to **allowlisted contracts** — `WNat.delegate()`, the sFLR deposit, reward
claims — and any **unstake/withdraw only back to the owner**. Nothing else signs.

**The guarantee:** hand this key to a yield manager, an agent, or a "set-and-forget" bot. It can stake,
re-delegate, compound, and claim — but it can **never** withdraw the principal or rewards to anyone but
you. A staking key that physically cannot abscond with the stake.

### What we'd build
1. **Enclave:** support an **EVM/C-chain key type** (declare via `addSupportedKeyTypes`); INIT generates
   the EVM key; sign EVM txs. Bigger change than Route A. **Open question to validate:** confirm the FCE
   extension's supported signing algos cover EVM secp256k1 the way we need (`getSystemSupportedSigningAlgos`).
2. **Contract:** a rule that allowlists **contract + method** (not a payee address) and pins withdraw
   destinations to the owner.
3. **UI:** a "Stake" panel — choose delegation or sFLR, amount, see position + rewards, unstake to owner.

### Strategic note (the real trade-off)
This is **FLR, not XRP.** It broadens Keyless from "a programmable XRP account" to **"enclave keys that
can only do what rules allow, on any chain."** That's a genuine expansion:
- **Upside:** bigger surface, and it *proves* the architecture generalizes beyond XRP — a strong story.
- **Risk:** it can blur the tight "XRP account that can't be drained" pitch that's finally landing.

Recommendation: keep the **headline** XRP-only; introduce Route B as **"the same idea, now for staking
keys"** — a second act, not a competing message.

**Scope:** large (EVM signing in-enclave + method-allowlist rule + cross-chain UX). Furthest out.

---

## Suggested sequencing

1. **Ship the core product live first** (current app + full redeploy). Nothing here starts before that.
2. **Route A (XRPL AMM)** next — native, on-brand, one enclave op-pair. This is the honest "staking for
   XRP" answer.
3. **Route B (Flare staking key)** as the ambitious follow-on that shows Keyless is a cross-chain key
   primitive, once the FCE EVM-key question is validated.

## Open questions to close before committing
- **Route A:** which pools do we support first (XRP + which token)? How do we present IL risk honestly in
  the UI?
- **Route B:** does the FCE extension let our machine attest an **EVM signing key** alongside the XRP one,
  or does that need a second extension / key type? (Validate against the manager's supported signing algos.)
- Both change the enclave image → both need a re-attestation + redeploy. Batch them.

---

## Adjacent: FXRP via mint-to-tag (the on-ramp for Route B)

If Keyless ever offers yield through **Flare DeFi** (not native XRPL AMM), the XRP has to become **FXRP**
first. Flare's **FAssets v1.3 "mint-to-tag"** makes that a single tagged XRP payment, and it's
**Kristaps's own feature** (@fassko) — so integrating it is both technically clean and politically smart.

**How mint-to-tag works:** reserve a **destination tag** on Flare mapped to your Flare address (once) →
send a normal XRP payment to the **FAssets Core Vault** carrying that tag/memo → an **executor** relays
the **FDC proof** and calls `executeDirectMinting` → **FXRP lands at your Flare address.** No agent
selection, no collateral reservation. It rides the tag/memo rails XRP already uses.

**The Keyless fit:** a **"safe FXRP mint" rule** — an account whose rule only permits payments to the
FAssets Core Vault with your tag. It can *only* mint FXRP to your own Flare address, never elsewhere.
Keyless `pay` already carries a `paymentReference` (memo), so this is the same payment shape. Pitch:
*"mint FXRP from an XRP account that can't be drained."*

**Tension (must frame honestly):** minting FXRP **is** bridging XRP onto Flare — it contradicts the
"native XRP, never bridged" headline. So this is an **opt-in adjacent capability** ("native by default;
enter Flare's ecosystem safely when you choose"), never the core pitch.

**Before building:** verify FAssets / mint-to-tag availability on **Coston2** (it launched on Songbird;
confirm testnet reach). Verdict: strong integration + validation angle (plugs into Flare's flagship XRP
product), but adjacent — don't let it derail the core undrainable-account loop. Full note:
`memory/flare-mint-to-tag-fxrp.md`.
