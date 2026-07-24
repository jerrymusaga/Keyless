#!/usr/bin/env bash
#
# reregister-railway.sh <railway-proxy-url>
#
# WHY YOU NEED THIS: the simulated enclave generates a NEW identity key every time it
# boots. So whenever Railway restarts the extension-tee service, the on-chain machine
# registration becomes an "orphan" — it points at an identity that no longer exists — and
# instructions routed to it go nowhere. (Wallets created before the restart are also gone;
# keys live in RAM. Nothing recovers those — this only fixes the routing.)
#
# This script makes the live enclave the ONLY machine again, in two steps:
#   1. register the enclave's CURRENT identity (allow-tee-version + set-governance are
#      idempotent and skip; register-tee registers + promotes the current machine);
#   2. pause every OTHER active machine on the extension (the orphans), so getRandomTeeIds
#      only ever hands out the live one.
#
# Run it from anywhere after a restart:  bash enclave/scripts/reregister-railway.sh <proxy-url>
# Requires: foundry (cast), the Go toolchain, and DEPLOYMENT_PRIVATE_KEY in enclave/.env.

set -uo pipefail

PROXY_URL="${1:?usage: reregister-railway.sh <railway-proxy-url>   e.g. https://keyless-production-f896.up.railway.app}"
ENCLAVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ENCLAVE_DIR"

# Load the deployer key etc. CHAIN=coston2 in .env confuses cast's --chain flag, so drop it.
set -a; [ -f .env ] && source .env; set +a
unset CHAIN
RPC="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
KEY="${DEPLOYMENT_PRIVATE_KEY:?set DEPLOYMENT_PRIVATE_KEY in enclave/.env}"
EXT_ID=65645
ADDR_FILE="config/coston2/deployed-addresses.json"
DIAMOND="$(grep -oE '"FlareTeeManager"[^0-9a-fA-Fx]*0x[0-9a-fA-F]{40}' "$ADDR_FILE" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
[ -n "$DIAMOND" ] || { echo "could not read FlareTeeManager from $ADDR_FILE"; exit 1; }

echo "== reregister-railway =="
echo "  proxy   : $PROXY_URL"
echo "  diamond : $DIAMOND"
echo "  ext     : $EXT_ID"
echo ""

# --- 1. register the CURRENT enclave identity -------------------------------------------
echo "== 1/2 registering the live enclave identity (post-build) =="
# post-build.sh sources .env, so point EXT_PROXY_URL at the given proxy there first.
if grep -q '^EXT_PROXY_URL=' .env 2>/dev/null; then
  sed -i.bak "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$PROXY_URL|" .env && rm -f .env.bak
else
  echo "EXT_PROXY_URL=$PROXY_URL" >> .env
fi
POST_LOG="$(mktemp)"
bash ./scripts/post-build.sh 2>&1 | tee "$POST_LOG"
CURRENT="$(grep -oiE 'Registered TEE node with id 0x[0-9a-fA-F]{40}' "$POST_LOG" | grep -oiE '0x[0-9a-fA-F]{40}' | tail -1)"
if [ -z "$CURRENT" ]; then
  CURRENT="$(grep -oiE 'TEE ID:[[:space:]]*0x[0-9a-fA-F]{40}' "$POST_LOG" | grep -oiE '0x[0-9a-fA-F]{40}' | tail -1)"
fi
rm -f "$POST_LOG"
[ -n "$CURRENT" ] || { echo "could not determine the current TEE id from post-build output"; exit 1; }
echo ""
echo "  live machine = $CURRENT"

# --- 2. pause every OTHER active machine (the orphans) ----------------------------------
echo ""
echo "== 2/2 pausing orphaned machines =="
ACTIVE_LINE="$(cast call "$DIAMOND" "getActiveTeeMachines(uint256)(address[],string[])" "$EXT_ID" --rpc-url "$RPC" 2>/dev/null | head -1)"
MACHINES="$(printf '%s' "$ACTIVE_LINE" | tr -d '[] ' | tr ',' '\n')"
cur_lc="$(printf '%s' "$CURRENT" | tr 'A-F' 'a-f')"
paused=0
for m in $MACHINES; do
  [ -n "$m" ] || continue
  m_lc="$(printf '%s' "$m" | tr 'A-F' 'a-f')"
  if [ "$m_lc" != "$cur_lc" ]; then
    echo "  pausing orphan $m"
    cast send "$DIAMOND" "pause(address)" "$m" --private-key "$KEY" --rpc-url "$RPC" >/dev/null 2>&1 \
      && { echo "    paused"; paused=$((paused+1)); } || echo "    (pause failed — may already be paused)"
  fi
done
[ "$paused" -eq 0 ] && echo "  no orphans to pause."

echo ""
echo "== done. active machines on $EXT_ID now: =="
cast call "$DIAMOND" "getActiveTeeMachines(uint256)(address[])" "$EXT_ID" --rpc-url "$RPC" 2>/dev/null | head -1
echo "(should be exactly [$CURRENT])"
