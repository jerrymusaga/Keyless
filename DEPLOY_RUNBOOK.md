# Keyless — Redeploy + Go-Live Runbook

Takes the app from "built" to "working live" on Coston2. ~20 minutes. You need your deployer key; I
don't broadcast on-chain for you.

**What this does:** deploys `KeylessAccounts` + all five policies, rebinds it as the extension's
`instructionsSender`, points the app at the new addresses, and wires the three env vars. **The live TEE
machine is untouched** — no enclave change, so no re-attestation, and the reward-epoch registration gotcha
never comes up.

---

## 0. Prerequisites

Three keys and one URL. Two of the keys can be the same as your deployer if you want to keep it simple.

| Thing | What it is | Needs gas? |
|---|---|---|
| **Deployer key** | Broadcasts the deploy + bind. Must own extension **65645** (the account that ran `register`). | Yes (C2FLR) |
| **Reporter key** | Writes wallets' XRPL addresses on-chain (`reportXrplAddress`). Can be the deployer, or a dedicated key. | Yes (C2FLR) |
| **Faucet/sponsor key** | Funds users' browser control keys with a little gas. **Testnet only.** Keep it topped up, not your main key. | Yes (C2FLR) |
| **Enclave URL** | The running enclave's base URL (its `GET /state` serves wallet → r-address). | — |

Get C2FLR from https://faucet.flare.network/coston2.

---

## 1. Deploy the contracts

Set these in `backend/.env` (foundry auto-loads it for the script's `env()` reads):

```dotenv
COSTON2_RPC=https://coston2-api.flare.network/ext/C/rpc
PK=0x<deployer-private-key>
EXTENSION_ID=65645
TEE_EXTENSION_REGISTRY=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE   # the Flare TEE manager diamond
TEE_MACHINE_REGISTRY=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE     # same diamond; both facets live on it
ENCLAVE_REPORTER=0x<reporter-ADDRESS>     # the reporter key's address; defaults to deployer if unset
# CLAIM_BACK=0x...                         # optional; defaults to deployer
# FDC_VERIFICATION=0x906507E0B64bcD494Db73bd0459d1C667e14B933   # optional; Coston2 default is baked in
# FSA_DIAMOND / CORE_VAULT / FSA_PROVIDER_WALLET / FXRP_MAX_TRIGGER   # optional; Coston2 defaults baked in
```

Then, from `backend/`:

```bash
cd backend
set -a; source .env; set +a          # export .env into the shell for --private-key
forge script script/Deploy.s.sol:DeployKeyless \
  --rpc-url coston2 --broadcast --private-key "$PK"
```

Copy the printed addresses — you'll need all of them:

```
KeylessAccounts  : 0x...
ExchangeRule     : 0x...
RateLimitRule    : 0x...
ScheduledRule    : 0x...
ConditionalRule  : 0x...
FxrpRule         : 0x...
Enclave reporter : 0x...   (sanity-check this matches your reporter key's address)
```

---

## 2. Bind KeylessAccounts as the extension's instructions sender

This is the switch that makes the enclave obey the **new** contract.

> **The instructions sender is fixed when an extension is registered, not afterwards.** The registry's
> `register(stateVerifier, instructionsSender)` is what binds it, and it mints a fresh extension id each
> time — so pointing the enclave at a redeployed `KeylessAccounts` means registering a **new extension**,
> not rebinding 65645. Budget for a new id, and expect to re-run the machine registration against it.
>
> (An earlier `script/BootstrapExtension.s.sol` is referenced in older notes. It was deleted when the
> single-wallet contracts were removed — don't go looking for it.)

From `enclave/`:

```bash
cd go/tools
go run ./cmd/register-extension \
  -c https://coston2-api.flare.network/ext/C/rpc \
  -instructionSender 0x<new-KeylessAccounts-from-step-1>
```

It prints the new extension id. Then have the contract discover and cache it — once, permanently:

```bash
cast send 0x<new-KeylessAccounts> "setExtensionId()" \
  --rpc-url coston2 --private-key "$PK"
```

`setExtensionId()` scans the registry for the id bound to this address, so it takes no argument and can
only ever be called once.

---

## 3. Verify on-chain (30 seconds)

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 65645 --rpc-url coston2
# -> must equal your new KeylessAccounts

cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getActiveTeeMachines(uint256)(address[])" 65645 --rpc-url coston2
# -> must be non-empty (the same machine as before; it did not need re-registering)
```

---

## 4. Point the app at the new addresses

Edit `frontend/lib/keyless.ts`:

- `ADDRESSES.accounts` → new KeylessAccounts (step 1)
- `RULES.exchange / rateLimit / scheduled / escrow / fxrp` → the new rule addresses
  (`escrow` is the key for **ConditionalRule**)

> The legacy `ADDRESSES.policy` can stay — the landing page's "refuse" demo still runs against it.

---

## 5. Wire the app env

Create `frontend/.env.local` (never commit it):

```dotenv
# Gas sponsor for users' browser control keys (testnet only, keep it a burner)
FAUCET_KEY=0x<funded-coston2-key>

# The relayer that records XRPL addresses on-chain
ENCLAVE_URL=https://<your-enclave-host>
ENCLAVE_REPORTER_KEY=0x<reporter-private-key>   # MUST match ENCLAVE_REPORTER from step 1
```

Restart `npm run dev` (or redeploy the frontend) so the routes pick them up. Without these, the app
still runs — it just shows the funding fallback and "provisioning…" states.

---

## 6. Smoke test (the whole loop, once)

1. Open `/app` → **Create my Keyless wallet** (control key is generated in-browser).
2. **+ New account** → name it → pick **Exchange-only** → **Create account**. Watch: it funds your
   control key, `createWallet` fires INIT, `setRule` attaches the rule, and within a few seconds the
   dashboard shows a real **XRPL deposit address** (provisioned by the relayer).
3. **Fund it:** send test XRP to that address (XRPL Testnet faucet, or any testnet account). Balance
   appears on the dashboard.
4. **Allow a recipient** you control, then **Spend** to it → succeeds; the enclave signs and the payment
   shows on the ledger.
5. **The money shot:** try to **Spend to a different (non-allowlisted) address** → **"Refused: recipient
   not allowed"**, and nothing leaves. That's the demo.

---

## Notes / rollback

- **No enclave change, no re-attestation.** The machine attested a code hash we didn't touch; it keeps
  serving extension 65645 across the rebind.
- **`reportXrplAddress` is idempotent** — the relayer can be called repeatedly; the first address for a
  wallet wins and can't be repointed.
- **Rollback** is one command: re-run `BindPolicy` with `KEYLESS_ACCOUNTS` set back to the old
  `0x0020014c038610E8062A6F4BFF62ea1f08dC01A7`. Nothing is destroyed; binding is just a pointer.
- **Fund the reporter and faucet keys** before the smoke test, or provisioning and gas-sponsorship will
  silently no-op (you'll see "provisioning…" hang and the funding fallback).
