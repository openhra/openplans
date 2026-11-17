#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${OPENPLANS_DATA_DIR:?Set OPENPLANS_DATA_DIR to the external data cache}"
data=$OPENPLANS_DATA_DIR
run_timing=1
if [ "${1:-}" = '--skip-timing' ]; then
  run_timing=0
  shift
fi
[ "$#" -eq 0 ] || { echo 'Usage: scripts/realdata.sh --tpa-postgres [--skip-timing]' >&2; exit 2; }
context=${OPENPLANS_TPA_DOCKER_CONTEXT:-colima-openplans-lanes}
image=$(sed -nE '/^sha256:[0-9a-f]{64}$/p' ../tools/gate/postgis-image.txt)
[ -n "$image" ] || { echo 'missing pinned Postgres image' >&2; exit 1; }
name="openplans-tpa-postgres-$$"
db="openplans_tpa1_tpa2pg"
password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
dk() { docker --context "$context" "$@"; }
cleanup() { dk rm --force --volumes "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
dk run --detach --name "$name" -e POSTGRES_PASSWORD="$password" -e POSTGRES_USER=openplans -e POSTGRES_DB="$db" -p 127.0.0.1::5432 "$image" -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0 >/dev/null
for attempt in $(seq 1 60); do
  if dk exec "$name" pg_isready -U openplans -d "$db" >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(dk port "$name" 5432/tcp | sed 's/127.0.0.1://')
case "$port" in ''|*[!0-9]*) echo 'no loopback Postgres port' >&2; exit 1;; esac
export OPENPLANS_DATA_DIR="$data"
export DATABASE_URL="postgresql://openplans:${password}@127.0.0.1:${port}/${db}"
if [ "$run_timing" = 1 ]; then
  node scripts/census-realdata.mjs --timing
else
  node scripts/census-realdata.mjs
fi
node scripts/tpa-postgres-receipts.mjs
dk logs "$name" > "$data/work/tpa2pg/postgres.log" 2>&1
python3 scripts/tpa-postgres-privacy.py \
  "$data/work/tpa2pg/postgres.log" \
  "$data/work/tpa2pg/batch-privacy.json" \
  "$data/work/tpa2pg/receipts.json" \
  "$data/work/tpa1/realdata.json"
echo 'PASS TPA Postgres batch, receipts, replay controls, and privacy scan'
