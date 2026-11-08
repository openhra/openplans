#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Prime npm's cache once with `npm ci` before the first offline run.
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/vitest ]; then
  npm ci --offline --no-audit --no-fund
fi
npm run typecheck
node scripts/check-neutral.mjs
npm run check:extraction
npm run build
npm test
echo 'PASS'
