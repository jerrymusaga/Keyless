#!/bin/sh
# Renders the c-chain-indexer config.toml from Railway env vars, then runs it.
#
# Railway wires services through env vars, not mounted files — so we template the
# TOML at boot. MySQL vars come from the Railway MySQL plugin (MYSQL*); NODE_URL is
# the Coston2 RPC. FSP mode + history_epochs=0 keeps only the last ~15 min of
# signing-policy data, so the indexer stays light and (on a low-latency host) keeps
# pace with head — which is the whole reason we moved off the laptop.
set -e

: "${NODE_URL:?set NODE_URL to a Coston2 C-chain RPC}"
DB_HOST="${DB_HOST:-${MYSQLHOST:?set MYSQLHOST (Railway MySQL) or DB_HOST}}"
DB_PORT="${DB_PORT:-${MYSQLPORT:-3306}}"
DB_NAME="${DB_NAME:-${MYSQLDATABASE:-railway}}"
DB_USER="${DB_USER:-${MYSQLUSER:-root}}"
DB_PASSWORD="${DB_PASSWORD:-${MYSQLPASSWORD:?set MYSQLPASSWORD (Railway MySQL) or DB_PASSWORD}}"

cat > /app/config.toml <<EOF
[indexer]
mode = "fsp"
history_epochs = 0
rpc_concurrency = ${RPC_CONCURRENCY:-100}
batch_size = ${BATCH_SIZE:-1000}
# log_range must be <= the RPC's eth_getLogs cap. Flare's public RPC caps at 30;
# an archive node (e.g. coston2.test.aflabs.net) allows 1000 (faster backfill).
log_range = ${LOG_RANGE:-30}
new_block_check_millis = ${NEW_BLOCK_CHECK_MILLIS:-1000}
confirmations = 1
no_new_blocks_delay_warning = 120

[[indexer.collect_logs]]
contract_name = "FlareSystemsManager"
topic = "undefined"

[logger]
level = "INFO"
console = true

[chain]
node_url = "${NODE_URL}"
api_key = "${NODE_API_KEY:-}"
chain_type = 1

[db]
host = "${DB_HOST}"
port = ${DB_PORT}
database = "${DB_NAME}"
username = "${DB_USER}"
password = "${DB_PASSWORD}"
log_queries = false
drop_table_at_start = false
history_drop = 0

[timeout]
backoff_max_elapsed_time_seconds = 120
rpc_timeout_millis = 8000
EOF

echo "[start] rendered /app/config.toml (db=${DB_HOST}:${DB_PORT}/${DB_NAME}, node=${NODE_URL})"
exec /app/flare-cchain-indexer --config /app/config.toml
