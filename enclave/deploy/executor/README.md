# FXRP mint executor

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
node executor.mjs <xrpl-payment-tx-hash>
# e.g. the test deposit awaiting execution:
node executor.mjs 7A40F6F3528A7491314129C76C88334A50DD36ED3AA4998689828993ECD3E1E4
```

## Config (env)

| Var | Notes |
|---|---|
| `EXECUTOR_KEY` | 0x key with a little C2FLR (pays the attestation fee + gas; earns the executor fee). Any key — no special role. |
| `VERIFIER_URL` | FDC verifier base. Default `https://fdc-verifiers-testnet.flare.network`. |
| `VERIFIER_API_KEY` | FDC verifier `X-API-KEY`. Defaults to Flare's **public, rate-limited testnet key** `00000000-0000-0000-0000-000000000000` (documented at dev.flare.network/fdc/getting-started; confirmed 200 vs 401 without it). Override only for a dedicated production verifier. |
| `DA_LAYER_URL` | Coston2 DA layer. Defaults to `https://ctn2-data-availability.flare.network`. |
| `RPC_URL` | Coston2 C-chain RPC. Has a default. |
| `ATTESTATION_TYPE` / `SOURCE_ID` / `VERIFIER_XRP_PATH` | Default `XRPPayment` / `testXRP` / `xrp`. Confirmed: fassets `DirectMintingFacet.executeDirectMinting(IXRPPayment.Proof)` → `TransactionAttestation.verifyXRPPayment` → `fdcVerification.verifyXRPPayment`, i.e. the dedicated **`XRPPayment`** type (`RequestBody = {transactionId, proofOwner}`), served at `verifier/xrp/XRPPayment/prepareRequest` — NOT the generic `Payment` (which wants `{transactionId, inUtxo, utxo}`). |

## Flow (Flare's canonical FDC pattern)

1. `verifier/<xrp>/<type>/prepareRequest` → `abiEncodedRequest` (validates the XRPL tx).
2. `FdcHub.requestAttestation(abiEncodedRequest){value: fee}` → lands in a voting round.
3. wait until `Relay.isFinalized(fdcProtocolId, roundId)`.
4. DA layer `/api/v1/fdc/proof-by-request-round-raw` → `{ response_hex, proof }`.
5. `AssetManager.executeDirectMinting({ merkleProof, data: decode(response_hex) })`.

Coston2 addresses are hardcoded in `executor.mjs` (FdcHub, FdcRequestFeeConfigurations, FlareSystemsManager,
Relay, FdcVerification, AssetManagerFXRP `0xc1Ca88b9…`).

## Status

The on-chain half (addresses, ABIs incl. `IXRPPayment.Proof`, request→round→proof→execute flow) follows
Flare's canonical FDC reference. The verifier **API key** is no longer a blocker — Flare's public testnet
key is now the default and was confirmed live against `verifier/xrp/Payment/prepareRequest` (200 with the
key, 401 without). Running it against a real deposit tx should mint FXRP to the account's own Flare Smart
Account — the last hop of the undrainable XRP → FXRP on-ramp. Remaining thing to confirm empirically with a
**real** XRPL deposit tx: that direct-minting proofs are served under the generic `Payment` type (the
on-chain call decodes into the XRP-specific `IXRPPayment.Proof`); if FAssets requires a dedicated type, only
`ATTESTATION_TYPE`/`VERIFIER_XRP_PATH` change.

## Self-serve vs service

Because it's permissionless, this can run three ways, all valid:
- **User self-serve** — the user runs this CLI (or we expose it behind a "Complete mint" button that streams
  progress; note the FDC round wait is ~1–3 min, so a long-poll/worker suits it better than a single request).
- **A public executor** — anyone watching Coston2 can complete pending mints for the fee.
- **A small hosted worker** — we run one that watches for Keyless mint deposits and executes them.
