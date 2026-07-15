# Deploying the Keyless TEE stack on Railway

**Why:** the pipeline works end to end (INIT already generated the enclave's XRPL key
live), but the final payment stalls because a laptop is ~500 ms from Flare's RPC, so
the local C-chain indexer can't stay within the 60 s freshness the proxy requires.
On a host near Flare's infra, RPC latency drops to tens of ms and the indexer keeps
pace — then one `policy.pay()` delivers and real XRP moves.

**What persists (do NOT re-create):** extension **454** and the policy
`0xBA56D8Ab673B276009EEdE5A19B2ddBb9839fAd2` are on-chain. The policy is already the
extension's sole `instructionsSender` and targets "whatever machine is active on 454."
A fresh `extension-tee` mints a **new** TEE machine (re-register) and a **new** XRPL
key (re-INIT + re-fund) — but 454 and the policy are reused as-is.

---

## 0. Prerequisites

- A Railway account + a new empty project. **Pick a region near Flare's RPC** (try
  **EU West** first; we'll confirm from the deployed indexer's lag).
- This repo pushed to your GitHub (Railway deploys from it). The three service source
  dirs are under `enclave/deploy/railway/` and `enclave/`.
- A funded Coston2 key (the same deployer that owns 454 is simplest —
  `0xc760AB37…`). You'll paste it into two service env vars.

---

## 1. Add the managed data services

In the Railway project:

1. **+ New → Database → MySQL.** Name it `MySQL`. (Gives `MYSQLHOST`, `MYSQLPORT`,
   `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`.) The indexer auto-migrates its own
   tables — no schema import needed.
2. **+ New → Database → Redis.** Name it `Redis`. (Gives `REDISHOST`, `REDISPORT`.)

---

## 2. Deploy the indexer service

1. **+ New → GitHub Repo →** your repo. Name the service **`cchain-indexer`**.
2. Settings → **Root Directory:** `enclave/deploy/railway/indexer` (it has the
   Dockerfile that clones + builds the Flare indexer with the env-templated config).
3. Variables (use Railway's `${{MySQL.*}}` references so they stay in sync):
   ```
   NODE_URL   = https://coston2-api.flare.network/ext/C/rpc
   LOG_RANGE  = 30            # public RPC caps getLogs at 30; low latency covers it
   MYSQLHOST     = ${{MySQL.MYSQLHOST}}
   MYSQLPORT     = ${{MySQL.MYSQLPORT}}
   MYSQLUSER     = ${{MySQL.MYSQLUSER}}
   MYSQLPASSWORD = ${{MySQL.MYSQLPASSWORD}}
   MYSQLDATABASE = ${{MySQL.MYSQLDATABASE}}
   ```
   > If backfill is slow, switch `NODE_URL` to an archive node that allows big
   > `eth_getLogs` (e.g. `http://coston2.test.aflabs.net:9650/ext/bc/C/rpc`) and set
   > `LOG_RANGE = 1000`.
4. Deploy. Logs should show `FSP startup backfill complete` then
   `Starting continuous indexing`. **This is the moment of truth** — see §6.

---

## 3. Deploy the proxy service

1. **+ New → GitHub Repo →** same repo. Name it **`ext-proxy`**.
2. Settings → **Root Directory:** `enclave/deploy/railway/proxy`.
3. Settings → **Networking → Generate Domain**, and set the **target port to `6664`**
   (the external port the FDC availability check must reach).
4. Variables:
   ```
   PROXY_PRIVATE_KEY = <your funded Coston2 key, hex, NO 0x prefix>
   MYSQLHOST     = ${{MySQL.MYSQLHOST}}
   MYSQLPORT     = ${{MySQL.MYSQLPORT}}
   MYSQLUSER     = ${{MySQL.MYSQLUSER}}
   MYSQLPASSWORD = ${{MySQL.MYSQLPASSWORD}}
   MYSQLDATABASE = ${{MySQL.MYSQLDATABASE}}
   REDISHOST = ${{Redis.REDISHOST}}
   REDISPORT = ${{Redis.REDISPORT}}
   ```
5. Deploy. Logs should show `Database in sync` → `serving external at :6664`
   → `creating round for …`. If it panics on `Database out of sync`, the indexer
   isn't caught up yet (§6) — redeploy the proxy once the indexer is synced.

---

## 4. Deploy the enclave (extension-tee)

1. **+ New → GitHub Repo →** same repo. Name it **`extension-tee`**.
2. Settings → **Root Directory:** `enclave` (uses the existing `enclave/Dockerfile`).
3. Variables:
   ```
   MODE           = 1                                   # simulated attestation (TEST_PLATFORM)
   EXTENSION_ID   = 0x00000000000000000000000000000000000000000000000000000000000001c6
   INITIAL_OWNER  = 0xc760AB37E00082202e1659C256E01372f1739886
   CHAIN_URL      = https://coston2-api.flare.network/ext/C/rpc
   XRPL_RPC_URL   = https://s.altnet.rippletest.net:51234/
   PROXY_URL      = http://ext-proxy.railway.internal:6663
   CONFIG_PORT    = 5501
   SIGN_PORT      = 7701
   EXTENSION_PORT = 7702
   SOURCE_DATE_EPOCH = 1784083533
   ```
   > `PROXY_URL` uses Railway's private network (`ext-proxy.railway.internal`). The
   > enclave is a client of the proxy — it needs no public domain of its own.
4. Deploy. Logs should show `sign extension TEE running` with **no**
   `invalid extension ID` error (that only happens if `EXTENSION_ID` isn't the 0x+64hex form above).

---

## 5. Hand back to me

Once all four services are green, send me:

- the **public proxy URL** (from step 3's generated domain), and
- confirmation the indexer logs show continuous indexing.

Then I run, from anywhere (these are on-chain txs + calls to the public proxy):
`register-tee` (new machine → PRODUCTION on 454) → `INIT` (new r-address) → fund it →
`policy.pay()` → **real XRP lands.** The latency that blocked us is now on Railway's
side of the network, so the instruction delivers.

---

## 6. Confirming the fix (the one number that matters)

The whole move hinges on the indexer sustaining **< 60 s** behind head. Check the
indexer service logs, or once the proxy is up its logs will say `Database in sync`
(good) vs repeated `Database out of sync. Delayed for …` (region too far — try a
different Railway region). Locally this drifted to minutes; on a well-placed host it
should sit in the low tens of seconds indefinitely, with no restarts.

## Notes / gotchas

- **Version lockstep:** the proxy pins `tee-proxy v0.0.17` + `tee-node v0.0.20`, matching
  the enclave's `tee-node`. Don't bump one side alone — the `TeeInfoResponse` encoding
  differs across versions and the proxy will panic on startup.
- **In-memory key:** the enclave holds the XRPL key in RAM. A redeploy/restart of
  `extension-tee` mints a new key (new r-address) → re-INIT + re-fund. Don't redeploy it
  mid-demo.
- **Costs:** all four services are tiny; Railway's starter tier is plenty for a demo.
