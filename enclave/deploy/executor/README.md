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
| **`VERIFIER_API_KEY`** | **Required.** Testnet FDC verifier `X-API-KEY` — obtain from Flare (dev portal / the hackathon). Without it, `prepareRequest` returns 401. |
| `DA_LAYER_URL` | **Required.** Coston2 DA layer, e.g. `https://ctn2-data-availability.flare.network`. |
| `RPC_URL` | Coston2 C-chain RPC. Has a default. |
| `ATTESTATION_TYPE` / `SOURCE_ID` / `VERIFIER_XRP_PATH` | Default `Payment` / `testXRP` / `xrp`. **Confirm** the exact attestation type used for XRP *direct-minting* proofs — the on-chain struct is the XRP-specific `IXRPPayment` (`RequestBody = {transactionId, proofOwner}`, richer `ResponseBody`), which may be served under a dedicated type/endpoint rather than the generic `Payment`. |

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
Flare's canonical FDC reference. **Two items to obtain/confirm before it runs end-to-end:** the verifier
**API key**, and the exact **attestation type/endpoint** for XRP direct-minting proofs. Both are external to
Keyless. Once set, running it against the pending test deposit mints FXRP to the configured Flare address —
the last hop of the undrainable XRP → FXRP on-ramp.

## Self-serve vs service

Because it's permissionless, this can run three ways, all valid:
- **User self-serve** — the user runs this CLI (or we expose it behind a "Complete mint" button that streams
  progress; note the FDC round wait is ~1–3 min, so a long-poll/worker suits it better than a single request).
- **A public executor** — anyone watching Coston2 can complete pending mints for the fee.
- **A small hosted worker** — we run one that watches for Keyless mint deposits and executes them.
