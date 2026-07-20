# Keyless — User Flows

How a real person uses Keyless, end to end, for every rule template. Read top to bottom the first
time; after that, jump to the template you care about.

---

## The one idea to hold in your head

A Keyless account has **two keys, doing two different jobs**:

| Key | Where it lives | What it does | Who holds it |
|---|---|---|---|
| **The XRP key** | Inside a secure enclave (a TEE on Flare). Born there, never leaves. | Signs and sends the actual XRP payments — but *only* what your rule allows. | Nobody. Not you, not us, not the operator. |
| **Your control key** | In your browser (your "Keyless wallet"). | Signs the Flare transactions that *set and edit the rules*. | You. |

Everything below is just these two keys interacting:
- The **XRP key** is the account's muscle — it moves money, but it's on a leash (the rule).
- The **control key** holds the leash — it decides what the rule is, but it can't move money directly.

> **Why can't you just export the XRP key and use it in Xaman?** Because it doesn't exist outside the
> enclave. A key you can't export is a key nobody can steal, phish, or drain. That's the whole product.
> You *receive* to a Keyless account like any XRP account; you *spend* only through the rule.

---

## Flow 0 — Getting a Keyless wallet (once)

This is your control key. It takes one click and no seed phrase.

1. You open **`/app`**.
2. You click **"Create my Keyless wallet."** The app generates a control key **in your browser** — you
   hold it, we never see it.
3. Keyless tops it up with a little test-network gas so it can sign Flare transactions. (You never
   think about gas; behind the scenes a sponsor funds your control key with a tiny amount of C2FLR.)

That's it. You now have an identity that can create and govern XRP accounts. You can export this key
anytime to back it up or move devices.

---

## Flow 1 — Creating an account (the shared path)

Every template starts the same way. Differences come *after*, in configuration.

1. From **`/app`**, click **"+ New account."**
2. **Name it** (just for you — "Exchange savings", "Trading bot", "Netflix", "Supplier escrow").
3. **Pick one rule** from the cards. This rule is the account's entire security surface.
4. Click **"Create account."** Under the hood:
   - Your control key calls `createWallet` on Flare.
   - That sends an **INIT** instruction to the enclave, which **generates a fresh XRP key** for this
     account — inside the TEE, from its own randomness. No human ever sees it.
   - Your control key then calls `setRule`, pointing the account at the rule you chose.
   - Keyless records the account's **XRP deposit address** on-chain so you (and anyone) can read it.
5. You land on the **account dashboard**: your deposit address, live balance, the rule's settings, and
   a spend panel.

**To fund the account:** copy the deposit address and send XRP to it — from an exchange, a friend, a
payroll run, anything. It's a normal XRP Ledger account for *receiving*.

Now the four templates. Each explains: **who it's for**, **what you set**, **how the money moves**, and
**who it protects you from**.

---

## Template A — Exchange-only / Savings  (the *Allowlist* rule)

**Who it's for:** anyone holding XRP they want kept safe — a savings stash, a cold account, funds you
only ever move to your own exchange deposit address.

**What you set:** one or more **allowlisted addresses**. On the dashboard → *Allow a recipient* → paste
an address → *Allow*. Add as many as you want.

**How the money moves:**
- **In:** anyone sends XRP to your deposit address. Normal.
- **Out:** *you* spend, from the dashboard's **Spend** panel. Enter a recipient and amount → **Pay**.
  The rule checks the recipient is allowlisted. If yes, the enclave signs and sends. If no, it's
  refused and **nothing leaves** — the enclave is never even asked to sign.

**Who it protects you against:** whoever gets in. Steal your control key, hijack the Keyless tab, trick
you into pasting a scammer's address — the account can still only pay addresses *already* on your list.
The attacker can't add themselves (that needs your control key) and even if they had it, moving funds
still only works to allowlisted destinations.

> **Story.** You keep 50,000 XRP in a "Savings" account allowlisting only your Kraken deposit address.
> A fake "wallet sync" site drains every hot wallet you own — but your Keyless savings won't send it a
> cent, because the scammer's address was never on the list.

---

## Template B — Agent / Bot wallet  (the *Rate-limit* rule)

**Who it's for:** giving an **autonomous agent, trading bot, or piece of software** an XRP account it
can spend from — but can never drain.

**What you set:** two things on the dashboard —
1. **Allowlist the recipients** the agent may pay (its counterparties, your exchange, etc.).
2. **A spending allowance:** a cap **per window** (e.g. 10 XRP *per day*).

**How the money moves:**
- **In:** you fund the deposit address with the agent's working balance.
- **Out:** the **agent itself triggers payments** by calling `pay` on Flare (paying its own gas). The
  rule enforces two things on every attempt: the recipient is allowlisted, **and** the running total
  this window stays under the cap. The window resets automatically.

**Who it protects you against:** a hijacked, buggy, or prompt-injected agent. Even fully compromised,
it can only pay addresses you allowlisted, and only up to the cap before it's cut off until the window
resets. The blast radius is "one window's allowance," never the whole balance.

> **Story.** You give a market-making bot an account capped at 100 XRP/day to two exchange addresses.
> A bad prompt convinces the bot to "send everything to this recovery wallet." It tries — and the rule
> refuses: wrong address, and over the cap. Worst case you lost nothing; the bot just got told "no."

---

## Template C — Subscription  (the *Subscription* rule)

**Who it's for:** paying a merchant on a recurring basis **without handing them a blank cheque** — and
without XRPL having native recurring payments.

**What you set:** on the dashboard — the **merchant's address**, a **cap per period** (e.g. 9.99 XRP
*per 30 days*). One merchant per subscription account.

**How the money moves:**
- **In:** you fund the deposit address.
- **Out:** the **merchant pulls** the payment (they call `pay` to their own address). The rule enforces
  that they can only pay *themselves*, only up to the cap, only once per period. You never have to be
  online for the charge.
- **Cancel anytime:** *Cancel subscription* on the dashboard. The merchant can pull nothing further.

**Who it protects you against:** the merchant. They provably cannot overcharge (cap), cannot redirect
the money elsewhere (fixed recipient), and cannot keep billing after you cancel. It's a pull payment
where *you* hold the ceiling, not them.

> **Story.** You subscribe to a service at 9.99 XRP/month. A billing bug tries to charge you 500 XRP.
> The rule caps it at 9.99 and rejects the rest. Later you cancel — the next pull is simply refused.

---

## Template D — Conditional payout / Escrow  (the *FDC Escrow* rule)  · *ships next deploy*

**Who it's for:** paying someone **only when a real-world condition is proven** — "pay the supplier
when delivery is confirmed," "release when a milestone is met."

**What you set:** on the dashboard — the **payee**, a **cap**, and the **release condition** (a short
description that gets hashed on-chain).

**How the money moves:**
- **In:** you fund the deposit address; the money is now *locked*.
- **Prove the condition:** when the condition happens in the world, anyone submits a proof of it from
  **Flare's Data Connector (FDC)** — an attested reading of a Web2 API (a courier's "delivered", an
  oracle's settlement flag). The rule verifies the proof matches your condition and unlocks.
- **Out:** only after unlock, and only to the fixed payee, within the cap.

**Who it protects you against:** early release and wrong payee. Funds cannot move until the world
actually proves the condition, and even then only to the agreed recipient. This is something XRPL's own
escrow can't do — it only understands timeouts and hash-locks, never real-world events.

> **Story.** You escrow 100 XRP for a supplier, condition "shipment delivered." The money sits locked.
> The courier's API flips to "delivered," someone submits the FDC proof, the escrow unlocks, and the
> supplier is paid — automatically, and not a moment before.

---

## Template E — DAO-controlled treasury  · *roadmap, not a template yet*

**The idea:** an XRP treasury that moves **only when a DAO vote passes** — native XRP, no wrapped
token, no bridge, no custodian. The rule would say "only pay if this Governor proposal succeeded."

**Why it's not on the shelf yet:** it's simply one more rule contract nobody's written. That's the
whole architectural bet — a new capability is **one Solidity file** (~30 lines), not a new enclave and
not a new key. The account, the XRP key, and the enclave never change; you just point a wallet at a new
rule. Anyone can write one.

---

## Protecting the control key — and locking a rule

Your control key can *edit rules*. So it's fair to ask: if someone steals it, can they change a rule
and drain the account? Honestly — **for an unlocked account, yes**: a thief with your control key could
repoint the rule (or widen the allowlist) and then pay themselves. The control key is the account's admin,
and it's now the thing worth guarding.

Two things address this:

1. **Lock the rule (on the dashboard).** Any account can **permanently freeze** its rule. Once locked,
   the rule pointer *and* its settings can never change — **not even with your control key**. A stolen
   key becomes useless against a locked account: it can't repoint the rule, can't add an address, can't
   drain. The account can only ever keep doing exactly what it does now.
   - One-way and permanent (if you could unlock it, so could a thief). No unlock.
   - Perfect for **savings / exchange-only** accounts you won't edit again. Leave **flexible** accounts
     (an agent wallet you keep tuning) unlocked — for those, guard the control key and back it up.
   - Locking a subscription/escrow makes it permanent (uncancellable), so only lock what you mean to fix.

2. **Back up and protect the control key.** Export it (Your accounts → control key), store it somewhere
   only you control, and treat it like a vault admin key — because that's what it is.

The honest summary: **locking makes an account undrainable even against control-key theft; for unlocked
accounts, the control key is the thing to protect.**

## The pattern behind all of them

Every template is the same machine seen from a different angle:

1. **You receive** to a normal XRP address.
2. **Something triggers a payment** — you, an agent, a merchant, or an unlocked escrow.
3. **The rule runs first.** If it says no, the enclave never signs and nothing leaves.
4. **If it says yes, the enclave signs** and the XRP moves on the ledger.

The only thing that changes between templates is **step 3 — the rule**. That's why new use cases are
cheap: the hard part (a key that can only obey a contract, on a chain with no contracts) is already
built and running. Everything else is just another rule on the shelf.
