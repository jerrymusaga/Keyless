# Deploying the Keyless TEE stack on Railway

**Why:** the pipeline works end to end locally (real XRP moves under policy), but the
enclave runs on a laptop behind an ephemeral ngrok URL — so the public frontend only
works while that machine is awake. Railway gives an **always-on host + a stable
`*.railway.app` URL** you set once in the frontend's `ENCLAVE_URL`, so anyone can
create an account and move XRP without the operator babysitting a laptop.

**What persists (do NOT re-create):** on the current baseline, extension **65645**,
`KeylessAccounts 0x57eb332D7000752ee82a35cc1A75941F0a619979`, and the rule modules are
on-chain, with KeylessAccounts as the extension's sole `instructionsSender`. A fresh
`extension-tee` mints a **new** TEE machine (re-register) and a **new** XRPL key per
wallet (re-INIT + re-fund) — but 65645, KeylessAccounts, and the rules are reused as-is.

> **Baseline:** tee-node **v0.0.21** / tee-proxy **v0.0.18**, TEE governance model.
> Still `MODE=1` **simulated** attestation (`TEST_PLATFORM`, code hash `0x194844cf…`) —
> not hardware attestation. Say so: "simulated on testnet, real Flare TEE for mainnet."

---

## 0. Prerequisites

- A Railway account + a new empty project. **Pick a region near Flare's RPC** (EU West).
- This repo pushed to your GitHub (Railway deploys from it). Service source dirs are
  under `enclave/deploy/railway/` and `enclave/`.
- A funded Coston2 key (the deployer that owns 65645 is simplest — `0xc760AB37…`).
- The **hosted Coston2 indexer creds** (host/user/password) — in your local
  `config/proxy/extension_proxy.coston2.docker.toml` or the hackathon channel's pinned
  message. **Verify Railway can reach that host first** (§1) before wiring everything.

---

## 1. Recommended: use Flare's hosted indexer (3 services, not 4)

The proxy needs a synced Coston2 C-chain indexer. Rather than self-host one (MySQL +
`cchain-indexer`), point it at **Flare's hosted indexer** — fewer services, more
reliable. So the stack is just **Redis + ext-proxy + extension-tee**.

1. **+ New → Database → Redis.** Name it `Redis`.
2. **Reachability check:** from any Railway shell (or trust the local proxy, which
   already uses it), confirm the hosted indexer host is reachable on `:3306`. If it's
   IP-gated and Railway can't reach it, fall back to the self-hosted indexer in the
   Appendix.

---

## 2. Deploy the proxy service

1. **+ New → GitHub Repo →** your repo. Name it **`ext-proxy`**.
2. Settings → **Root Directory:** `enclave/deploy/railway/proxy`.
3. Settings → **Networking → Generate Domain**, set the **target port to `6664`**
   (the external port the FDC availability check must reach).
4. Variables (the proxy's `start.sh` accepts `DB_*` overrides, so point them at the
   hosted indexer; `initial_signing_policy_offset` is already `2` in `start.sh`):
   ```
   PROXY_PRIVATE_KEY = <your funded Coston2 key, hex, NO 0x prefix>
   DB_HOST     = <hosted indexer host>
   DB_PORT     = 3306
   DB_NAME     = indexer
   DB_USER     = <hosted indexer user>
   DB_PASSWORD = <hosted indexer password>
   REDISHOST = ${{Redis.REDISHOST}}
   REDISPORT = ${{Redis.REDISPORT}}
   ```
5. Deploy. Logs should show `Database in sync` → `serving external at :6664`. A panic on
   `Database out of sync` means the indexer host is unreachable or lagging — recheck §1.

---

## 3. Deploy the enclave (extension-tee)

1. **+ New → GitHub Repo →** same repo. Name it **`extension-tee`**.
2. Settings → **Root Directory:** `enclave` (uses the existing `enclave/Dockerfile`).
3. Variables (⚠️ note the new-baseline additions: extension **65645** and the
   **governance** vars — the v0.0.21 node reverts registration without them):
   ```
   MODE             = 1                                   # simulated attestation
   EXTENSION_ID     = 0x000000000000000000000000000000000000000000000000000000000001006d
   INITIAL_OWNER    = 0xc760AB37E00082202e1659C256E01372f1739886
   CHAIN_ID         = 114
   GOVERNANCE_SIGNERS   = 0xc760AB37E00082202e1659C256E01372f1739886
   GOVERNANCE_THRESHOLD = 1
   CHAIN_URL        = https://coston2-api.flare.network/ext/C/rpc
   XRPL_RPC_URL     = https://s.altnet.rippletest.net:51234/
   PROXY_URL        = http://ext-proxy.railway.internal:6663
   CONFIG_PORT      = 5501
   SIGN_PORT        = 7701
   EXTENSION_PORT   = 7702
   SOURCE_DATE_EPOCH = 1784083533
   ```
   > `PROXY_URL` uses Railway's private network. `GOVERNANCE_SIGNERS`/`_THRESHOLD` must
   > match what `set-governance` registers on-chain (§4) — both default to the deployer.
4. Deploy. Logs should show `sign extension TEE running` with **no** `invalid extension
   ID` error (that means `EXTENSION_ID` isn't the 0x+64hex form above).

---

## 4. Register the machine (run against the Railway proxy URL)

Once both services are green, grab the **public proxy URL** (step 2's domain) and run
the go-live from anywhere (these are on-chain txs + calls to the public proxy):

```bash
cd enclave
EXT_PROXY_URL=<railway proxy url> bash ./scripts/post-build.sh
# = allow-tee-version (bytes32) → set-governance → register-tee -command rRap
```

This mints the new machine and promotes it to production on 65645. Then `createWallet`
routes INIT to it and generates the wallet's XRPL key. (Hand me the proxy URL and I can
drive this.)

---

## 5. Point the frontend at it (Vercel)

Set on the Vercel project:
```
ENCLAVE_URL          = <railway proxy url>     # the /api/provision relayer reads /state here
ENCLAVE_REPORTER_KEY = <deployer key, 0x…>     # writes reportXrplAddress on-chain
```
Now create/pay works from the public site. The read-only `/see` showcase keeps working
regardless (pure chain reads, no enclave dependency).

---

## Notes / gotchas

- **Version lockstep:** the proxy builds `tee-proxy v0.0.18`, whose go.mod pulls the
  matching `tee-node v0.0.21` — the same the enclave uses. Don't bump one side alone
  (the `TeeInfoResponse` encoding differs across versions and the proxy panics).
- **In-memory key:** the enclave holds each wallet's XRPL key in RAM. A redeploy/restart
  of `extension-tee` mints new keys (new r-addresses) → re-INIT + re-fund. Don't
  redeploy it mid-demo.
- **Simulated:** `MODE=1`, not hardware attestation. Be honest about it.
- **Costs:** the services are tiny; Railway's starter tier is plenty for a demo.

---

## Appendix: self-hosted indexer (fallback, only if the hosted one is unreachable)

If Railway can't reach Flare's hosted indexer, run your own:

1. **+ New → Database → MySQL.** Name it `MySQL`.
2. **+ New → GitHub Repo →** name it **`cchain-indexer`**, Root Directory
   `enclave/deploy/railway/indexer`. Variables:
   ```
   NODE_URL   = https://coston2-api.flare.network/ext/C/rpc
   LOG_RANGE  = 30
   MYSQLHOST     = ${{MySQL.MYSQLHOST}}
   MYSQLPORT     = ${{MySQL.MYSQLPORT}}
   MYSQLUSER     = ${{MySQL.MYSQLUSER}}
   MYSQLPASSWORD = ${{MySQL.MYSQLPASSWORD}}
   MYSQLDATABASE = ${{MySQL.MYSQLDATABASE}}
   ```
   > If backfill is slow, use an archive node (e.g.
   > `http://coston2.test.aflabs.net:9650/ext/bc/C/rpc`) with `LOG_RANGE = 1000`.
3. Point the proxy's `DB_*` (§2) at `${{MySQL.*}}` instead of the hosted indexer.
4. The move hinges on the indexer sustaining **< 60 s** behind head: the proxy logs
   `Database in sync` (good) vs repeated `Database out of sync` (region too far — try
   another Railway region).
