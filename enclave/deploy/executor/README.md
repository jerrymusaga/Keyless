# Keyless executors

Two permissionless watchers live here. Both FDC-attest a real-world fact and complete a step the user's
own policy already authorised — neither can sign anything on a user's behalf, and neither needs privileged
knowledge: what each account is waiting on is readable on-chain.

| `WATCHER` | Completes | Why it's needed |
|---|---|---|
| `mint` (default) | FXRP direct mints | Flare relays FSA vault deposit/redeem, but **not** `executeDirectMinting` — without this a mint waits for a random bot. |
| `conditional` | Conditional-policy releases | An account stays locked until someone proves its condition. This is what makes it unlock by itself. |
| `scheduled` | Standing orders falling due | A schedule is enforced on-chain but not *executed* there. Without this, a due payment waits for someone to press a button. |

## Deploy on Railway (one service per watcher)

Deploy this same root **once per watcher**; `npm start` reads `WATCHER` to decide which one a service is.

```
Root directory : enclave/deploy/executor
Start command  : npm start        (the default — no need to set it)

Service A  WATCHER=mint          EXECUTOR_KEY=0x…
Service B  WATCHER=conditional   EXECUTOR_KEY=0x…
Service C  WATCHER=scheduled     EXECUTOR_KEY=0x…
```

`EXECUTOR_KEY` is any funded Coston2 key — no special role. Each watcher pays a small FDC attestation fee
per job; the mint watcher earns the executor fee back, so it is roughly self-funding. Everything else
(verifier, DA layer, rule addresses) has a working default.

No watcher spends a fee speculatively: the conditional one previews the answer for free via the
verifier's `prepareResponse` first, the mint one only acts on deposits it can see on the ledger, and the
scheduled one reads the account's XRP balance before attempting a run — `authorize` advances the schedule
before the enclave submits, so paying from an account that can't cover it would burn the slot outright.

The scheduled watcher is the one with no discretion at all: payee, amount and date are pinned on-chain, so
the worst a hostile copy of it can do is run your payroll on time. That is why it is safe to let anyone
run it — `pay` is permissionless precisely so an account never depends on us being up.

---

## FXRP mint executor

Completes a Keyless **FXRP mint**. After a `FxrpMintRule` account pays the FAssets Core Vault (an XRPL
payment carrying the `DIRECT_MINTING` memo — see `backend/src/rules/FxrpMintRule.sol`), one permissionless
on-chain step remains: prove the XRP payment via Flare's Data Connector (FDC) and call
`AssetManager.executeDirectMinting(proof)`. FXRP then mints to the Flare address encoded in the memo.

**Anyone can run this — including the user.** `executeDirectMinting` for a plain `DIRECT_MINTING` memo is
permissionless (the memo restricts nothing; only a `DIRECT_MINTING_EX` memo pins an executor). The executor
pays the small FDC attestation fee + gas and earns the flat `directMintingExecutorFeeUBA` in return, so it
is self-funding. It signs nothing on the user's behalf — it can only finish a mint the user already
authorised and paid for.

## Run

```bash
npm install

# one-off: complete a single mint by its XRPL tx hash
node executor.mjs 7A40F6F3528A7491314129C76C88334A50DD36ED3AA4998689828993ECD3E1E4

# always-on: watch every Keyless account and auto-complete mints as they land
node executor.mjs watch
```

**Watch mode** enumerates Keyless accounts from `KeylessAccounts` `WalletCreated` events → `xrplAddressOf`,
polls each account's XRPL payments for Core-Vault deposits carrying the `DIRECT_MINTING` memo, and completes
any it hasn't yet. On startup it records the existing backlog *without* minting (so it doesn't burn ~90s + a
fee re-attesting already-minted history) and only completes **new** mints from then on — use the single-tx
mode to backfill a specific past deposit. Idempotent: a deposit already minted (by us or a Flare bot) reverts
`PaymentAlreadyConfirmed` and is skipped. Deploy it as an always-on worker (e.g. Railway) with `EXECUTOR_KEY`.

### Why only mint? (deposit / redeem are already fast)
Every FXRP action waits on the same ~90s FDC voting round — that floor is Flare protocol timing, not this
script. The difference: **FSA vault deposit / redeem are auto-completed by Flare's own executor** (verified
live — it serves all accounts, promptly), so they need nothing from us. **Direct minting is NOT relayed by
Flare**, so without this watcher a mint waits for a random bot to notice. This closes that one gap.

## Config (env)

| Var | Notes |
|---|---|
| `EXECUTOR_KEY` | 0x key with a little C2FLR (pays the attestation fee + gas; earns the executor fee). Any key — no special role. |
| `VERIFIER_URL` | FDC verifier base. Default `https://fdc-verifiers-testnet.flare.network`. |
| `VERIFIER_API_KEY` | FDC verifier `X-API-KEY`. Defaults to Flare's **public, rate-limited testnet key** `00000000-0000-0000-0000-000000000000` (documented at dev.flare.network/fdc/getting-started; confirmed 200 vs 401 without it). Override only for a dedicated production verifier. |
| `DA_LAYER_URL` | Coston2 DA layer. Defaults to `https://ctn2-data-availability.flare.network`. |
| `RPC_URL` | Coston2 C-chain RPC. Has a default. |
| `ATTESTATION_TYPE` / `SOURCE_ID` / `VERIFIER_XRP_PATH` | Default `XRPPayment` / `testXRP` / `xrp`. Confirmed: fassets `DirectMintingFacet.executeDirectMinting(IXRPPayment.Proof)` → `TransactionAttestation.verifyXRPPayment` → `fdcVerification.verifyXRPPayment`, i.e. the dedicated **`XRPPayment`** type (`RequestBody = {transactionId, proofOwner}`), served at `verifier/xrp/XRPPayment/prepareRequest` — NOT the generic `Payment` (which wants `{transactionId, inUtxo, utxo}`). |
| `KEYLESS_ACCOUNTS` / `XRPL_RPC` / `POLL_SECONDS` | **Watch mode.** KeylessAccounts manager (default `0x57eb…`), XRPL testnet JSON-RPC (default `s.altnet.rippletest.net:51234`), and loop interval (default 30s). |

## Flow (Flare's canonical FDC pattern)

1. `verifier/<xrp>/<type>/prepareRequest` → `abiEncodedRequest` (validates the XRPL tx).
2. `FdcHub.requestAttestation(abiEncodedRequest){value: fee}` → lands in a voting round.
3. wait until `Relay.isFinalized(fdcProtocolId, roundId)`.
4. DA layer `/api/v1/fdc/proof-by-request-round-raw` → `{ response_hex, proof }`.
5. `AssetManager.executeDirectMinting({ merkleProof, data: decode(response_hex) })`.

Coston2 addresses are hardcoded in `executor.mjs` (FdcHub, FdcRequestFeeConfigurations, FlareSystemsManager,
Relay, FdcVerification, AssetManagerFXRP `0xc1Ca88b9…`).

## Status

**PROVEN END-TO-END (2026-07-29).** Ran against the pending test deposit
`7A40F6F3…ECD3E1E4` (2 XRP → Core Vault): all five steps executed — `XRPPayment` prepareRequest with the
public key → `FdcHub.requestAttestation` → round 1409545 finalized → DA-layer proof (fully-populated
`IXRPPayment` responseBody: memo `0x4642505266410018…`, receivedAmount 2000000) → `executeDirectMinting`.
The final call reverted only with `PaymentAlreadyConfirmed()` (`0x18dce79f`) — the double-spend guard,
because a permissionless Flare executor had already minted this 4-day-old deposit (confirmed: the memo
recipient holds the 2 FXRP). So the whole pipeline works; the only reason it didn't mint *here* is that the
deposit was already consumed. A **fresh, unminted** deposit tx hash will mint cleanly.

## Self-serve vs service

Because it's permissionless, this can run three ways, all valid:
- **User self-serve** — the user runs this CLI (or we expose it behind a "Complete mint" button that streams
  progress; note the FDC round wait is ~1–3 min, so a long-poll/worker suits it better than a single request).
- **A public executor** — anyone watching Coston2 can complete pending mints for the fee.
- **A small hosted worker** — we run one that watches for Keyless mint deposits and executes them.
