# Cache-only public-data checks

Run `scripts/realdata.sh` after acquiring the public source files into
`OPENPLANS_DATA_DIR` (default `$HOME/.local/share/openplans`). Node.js 22+,
Python 3 and the pinned development dependencies are required. These checks do not download files,
start Docker containers or request external health-plan APIs.
Missing required cached files fail; an old report cannot substitute for evidence.

Both PY2026 and PY2027 run by default. Select one with `--year 2025`,
`--year 2026` or `--year 2027`. PY2025 requires its own acquired PUF manifest, a reviewed
`data/rating-rules/2025.json`, and cached geography sources. Year selection does not
acquire them. The checks compare each supported state's imported catalog with
independently parsed CMS raw CSV counts, plan sets and filed premiums. Rates are
checked in integer cents; unknown or unsupported methods stay explicit. Each
state/year has a resumable developer database and reports under `reports/` in
the external cache. Production migrations are unchanged; only PostGIS is omitted
in disposable PGlite migration copies.

The dental check compares filed family and age-based premiums against raw CMS CSVs
for every publication-listed state and year. Run `dental.mjs --all-states --year 2026`, or
pass `--state XX` for one state. Each state must catch three planted defects, and TX PY2026
also checks county HTTP examples. `csr.mjs` takes the same options. It compares every
silver variant's accumulators and benefit rows and must catch two planted defects per
state. Each state gets its own developer database, copied from the all-states database
when one exists. Per-state reports and an `a6-{dental,csr}-all-states-<year>.json`
summary go under `reports/`.
`year-over-year.py` compares the two cached Texas catalogs using raw CMS files;
its premium changes are cross-sectional medians, not renewal quotes.

The lowest cost silver plan check has two parts. `ichra-reference.py` reads the plan for a
county, rating area, age and month from the raw Plan Attributes, Service Area and Rate CSVs.
It prices the plan on the filed premium and on its EHB portion, and the caller supplies the
county's rating area. The reading skips an `EHBPercentTotalPremium` with more than 15 decimal
places or outside 0 through 1. The EHB-portion answer is then `requires_premium_adjustments`
with reason `<plan>: ehb_allocation_unknown`, the same answer the application gives.
`allocatePremium` in `src/domain/subsidy/dental.ts` documents the limit. The gross answer
still stands.
`ichra-logic.mjs` compares those answers with the application's.
`tests/oracle/ichra.test.mjs` runs both offline on a synthetic catalog and must catch five
planted defects: one cent on a rate row, the second lowest plan in place of the lowest, the
two premium bases swapped, a case only one side answers, and a reading that accepts a
16-place EHB fraction. `scripts/realdata.sh` does not run this check yet.

Geocode bounds and disposable point controls are available in `geocode.mjs`;
`geocode-statewide-controls.mjs` exercises transaction and resume behavior with
Postgres. See the [geocode guide](../../src/ingest/geocode/README.md).

A public export also runs `raw-evidence.mjs` for the optional prepared Cigna TX
PY2026 drug/provider and TX geocode databases. It retains the sampled nullable
drug facts, full provider pair multiplicities, source SHA-256 checks and failing
PA/removed-edge/point controls. Missing optional databases print explicit SKIPs;
the check fails if present evidence disagrees with the public raw files. Use
`OPENPLANS_FORMULARY_DB`, `OPENPLANS_PROVIDER_DB` and `OPENPLANS_GEOCODE_DB` to
select prepared file databases. The defaults are `formulary-pglite-p2d`,
`provider-pglite-p3b` and `geocode-pglite-p3c` below the cache. These checks never
download or create missing databases. Results go to `reports/public-raw-evidence.json`.

Public CI and the public raw-file checks need no private data or database archive.
Offline checker tests live in `tests/oracle/`.

Source controls use `source-controls.mjs` and the shared syntax matcher in
`scripts/source-mutation.mjs`. Offline CI runs `tests/oracle/source-controls.test.mjs`
against current TypeScript and built JavaScript, with both quote styles and
different wrapping and trailing commas. A missing or duplicate target fails.
The registry covers dental family tiers, CSR income inference, the NY/VT federal
guard, filed family cells, Alaska FPL selection and ZCTA priority. CSR import
rebasing also uses parsed module specifiers. Dental requires 3/3 controls and CSR
requires 2/2.

The other controls select data rather than source text. SBE changes one parsed
rate expectation. NY/VT corpus checks select prepared JSON records, filed cells
and database rows; VT HIOS controls change disposable prepared records. Rate,
drug, provider and geocode oracles mutate parsed records or isolated database
rows. Publication-anchor checks use HTML fixtures and parsed discovery results.
These targets do not depend on TypeScript formatting.
