# Cache-only public-data checks

Run `scripts/realdata.sh` after acquiring the public source files into
`OPENPLANS_DATA_DIR` (default `$HOME/.local/share/openplans`). Node.js 22+,
Python 3 and the pinned development dependencies are required. These checks do not download files,
start Docker containers or request external health-plan APIs.
Missing required cached files fail; an old report cannot substitute for evidence.

Both PY2026 and PY2027 run by default. Select one with `--year 2026` or
`--year 2027`. The checks compare each supported state's imported catalog with
independently parsed CMS raw CSV counts, plan sets and filed premiums. Rates are
checked in integer cents; unknown or unsupported methods stay explicit. Each
state/year has a resumable developer database and reports under `reports/` in
the external cache. Production migrations are unchanged; only PostGIS is omitted
in disposable PGlite migration copies.

The TX PY2026 dental check also compares filed family and age-based
premiums against raw CMS CSVs and requires its temporary mutant to fail.
`year-over-year.py` compares the two cached Texas catalogs using raw CMS files;
its premium changes are cross-sectional medians, not renewal quotes.

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

A source checkout may also contain optional local reference comparisons. Those
comparisons and their archive-dependent tests are omitted from public exports.
Public CI and the public raw-file checks require neither reference captures nor
an owner-supplied database archive. Offline checker tests live in `tests/oracle/`.
