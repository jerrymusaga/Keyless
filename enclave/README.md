# Keyless enclave

The TEE extension that holds the XRPL key and signs payments — **and only the payments an on-chain
policy authorized.**

Forked from [`flare-foundation/fce-sign`](https://github.com/flare-foundation/fce-sign), Flare's
reference TEE extension. What we changed matters more than what we kept, so it's spelled out below.

## The guarantee

Two independent facts, both verifiable from Flare chain state, no trust in us required:

1. **What can be signed** — Flare's `InstructionsFacet` only delivers instructions that came from the
   extension's registered `instructionsSender`. That is the policy contract
   (`backend/src/AuthorizedPayPolicy.sol`). The enclave takes orders from nothing else.
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
`AuthorizedPayPolicy.sol`.

| Command | Input | Effect | Returns |
|---|---|---|---|
| `INIT` | none | Generate the XRPL key inside the enclave. Idempotent — will not overwrite an existing key (that would strand its funds). | the classic `r...` address |
| `PAY` | `abi.encode(XrplPayment)` | Build, sign and submit exactly one XRPL payment. | the XRPL tx hash |

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

## Known limitation

The key is held in memory. **An enclave restart strands any funds at the old address.** Production
needs TEE-sealed persistence; for the demo, don't restart the machine. Stating this out loud beats
discovering it live.
