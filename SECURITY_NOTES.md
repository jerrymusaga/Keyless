# Security notes

Findings that are worth remembering but aren't bugs — latent couplings, assumptions we depend on, and the
conditions that would turn them into problems. Each entry states what would have to change for it to
matter, so a future reader can re-check it in minutes rather than rediscover it.

---

## 1. Keyless emits an XRPL destination tag on FXRP mints, which FSA's source says it shouldn't

**Status:** not exploitable today · **Severity if it became reachable:** critical (every FXRP mint stolen)
**Found:** 2026-08-07, reading `MemoInstructionsFacet` after Flare announced FSA custom instructions.

### What we do

The enclave derives the XRPL `DestinationTag` from the **top 4 bytes of the payment reference**
(`enclave/go/internal/extension/extension.go`, around the `destination-tag-v1` marker):

```go
if tag := binary.BigEndian.Uint32(p.PaymentReference[:4]); tag != 0 { /* set DestinationTag */ }
```

That exists for `ExchangeRule`: a policy pinning `(recipient, tag)` must bind the exact tag the enclave
signs, or a CEX deposit could be redirected to another customer's account. Correct, and deliberate.

But it applies to **every** payment. For an FXRP mint the reference is
`mintMemo(personalAccount)` = `0x4642505266410018 · 0000 · <20-byte address>`, so the top 4 bytes are
`0x46425052` — part of the FAssets `DIRECT_MINTING` prefix, not a tag anyone chose. Every Keyless mint
therefore goes out with `DestinationTag = 1178751058`.

`MemoInstructionsFacet` (FSA diamond `0x434936d4…`, facet `0x32c6379B…`) says plainly:

> XRPL transactions to smart accounts must NOT use destination tags — using a tag allows front-running via
> tag purchase on the direct minting facet.

### Why that warning is serious

`DirectMintingFacet._decodeTarget` (AssetManagerFXRP `0xc1Ca88b9…`, facet `0x4aFaEda2…`) resolves the mint
recipient with the **tag taking precedence, and the memo ignored entirely**:

```solidity
if (body.hasDestinationTag) {
    address registeredAddress = DirectMinting.mintingRecipientForTag(destinationTag);
    if (registeredAddress != address(0)) {
        return MintingTarget({ recipient: registeredAddress, ... });   // memo never read
    }
}
// only then: the DIRECT_MINTING payment reference
```

If anyone owned tag `1178751058`, every Keyless FXRP mint would credit **their** address. `FxrpRule` pins
the mint memo on-chain precisely so a stolen control key can't repoint a mint — and the tag path bypasses
that check completely. One registration would capture every Keyless account, since the tag is the same for
all of them.

### Why it is not reachable

Tags cannot be chosen. `MintingTagManager._reserve()` (proxy `0x0945117…`, impl `0x1f9582ba…`) allocates
them sequentially:

```solidity
uint256 mintingTag = nextAvailableTag;
nextAvailableTag += 1;
```

Measured on Coston2, 2026-08-07:

| | tag | reservations needed to reach it |
| --- | --- | --- |
| `nextAvailableTag` | **338** | — |
| FSA vault instruction (`0x11 << 24`) | 285,212,672 | ~285 million |
| FSA redeem-home (`0x02 << 24`) | 33,554,432 | ~33.5 million |
| **FXRP mint** (`0x46425052`) | 1,178,751,058 | ~1.18 billion |

At a `reservationFee` of **100 C2FLR**, the cheapest of these costs ~3.35 billion C2FLR and 33.5 million
transactions. `mintingRecipient(1178751058)` returns the zero address, so `_decodeTarget` falls through to
the memo — which is why minting works correctly today.

### What would make it live

**Any change on Flare's side that allows reserving a chosen tag** — a reasonable feature to add, and one
that would make Keyless vulnerable the same day, with no change on our side and no signal to us. This is a
dependency on an implementation detail of someone else's contract, not on anything we control.

Re-check `_reserve` in `MintingTagManager` after any FAssets upgrade. It is a ten-line read.

### Why we haven't fixed it

The fix is in the enclave: don't set a destination tag when the recipient is the Core Vault or the FSA
provider wallet. But `enclave/railway.json` watches `/go/**`, so touching that file **restarts the enclave,
and the simulation-mode enclave regenerates its identity on boot** — every existing account's key is lost
and its funds become unspendable. That is a far larger and more certain harm than the one being prevented.

The clean sequence, when it's worth doing:

1. Land the threshold key backup (WalletKeyManager) so an enclave restart is survivable — see
   `FCC_TRACK2.md`. This is the prerequisite, and it's the same one mainnet needs anyway.
2. Then gate the tag on recipient, rebuild, re-attest the code hash, redeploy.

### Open question for Flare

> `MemoInstructionsFacet` says XRPL payments to smart accounts must not use destination tags. Our enclave
> derives one from the payment reference, so every direct mint carries `0x46425052`. Sequential allocation
> in `MintingTagManager` appears to be the only thing making that unreachable — is that right, and is
> choosable-tag reservation something you'd ever add?

---

## 2. `authorize()` advances state before the enclave submits

**Status:** accepted behaviour · **Affects:** `RateLimitRule`, `ScheduledRule`

`KeylessAccounts.pay` calls `rule.authorize()` — which records spend against a limit, or advances a
schedule's `nextDue` — and only then sends the instruction to the enclave. If the XRPL submission fails,
most realistically because the account is underfunded, that state change is not rolled back.

It fails in the safe direction: a **missed** payment, never a double one. Mitigated off-chain — the
scheduled watcher reads the XRP balance before attempting a run, and the UI warns ahead of the due date
rather than reporting a skip afterwards. Worth knowing before anyone treats a scheduled payment as
guaranteed rather than permitted.

---

## 3. Superseded rule deployments strand accounts

**Status:** handled in the UI · **See:** `SUPERSEDED_RULES` in `frontend/lib/keyless.ts`

An account keeps pointing at whichever rule address it was given. Redeploying a rule doesn't move it: the
old contract still governs it and its funds are untouched, but the executors watch only the current
address, so nothing automated runs, and the config panel writes to the current rule so settings appear to
vanish.

Migration is part of a rule redeploy, not cleanup afterwards:

1. Add the old address to `SUPERSEDED_RULES` **and** `LEGACY_RULE_NAMES`.
2. Update the executor's default (`scheduled.mjs` had the replaced address as its `SCHEDULED_RULE` default
   and Railway sets only `WATCHER` and `EXECUTOR_KEY` — so the live watcher polled a dead contract).
3. Set the address explicitly in Railway rather than relying on a default.

Funds are never at risk here: the XRPL key is bound to the `walletId`, not to the rule.
