# Keyless — user flows

What a person actually does, screen by screen. For the architecture and the addresses, see the
[README](README.md).

## The one idea to hold

There are **two keys**, and confusing them is the only way to misread everything below.

| | Where it lives | What it can do |
|---|---|---|
| **Control key** | your browser, 12 words you write down | Edits the policy. Requests payments. **Can never move money outside the policy.** |
| **XRP key** | inside the Flare Confidential Compute enclave | Signs payments — and only ones a rule already approved. **Nobody holds it. It cannot be exported.** |

Losing the control key loses the ability to *change* a policy. It does not lose the money.

---

## Flow 0 — getting a wallet (once)

1. Open the app → **Create my Keyless wallet**.
2. Twelve words appear. **You cannot continue until you confirm you've written them down** — there's no copy
   button, on purpose.
3. That's your control key. It signs rule changes locally, so there are no wallet popups anywhere else.

Returning on another device: **Import** the same twelve words. Your accounts are then recovered **from
chain** (`WalletCreated` events), not from local storage — so nothing about your account list depends on the
browser you made it in.

---

## Flow 1 — creating an account

1. `/app/new` → name it.
2. **Choose the policy before the account exists.** The chooser asks four questions — who can be paid, how
   much can leave, when, and what has to be true first — plus one that isn't a payment question at all
   (earn on your XRP).
3. **Create account** → the contract sends `INIT` → the enclave generates a fresh XRPL keypair from its own
   entropy and reports back **only the address** (~10s).
4. Fund that address from any XRP wallet or the testnet faucet.

Because the policy is chosen first, **no Keyless account has ever existed without a rule.**

---

## The five policies

### Exchange & allowlist — *"who can be paid?"*
Add the addresses this account may ever pay. For a CEX deposit, add its **destination tag** too — the rule
pins *(address, tag)* as a pair, so the right exchange under someone else's tag is refused. Optionally set a
**max per payment**.

*Try to break it:* a stranger's address → `recipient not allowed`. The same exchange with the wrong tag →
`wrong destination tag`. The right address and tag but too much → `over per-tx limit`.

### Spending limit — *"how much can leave?"*
An approved list **plus** a cap: per rolling window, per calendar period, or a one-off budget that never
refills. The panel shows what's left and when it refills.

*For:* an agent, an app, an allowance — anything you'd rather not hand a key to. It can spend; it can't
drain.

### Scheduled payments — *"on a set date?"*
Fixed payee, fixed amount, a calendar slot, and a **capped number of runs**. Missed runs are skipped rather
than accrued, so an account left idle can't wake up owing a backlog. Nothing can be sent before it's due —
by anyone, including you.

*For:* standing orders, contributor payouts, moving a fixed amount into cold storage each month.

### Conditional — *"once it's proven?"*
Pick what has to be true — an XRP price, a temperature at a place, a GitHub issue closing — and the rule
pins the **whole request**: the URL, the query, the transform, and the exact answer that counts. Set a
deadline and a fallback.

Until Flare's Data Connector attests it, **every** recipient is refused — the payee *and* you taking it
back. A watcher (anyone can run one) reads the API, requests an attestation, and calls `release`. Only then
can the payment go.

*For:* escrow, bounties, parametric insurance, milestone payouts.

### FXRP — *"earn on your XRP, safely"*
1. **Decide where it can cash out** — approve an address up front.
2. **Mint** — XRP goes to the FAssets Core Vault and comes back as FXRP, into a Smart Account **computed
   on-chain from your account id**, so a stolen key can't repoint the mint.
3. **Put it to work** — Firelight or Upshift.
4. **Bring it home** — redeem FXRP back to XRP on your XRPL address.
5. **Cash out** — to the approved address, and nowhere else.

The account knows four moves: mint, earn, redeem, come home. Everything else is refused — **including
instructions that didn't exist when the rule was written**, because the allowlist is closed rather than a
blocklist.

---

## Trying to break it

Every account page has a **Try to break it** panel. It runs the account's **real deployed rule** as a
gasless `eth_call` — nothing moves, nothing is signed, no wallet needed. The refusal you see is the rule's
own words.

That's also the honest way to check the product before funding anything: make it say no first.

---

## Locking

`Lock this policy` is **one-way**. After it, neither the rule pointer nor its configuration can change —
not by you, not by anyone holding your control key.

Before locking, the app shows every address the account will *still* be able to reach, because that list is
what you're agreeing to forever.

**Lock before funding anything that matters.** An unlocked account is only as safe as the control key: a
stolen key can `setRule` to something permissive and then pay. Locked, it can't.

---

## The pattern behind all of them

Every policy answers one question, and the account can only ever do what the answers allow. Adding a
capability means **one new rule contract** — the key, the enclave and the account never change.

And `pay()` is permissionless: **the rule is the gate, not the caller.** That's why you can hand an agent an
account id and nothing else, and why a keeper can trigger a due or proven payment without being trusted
with anything.
