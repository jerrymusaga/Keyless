# Keyless enclave

The TEE extension that holds the XRPL key and signs payments — **and only the payments an on-chain
policy authorized.**

Forked from [`flare-foundation/fce-sign`](https://github.com/flare-foundation/fce-sign), Flare's
reference TEE extension. What we changed matters more than what we kept, so it's spelled out below.

## The guarantee

Two independent facts, both verifiable from Flare chain state, no trust in us required:

1. **What can be signed** — Flare's `InstructionsFacet` only delivers instructions that came from the
   extension's registered `instructionsSender`. That is the policy contract
   (`backend/src/KeylessAccounts.sol`). The enclave takes orders from nothing else.
2. **What code does the signing** — `addTeeVersion` pins this image's code hash on-chain. A machine can
   only join the extension by attesting to that hash, so the operator cannot swap in a modified image
   that ignores the policy.

Put together: the operator runs the machine, holds no key, and can order nothing the policy forbids.

## The one change that makes it real

Upstream `fce-sign` obtains its key with an `UPDATE` instruction: an operator generates a secp256k1
key **off-chain**, encrypts it, and ships it into the enclave.

**We do not do that, and forking it as-is would have made Keyless theatre.** If the operator generated
the key, they kept a copy — they can sign any XRPL transaction offline, and every on-chain policy above
them is decorative.

Instead, the enclave **generates its own key** (`INIT`) and returns only the classic address:

| | upstream `fce-sign` | Keyless |
|---|---|---|
| Key origin | operator generates, encrypts, sends in | **enclave generates it internally** |
| Who has seen it | the operator | **nobody, ever** |
| Key import path | `UPDATE` → `decryptViaNode` | **deleted — no such code path exists** |

`decryptViaNode()` and `parseSecp256k1PrivateKey()` are gone from this fork on purpose. If no code can
import a key, no operator can have kept one. The guarantee is structural, not a promise. **Do not add
them back.**

## Instructions

The op type is `KEYLESS_XRP` — deliberately not one of Flare's system op types, which are reserved for
extension 0 and rejected from non-system senders. It must match the `bytes32` constants in
`KeylessAccounts.sol`.

| Command | Input | Effect | Returns |
|---|---|---|---|
| `INIT` | `abi.encode(walletId)` | Generate that wallet's XRPL key inside the enclave. Idempotent per walletId — will not overwrite an existing key (that would strand its funds). | the classic `r...` address |
| `XRPSEND` | `abi.encode(XrplPayment)` | Build, sign and submit exactly one XRPL payment. | the XRPL tx hash |

**The pay command is `XRPSEND`, not `PAY`.** `PAY` collides with Flare's reserved `op.Pay`, and the
tee-proxy switches on `opCommand` alone — so an instruction named `PAY` is silently dropped and never
reaches the enclave. It costs you a payment that looks authorized on-chain and simply never happens.

`XrplPayment` is `(bytes32 walletId, string recipient, uint256 amount, bytes32 paymentReference)` —
the same struct the policy contract encodes. `payment_test.go` pins that wire format with a golden
vector taken straight from Solidity's `abi.encode`, because two ABI implementations in two languages
silently disagreeing is exactly the bug that would make an agent default on a redemption.

The enclave does **not** re-check the policy. The policy is the contract; duplicating it here would
just create a second place for the two to disagree. What the enclave enforces is that it never invents
a payment of its own — the signing key has exactly one caller, and that caller only runs on an
instruction the chain already authorized.

## Build & test

```bash
cd go
go build ./...
go test ./...
```

## Known limitation — keys do not survive a restart

Keys are held in memory, and the simulated enclave regenerates its identity on boot. **An enclave restart
strands every account's funds at addresses nobody can sign for.**

This is a testnet shortcut, not a design choice, and it has a real cost: anything that redeploys the
enclave is effectively destructive. `railway.json` watches `/go/**` and `/Dockerfile`, so editing either
one — even a comment — is a redeploy. If you have to, `scripts/reregister-railway.sh` re-registers the new
machine, but the old keys are gone.

The fix is threshold key backup (`walletkeymanager`): secret-share each signing key across ⅔ of Flare's
data providers plus the owner's key admins, so a dead machine doesn't mean dead funds. It is the top item
on the roadmap, and it is the prerequisite for every other enclave change — see
[`SECURITY_NOTES.md`](../SECURITY_NOTES.md).

Two stale comments in `go/internal/extension/` still name `AuthorizedPayPolicy` (the old name for
`KeylessAccounts`). They are wrong but harmless, and they are left alone for exactly the reason above.
