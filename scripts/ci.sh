#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# OPENPLANS_CI_SHARD=<index>/<count> runs one slice of the test files (vitest --shard), for a CI
# job split across runners. Every slice builds; the static checks run in slice 1 only. Unset, the
# script runs everything.
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
  npm ci --offline --no-audit --no-fund
fi
# All dependency setup after cache priming must stay offline.
export npm_config_offline=true
export npm_config_audit=false
export npm_config_fund=false
# Workspace dist/ folders are gitignored, and install builds only the SDK (its `prepare`). Build the
# SDK and then every plugin so a stale or missing dist never breaks lint, typecheck or tests.
npm run build:plugins
if [ "$static" = true ]; then
  npm run format:check
  npm run lint
  npm run check:lint-setup
  npm run typecheck
  node scripts/check-neutral.mjs
  node scripts/check-publisher-review.mjs
  npm run check:extraction
fi
npm run build
if [ -n "$shard" ]; then
  npm test -- --shard="$shard"
else
  npm test
fi
echo 'PASS'
