#!/bin/sh
# Renders the tee-proxy config.toml from Railway env vars, then runs the proxy.
#
# The proxy reads /app/config/config.toml. On Railway there are no mounted files,
# so template it from env: MySQL (Railway MySQL plugin), Redis (Railway Redis
# plugin), and the Coston2 system-contract addresses (verified against the Flare
# contract registry). The proxy signs with PROXY_PRIVATE_KEY.
set -e

DB_HOST="${DB_HOST:-${MYSQLHOST:?set MYSQLHOST or DB_HOST}}"
DB_PORT="${DB_PORT:-${MYSQLPORT:-3306}}"
DB_NAME="${DB_NAME:-${MYSQLDATABASE:-railway}}"
DB_USER="${DB_USER:-${MYSQLUSER:-root}}"
DB_PASSWORD="${DB_PASSWORD:-${MYSQLPASSWORD:?set MYSQLPASSWORD or DB_PASSWORD}}"
REDIS_HOST="${REDIS_HOST:-${REDISHOST:?set REDISHOST or REDIS_HOST}}"
REDIS_PORT="${REDIS_PORT:-${REDISPORT:-6379}}"
: "${PROXY_PRIVATE_KEY:?set PROXY_PRIVATE_KEY (funded Coston2 key, hex no 0x)}"

mkdir -p /app/config
cat > /app/config/config.toml <<EOF
redis_port = "${REDIS_HOST}:${REDIS_PORT}"
private_key_variable = "PROXY_PRIVATE_KEY"
initial_signing_policy_offset = 2
signing_policy_fetch_interval = "20s"

chain_id = 114

[db]
host = "${DB_HOST}"
port = ${DB_PORT}
database = "${DB_NAME}"
username = "${DB_USER}"
password = "${DB_PASSWORD}"
log_queries = false

[addresses]
flare_systems_manager = "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52"
relay = "0xa10B672D1c62e5457b17af63d4302add6A99d7dE"
voter_registry = "0x6a0AF07b7972177B176d3D422555cbc98DfDe914"

[ports]
internal = "6663"
external = "6664"

[info_timing]
cycle_internal = "10s"
cycle_queue_response_wait = "2s"

[voting]
proposal_expiration = "12s"
max_pending_request = 10000
EOF

echo "[start] rendered proxy config (db=${DB_HOST}:${DB_PORT}/${DB_NAME}, redis=${REDIS_HOST}:${REDIS_PORT})"
exec /app/main
