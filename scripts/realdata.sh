#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
years=(2026 2027)
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != '--year' ] || { [ "$2" != '2025' ] && [ "$2" != '2026' ] && [ "$2" != '2027' ]; }; then
    echo 'Usage: scripts/realdata.sh [--year 2025|2026|2027]' >&2
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
# SADP filed rates: independent raw-CSV oracle for every publication-listed state, with
# three controls per state; TX PY2026 adds the county HTTP examples (P5e).
for year in "${years[@]}"; do
  node scripts/oracle/dental.mjs --all-states --year "$year"
done
echo 'PASS'
# CSR variant evidence: independent raw Plan Attributes/Benefits/Rate oracle for every
# publication-listed state, with two controls per state.
for year in "${years[@]}"; do
  node scripts/oracle/csr.mjs --all-states --year "$year"
done
echo 'PASS'
# Medicare (CMS Landscape, PBP, contract service areas): every county listing and plan service
# area against an independent raw-file reading, with planted mutants. Skips when not cached.
for year in "${years[@]}"; do
  node scripts/oracle/medicare.mjs --year "$year"
done
# Medicare Part D public use files: every imported row group, each plan's formulary and a sample
# of drug lookups against an independent raw-file reading, with planted mutants. Skips when not
# cached.
for year in "${years[@]}"; do
  node --max-old-space-size=8192 scripts/oracle/medicare-part-d.mjs --year "$year"
done
# CMS SBE: independent CSV/Decimal counts, exact filed rates and households.
for year in "${years[@]}"; do
  node scripts/oracle/sbe.mjs --year "$year"
done
echo 'PASS'
