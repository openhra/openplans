#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
years=(2026 2027)
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != '--year' ] || { [ "$2" != '2026' ] && [ "$2" != '2027' ]; }; then
    echo 'Usage: scripts/realdata.sh [--year 2026|2027]' >&2
    exit 2
  fi
  years=("$2")
fi
# Acquisition is intentionally separate. A populated cache suffices without network.
if [ ! -x node_modules/.bin/tsc ]; then
  npm ci --offline --no-audit --no-fund
fi
npm run build
# Optional local reference comparisons are not part of the public distribution.
if [ -f scripts/oracle/run.mjs ]; then
  for year in "${years[@]}"; do
    node scripts/oracle/run.mjs --year "$year"
  done
elif [[ " ${years[*]} " == *" 2026 "* ]]; then
  node scripts/oracle/raw-evidence.mjs
fi
# Every publication-listed individual medical state: independent raw counts/premiums and geography.
for year in "${years[@]}"; do
  node scripts/oracle/all-states.mjs --year "$year"
done
# SADP filed rates: TX PY2026 independent raw-CSV oracle (P5e), with its own mutant.
if [[ " ${years[*]} " == *" 2026 "* ]]; then
  node scripts/oracle/dental.mjs
fi
echo 'PASS'
# CSR variant evidence: TX PY2026 independent raw Plan Attributes/Benefits/Rate oracle.
if [[ " ${years[*]} " == *" 2026 "* ]]; then
  node scripts/oracle/csr.mjs
fi
echo 'PASS'
# CMS SBE: independent CSV/Decimal counts, exact filed rates and households.
for year in "${years[@]}"; do
  node scripts/oracle/sbe.mjs --year "$year"
done
echo 'PASS'
