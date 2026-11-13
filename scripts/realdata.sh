#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
years=(2026 2027)
price_check=
usage() {
  echo 'Usage: scripts/realdata.sh [--year 2025|2026|2027] [--with-price-check]' >&2
  exit 2
}
while [ "$#" -ne 0 ]; do
  if [ "$1" = '--with-price-check' ] && [ -z "$price_check" ]; then
    price_check=1
    shift
  elif [ "$#" -ge 2 ] && [ "$1" = '--year' ] && [ "${#years[@]}" -eq 2 ] && { [ "$2" = '2025' ] || [ "$2" = '2026' ] || [ "$2" = '2027' ]; }; then
    years=("$2")
    shift 2
  else
    usage
  fi
done
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
# Part D drug-cost estimates: the CMS worked examples end to end over HTTP and MCP, then every
# cached Part D plan through the estimate route with a provenance check, a sample through the MCP
# tool and planted mutants. Writes calculated and unknown counts by reason. Skips when not cached.
node node_modules/vitest/vitest.mjs run tests/ingest/medicare/medicare-cost-oracle.test.ts
for year in "${years[@]}"; do
  node --max-old-space-size=8192 scripts/oracle/medicare-cost.mjs --year "$year"
done
# Part D plan-average prices. The fixed 200-case sample is checked against an independent reading
# of the cached quarterly archive's pricing and pharmacy network files. This step is optional. It
# needs a database, named by OPENPLANS_PRICE_CHECK_DATABASE_URL, that holds that release with its
# pricing and dispensing-fee tables. Without the database or the archive it skips.
# --with-price-check first builds that database from the cache (build-price-check-db.sh, with
# OPENPLANS_PRICE_CHECK_DATABASE_URL or OPENPLANS_PRICE_CHECK_DOCKER_CONTEXT), and then the check
# must run: a missing archive fails instead of skipping.
if [[ " ${years[*]} " == *" 2026 "* ]]; then
  if [ -n "$price_check" ]; then
    price_url=$(scripts/oracle/build-price-check-db.sh build --year 2026)
    DATABASE_URL="$price_url" node scripts/oracle/medicare-part-d-price.mjs --year 2026 --cached
  else
    DATABASE_URL="${OPENPLANS_PRICE_CHECK_DATABASE_URL:-}" \
      node scripts/oracle/medicare-part-d-price.mjs --year 2026 --cached --optional
  fi
fi
# NY filed identities: cached DFS fields, regional LCSP and refusal controls.
if [[ " ${years[*]} " == *" 2026 "* ]]; then
  node src/ingest/state/ny-identitycheck.mjs
  node src/ingest/state/vt-metalcheck.mjs
fi
# CMS SBE: independent CSV/Decimal counts, exact filed rates and households.
for year in "${years[@]}"; do
  node scripts/oracle/sbe.mjs --year "$year"
done
# Public read routes and MCP tools. Every county of every loaded state and year, by county and by one ZIP,
# through the native routes, the compatibility search and the MCP tools, with a planted mutant.
# This step is optional. It needs a loaded database named by OPENPLANS_SURFACE_SWEEP_DATABASE_URL
# and skips without one.
sweep_years=()
for year in "${years[@]}"; do sweep_years+=(--year "$year"); done
DATABASE_URL="${OPENPLANS_SURFACE_SWEEP_DATABASE_URL:-}" \
  node scripts/oracle/surface-sweep.mjs "${sweep_years[@]}" --optional
echo 'PASS'
