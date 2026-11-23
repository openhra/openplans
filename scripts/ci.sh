#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# OPENPLANS_CI_SHARD=<index>/<count> runs one slice of the test files (vitest --shard), for a CI
# job split across runners. Every slice builds; the static checks run in slice 1 only. Unset, the
# script runs everything.
#
# --hosted <runner> runs every step under that hosted runner's limits from
# .github/runner-limits.json: Node's heap capped at the runner's default (NODE_OPTIONS, set here
# and not by the caller, so a gate receipt's key does not change) and the test worker count the
# runner's CPUs give. It exits 2 before any step when this Node is not the pinned one, since
# another Node sizes its heap differently. A step that dies on the heap cap says so.
hosted=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hosted)
      [ "$#" -ge 2 ] || { echo "ci.sh: --hosted needs a runner (linux or macos)" >&2; exit 2; }
      hosted="$2"; shift 2 ;;
    *) echo "ci.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
cap="default"
if [ -n "$hosted" ]; then
  limits=$(node .github/runner-limits.mjs env "$hosted") || exit 2
  cap=$(printf '%s\n' "$limits" | sed -n 's/^cap_mb=//p')
  workers=$(printf '%s\n' "$limits" | sed -n 's/^workers=//p')
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$cap"
  export OPENPLANS_TEST_WORKERS="$workers"
  echo "== ci.sh --hosted $hosted: node $(node --version), heap cap $cap MB, $workers test worker(s)"
fi

# Runs one step, keeping its output to tell a heap exhaustion from any other failure.
step_log=$(mktemp "${TMPDIR:-/tmp}/openplans-ci-step.XXXXXX")
trap 'rm -f "$step_log"' EXIT
step() {
  local status=0
  "$@" 2>&1 | tee "$step_log" || status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    # 134 is the SIGABRT V8 raises after printing its out-of-memory message; requiring both keeps
    # a failure whose output merely quotes that message (this file, say) from being named one.
    if [ "$status" -eq 134 ] && grep -q -e 'Reached heap limit' -e 'JavaScript heap out of memory' "$step_log"; then
      echo "ci.sh: node heap exhausted (cap $cap MB) in: $*" >&2
    fi
    exit "$status"
  fi
}

shard="${OPENPLANS_CI_SHARD:-}"
static=true
if [ -n "$shard" ]; then
  if ! [[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] ||
    [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
    echo "ci.sh: OPENPLANS_CI_SHARD must be <index>/<count> with 1 <= index <= count, got '$shard'" >&2
    exit 2
  fi
  [ "${BASH_REMATCH[1]}" = 1 ] || static=false
fi

# Prime npm's cache once with `npm ci` before the first offline run.
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/vitest ]; then
  step npm ci --offline --no-audit --no-fund
fi
# All dependency setup after cache priming must stay offline.
export npm_config_offline=true
export npm_config_audit=false
export npm_config_fund=false
# Workspace dist/ folders are gitignored, and install builds only the SDK (its `prepare`). Build the
# SDK, every plugin and the app once, before anything else, so a stale or missing dist never breaks
# lint, typecheck or tests. Every shard builds.
step npm run build
if [ "$static" = true ]; then
  step npm run format:check
  step npm run lint
  step npm run check:lint-setup
  # --ignore-scripts skips the pretypecheck rebuild of the plugins; the build above made them.
  step npm run typecheck --ignore-scripts
  step node scripts/handy-docs.mjs --check
  step node scripts/compile-changes.mjs --check
  step node scripts/check-neutral.mjs
  step node scripts/check-currency.mjs
  step node scripts/check-publisher-review.mjs
  step npm run check:extraction
fi
if [ -n "$shard" ]; then
  step npm test -- --shard="$shard"
else
  step npm test
fi
echo 'PASS'
