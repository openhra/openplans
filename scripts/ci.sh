#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

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
npm run format:check
npm run lint
npm run check:lint-setup
npm run typecheck
node scripts/check-neutral.mjs
node scripts/check-publisher-review.mjs
npm run check:extraction
npm run build
npm test
echo 'PASS'
