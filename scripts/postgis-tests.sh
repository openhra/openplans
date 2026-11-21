#!/usr/bin/env bash
# Runs the test files that need PostGIS against a disposable PostGIS container, then removes it.
#
#   scripts/postgis-tests.sh --image IMAGE [--all] [--results ABSOLUTE_PATH] [-- TEST_FILE...]
# --all uses OPENPLANS_TEST_DB=postgres; paths after -- select files instead of the whole suite.
#
# IMAGE is a build of Dockerfile.db, named by tag or by image ID. The container gets a random
# localhost port and a random password, and each suite gets its own empty database. Docker must
# be available: without it the script fails instead of skipping.
# OPENPLANS_POSTGIS_CONTAINER names the container (default: openplans-postgis-tests-<pid>).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "postgis-tests: $1" >&2
  exit 1
}

image=""
all=false
results=""
selected_files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) all=true; shift ;;
    --) shift; [ $# -gt 0 ] || fail "-- needs at least one test file"; selected_files=("$@"); break ;;
    --results)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "--results needs a path"
      results="$2"; shift 2 ;;
    --image)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "--image needs a value"
      image="$2"
      shift 2
      ;;
    *) fail "usage: scripts/postgis-tests.sh --image IMAGE [--all] [--results PATH] [-- TEST_FILE...]" ;;
  esac
done
[ -n "$image" ] || fail "usage: scripts/postgis-tests.sh --image IMAGE [--all] [--results PATH] [-- TEST_FILE...]"

if [ "${#selected_files[@]}" -gt 0 ]; then
  $all || fail "test file selection requires --all"
  for file in "${selected_files[@]}"; do
    [[ "$file" != -* && "$file" == *.test.* && -f "$file" ]] || fail "expected an existing test file"
  done
fi

command -v docker >/dev/null 2>&1 || fail "docker is not installed; the PostGIS suites need it"
docker info >/dev/null 2>&1 || fail "docker is not running or not reachable; the PostGIS suites need it"
docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is not present; build Dockerfile.db first"

# Each environment variable names one suite's database. The test files read them.
databases=(
  P3D_POSTGIS_URL:p3d
  P3I_POSTGIS_URL:p3i
  P3J_POSTGIS_URL:p3j
  P6K_POSTGIS_URL:p6k
  P6K2_POSTGIS_URL:p6k2
  GEOCODE_POSTGIS_URL:geocode
  # These two suites check their database names before they write.
  GEOCODE_CLEANUP_POSTGIS_URL:openplans_p3m_controls_1
  GEOCODE_MULTISTATE_POSTGIS_URL:openplans_p3l_controls
  WORKER_CONCURRENCY_POSTGRES_URL:openplans_worker_concurrency
)
# The multistate suite opens one database per state beside the one its URL names.
extra_databases=(openplans_p3l_controls_fl openplans_p3l_controls_nc)
if $all; then extra_databases+=(openplans_nightly); fi
files=(
  tests/postgis-required.test.ts
  tests/api/providers.test.ts
  tests/api/providers-radius.test.ts
  tests/api/provider-search-keys-postgis.test.ts
  tests/api/provider-search-keys-paths-postgis.test.ts
  tests/api/providers-name.test.ts
  tests/api/providers-plan-radius.test.ts
  tests/compat/v1/provider-radius.test.ts
  tests/domain/geo/postgis.test.ts
  tests/ingest/geocode/cleanup.test.ts
  tests/ingest/geocode/multistate.test.ts
  tests/ingest/geocode/statewide.test.ts
  tests/db/compact.test.ts
  tests/db/geocode-match-archive.test.ts
  tests/db/restore-search-path.test.ts
  tests/db/maintenance-locks.test.ts
  tests/db/worker-concurrency-postgres.test.ts
)

focused_files=("${files[@]}")

if $all; then
  name="${OPENPLANS_POSTGIS_CONTAINER:-openplans-fa14-nightly-tests-$$}"
else
  name="${OPENPLANS_POSTGIS_CONTAINER:-openplans-postgis-tests-$$}"
fi
export OPENPLANS_POSTGIS_CONTAINER="$name"
password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
cleanup() {
  docker rm --force --volumes "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

started=$(date +%s)
docker run --detach --rm --name "$name" --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=openplans --env POSTGRES_PASSWORD="$password" --env POSTGRES_DB=openplans \
  --shm-size 256m "$image" >/dev/null || fail "could not start container $name from $image"

ready=false
for _ in $(seq 1 120); do
  # The entrypoint restarts the server once after initialising; wait for the final one.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U openplans -d openplans >/dev/null 2>&1 &&
    docker exec "$name" psql -X -h 127.0.0.1 -U openplans -d openplans -Atc 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "PostGIS in $name did not become ready within 120 seconds"
port="$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')"
[[ "$port" =~ ^[0-9]+$ ]] || fail "could not read the published port of $name"

for entry in "${databases[@]}"; do
  variable="${entry%%:*}"
  database="${entry#*:}"
  docker exec "$name" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U openplans -d openplans \
    -qc "CREATE DATABASE $database" || fail "could not create database $database"
  export "$variable=postgresql://openplans:$password@127.0.0.1:$port/$database"
done
for database in "${extra_databases[@]}"; do
  docker exec "$name" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U openplans -d openplans \
    -qc "CREATE DATABASE $database" || fail "could not create database $database"
done
export OPENPLANS_POSTGIS_REQUIRED=1
if $all; then
  export OPENPLANS_TEST_DB=postgres
  export OPENPLANS_POSTGRES_TEST_URL="postgresql://openplans:$password@127.0.0.1:$port/openplans_nightly"
  export READ_TIMEOUT_POSTGRES_URL="$OPENPLANS_POSTGRES_TEST_URL"
  files=("${selected_files[@]}")
fi
echo "postgis-tests: $name ready in $(($(date +%s) - started)) s on 127.0.0.1:$port"

report="$(mktemp -d)"
trap 'cleanup; rm -rf "$report"' EXIT INT TERM
# These suites share one database server and count server-wide advisory locks, so their files
# run one at a time.
# Preserve JSON on failure too, so the nightly report can name every divergence.
# Child-process concurrency tests import the compiled worker modules from this checkout.
npm run build
status=0
OPENPLANS_TEST_WORKERS=1 npx vitest run --reporter=default --reporter=json --outputFile.json="$report/results.json" ${files[@]+"${files[@]}"} || status=$?
if [ -n "$results" ] && [ -f "$report/results.json" ]; then cp "$report/results.json" "$results"; fi
[ "$status" -eq 0 ] || fail "vitest failed (exit $status)"
# Print each file's counts. Every test must run: a skipped test here means a suite fell back to
# PGlite or skipped its PostGIS checks.
node -e '
const results = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const all = process.argv[2] === "true";
const focused = new Set(process.argv.slice(3));
let skipped = 0;
for (const file of results.testResults) {
  const counts = {};
  for (const test of file.assertionResults) counts[test.status] = (counts[test.status] ?? 0) + 1;
  const name = file.name.slice(process.cwd().length + 1);
  if (!all || focused.has(name)) skipped += (counts.skipped ?? 0) + (counts.pending ?? 0) + (counts.todo ?? 0);
  console.log(`postgis-tests: ${name}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
}
console.log(`postgis-tests: ${results.numPassedTests} passed, ${results.numFailedTests} failed, ${skipped} skipped in ${results.numTotalTestSuites ? results.testResults.length : 0} files`);
if (skipped) { console.error("postgis-tests: tests were skipped; every required PostGIS test must run"); process.exit(1); }
' "$report/results.json" "$all" "${focused_files[@]}" || fail "skipped tests in the PostGIS run"
echo "postgis-tests: PASS in $(($(date +%s) - started)) s"
