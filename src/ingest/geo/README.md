# Geography ingestion

Production: build, then `npm run worker -- ingest geo --state TX` with `DATABASE_URL` configured.
The command runs migrations before importing. State imports support Census state identifiers; the default plan year is 2026.

Without Docker, install dev dependencies and run:

```sh
npm run build
npm run worker:geo:pglite -- --state TX
```

This dispatches the same worker command using a persistent PGlite database in
`$OPENPLANS_DATA_DIR/geo-pglite`. Downloads and the report
`reports/p1b-geo-realdata.json` also stay in that external cache. The developer runner omits
only the PostGIS migration; the geography tables use portable SQL. Production migrations
always require PostGIS. Reports use public Census and CMS evidence only.

## Sources and interpretation

- [2020 Census ZCTA/county relationship file](https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt):
  preserved land/water measurements for the ZCTA, county and intersection, in square metres.
  The importer selects ZCTAs touching Texas, then preserves **all** their county intersections,
  including intersections outside Texas. Rows with blank ZCTA describe unassigned land and do
  not become ZIPs. It expects all 254 Texas counties.
- [2021 Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_zcta_national.zip):
  this publication explicitly uses [2020 Census tabulation blocks](https://www.census.gov/geographies/reference-files/2021/geo/gazetter-file.html).
  The earlier 2020 Gazetteer lacks 65 Texas-touching ZCTAs in the 2020 relationship file.
  Missing internal points fail the import. Gazetteer coordinates are representative internal
  points, stored in `zcta_centroid`; they are not geometric centroids or address coordinates.
- [CMS Texas geographic rating areas](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/tx-gra):
  county names join exactly to Census county names to obtain five-digit FIPS strings. The table
  has no plan-year version. We associate the observed current table with the requested year
  (2026 by default) and retain the snapshot; `ratingAreaBasis: current_cms_table` explicitly
  records this limitation. Harris County maps to Rating Area 10.

`acquireGeo()` uses `fetchToCache()` and the newest matching cached snapshot, verified by
SHA-256. Use `acquireGeo({ refresh: true })` to explicitly check for publisher updates. Raw
snapshots are immutable. Changed snapshots get new identities. Parsing and activation occur
in a transaction, so failed input preserves the previous `geo_import` pointer and rows.

`createGeoRepository(db).zipToCounties('75034')` returns all counties, exact published area
integers as strings, derived decimal land shares, source row numbers and snapshot IDs.
`zcta_land_share = AREALAND_PART / AREALAND_ZCTA5_20`; `county_land_share` uses county land
area as denominator. Zero denominators produce null. These are area shares, not population
or address shares. Unknown ZIPs return `status: unknown` and an empty county list.

ZIP postal delivery codes and Census ZCTAs do not coincide perfectly. In the current local
captured reference response, Harris ZIP 77001 has no 2020 ZCTA; the resolver now uses the explicitly labelled postal fallbacks below instead of inferring a
county from the capture.
Service Area PUF statewide flags and partial-county ZIP restrictions (plan defects D3/D4)
belong in the PUF importer; county geography alone does not establish plan availability.

## Offline fixtures and checks

`npm run fixtures:geo` regenerates the real TX source cuts from cached snapshots, with no
network. Its generator and manifest live in `tests/fixtures/geo/`. The manifest records source
URLs, full-source hashes and cut hashes. All files are under 200 KB. Fixture source rows refer
to physical rows in each source cut; full imports refer to physical rows in the original file.
CMS `source_row` is the 1-based HTML table-row ordinal (including its header).

The importer verifies file hashes, five-digit FIPS, required columns, area constraints,
Gazetteer coverage and complete one-to-one CMS coverage for all 254 counties. Offline tests
use PGlite. Mutants cover short FIPS, malformed/oversized CSV, broken CMS tables, missing
counties, damaged hashes and atomic rollback. CSV tests also prove consumer backpressure.

## Multiple states and years

`ingestGeo(db, {state, planYear})` supports Census state identifiers and fetches that
state's CMS GRA page through the safe hash-verifying cache. CMS's current undated
table is explicitly labelled `current_cms_table` for both years. The first table
is the individual-market division when CMS publishes separate market tables.
Two- and three-column county tables are accepted; county/parish name punctuation
is normalized while ambiguous and missing counties fail closed.

Alaska's CMS table uses ZIP3 divisions. These are retained in `rating_area_zip`
(migration 500), never guessed as county areas. `ratingAreaForLocation` resolves
county or ZIP3 evidence; without a ZIP an Alaska rating area stays unknown.
National Census snapshots accumulate rows without deleting previously imported
states. A failed state transaction preserves its prior geography pointer.

The developer CLI supports all states now:
`npm run worker:geo:pglite -- --year 2027 --all-states`, or `--state AL`.
`src/ingest/geo/command.ts` provides `runGeo` for production worker integration.
The production worker delegates the geo branch to `runGeo`; the API premium resolver uses
`ratingAreaForLocation` for ZIP3 states.

Eight literal CMS spelling errors are normalized using a state-scoped allowlist,
cross-checked against the same state's Census names: IN Kosclusko/Deleware/Davless/
Dubols, KS Chautaugua, LA Vermillion Parish, ND Trail, OH Galia. These preserve the
CMS snapshot/row and report each correction; no fuzzy county matching or boundary
crosswalk is performed. Every target must exist uniquely in Census and the CMS
table must still account for every Census county. Unknown names fail closed.

## Postal ZIP fallbacks (P2f)

ZIP county resolution uses the following order, shared by native ZIP queries, plan/premium
location resolution, and the compatibility API:

1. Loaded Census ZCTA/county intersections. A match returns immediately: neither fallback
   table nor CMS is consulted. All published county intersections remain available.
2. An exact, user-requested ZIP lookup in the CMS Marketplace API, only with `CMS_API_KEY`
   configured. A fresh cache answer takes precedence over GeoNames. There is no CMS bulk
   import, range enumeration, or background refresh. Facade three/four-digit prefix searches
   and the optional offline capture oracle use only bulk data and fresh existing CMS cache.
3. The operator's active GeoNames US postal snapshot.
4. `status: unknown`, `source: null`, and no counties. City names and nearby ZIPs never supply
   county evidence.

Available native answers name `source: zcta | cms_marketplace | geonames`, both at the ZIP
and county level. Fallback geography is `postal_zip`; area measurements and land shares
are null because these sources do not publish ZCTA intersection areas. Each county links to
its snapshot and physical source row (CMS: 1-based `counties` array position). Plan location
responses preserve these county records. Premium requests use the same resolver, retaining
the separate service-area/partial-ZIP and rating-area checks. County evidence alone does not
prove a plan is offered. The facade adds `source` on each `zip_counties` relationship, an
additive field permitted by the captured object shapes; GeoNames relationships also carry
attribution. Existing identity/reference fields keep their types. Unknown facade results keep
their empty wire shape, with both the current geography gap and the legacy ZCTA gap alias.

### GeoNames bulk import and attribution

Run `npm run worker -- ingest geo --source geonames` after building (production database), or
`npm run worker:geo:pglite -- --source geonames` (persistent developer database). This is a
national source, so this branch accepts no state/year flags. It uses the honest fetcher,
reuses a hash-verified existing cache under `OPENPLANS_DATA_DIR/raw/geonames-us-postal/`, and
atomically selects a versioned snapshot only after parsing succeeds. A publisher update is
an explicit `acquireGeoNames({ refresh: true })` followed by import; raw snapshots are immutable.

[GeoNames US postal codes](https://download.geonames.org/export/zip/US.zip), published by
[GeoNames](https://www.geonames.org/), are licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
The [publisher's format/terms](https://download.geonames.org/export/zip/readme.txt) describe
state and county administrative codes. The importer combines the explicit US state FIPS
with the published three-digit county code; it does not join county or city names. Rows
without supported state/county identity are counted as skipped. County names remain as
published. Coordinates are ignored. GeoNames is approximate postal evidence, not a Census
boundary product. Attribution and licence links are retained in native/facade responses.

### CMS: live only, key handling and request budget

Verified against the public [CMS specification](https://developer.cms.gov/marketplace-api/api-spec)
and [overview](https://developer.cms.gov/marketplace-api/) on 2026-11-07:
`GET https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/{zipcode}` accepts the
`year` query parameter (defaults to the current year) and authenticates with the **`apikey`
query parameter**. The public spec does not define an API-key header. The adapter always
sends five digits and an explicit current UTC year, and validates returned ZIP/state/FIPS.
CMS describes this API for live front-end use rather than dataset extraction. Keep bulk
warehouse ingestion on public files. Keys rotate/expire on CMS's 60-day lifecycle; update
the environment and restart the service after rotation. The key is never put in DB URLs,
errors, reports or response fields. The honest cache redacts all query values in raw metadata;
DB snapshot/lookup provenance retains the exact ZIP path and year with the key parameter omitted.

The base Compose file does not pass the optional key to the API. For Compose deployments,
layer the supplied override (which also mounts the writable raw snapshot cache):

```sh
docker compose -p openplans-p2f -f compose.yml -f src/ingest/geo/compose.cms.yml up -d api
```

Set `CMS_API_KEY` in the operator environment or private `.env`; it must reach the API process.
The existing external `raw/` directory must be writable by the container's `node` user. Direct
Node deployments set `OPENPLANS_DATA_DIR` to that same writable external cache. Keep keys
out of command arguments, logs, committed files and publicly readable Compose output.

CMS's public overview does not specify a universal numeric quota. **Apply the allowance
issued with your key before enabling it.** The persistent `cms_zip_budget` row gives all API
replicas sharing this database a conservative default of one outbound request/minute and
100/day (UTC). Lower `max_daily_requests` or increase `min_interval_ms` with SQL to meet a
smaller assigned allowance, for example:

```sql
UPDATE cms_zip_budget SET min_interval_ms=120000, max_daily_requests=50 WHERE singleton;
```

Budget exhaustion falls through immediately; it never queues a sweep. The adapter makes one
attempt, caps decoded bytes at 256 KiB, and refuses redirects so a key cannot reach another
host. Successful answers are cached for 24 hours, empty results for one hour, other failures
for five minutes. HTTP 401/403/429 persist status and a controlled failure code in the cache and append-only
`cms_zip_attempt` audit table, then fall
through; they also open a database-wide circuit breaker for at least one hour or the longer
`Retry-After` supplied by CMS. Refresh happens only on the next exact live request. The
cache does not authorize CMS use if the operator removes the configured key.

### Reproduce the checks

After building, `node tests/fixtures/geo/regenerate-geonames.mjs` cuts the committed TSV
from the previously cached archive without network. Its manifest records full/cut hashes,
original row positions and attribution. `cms-77001.synthetic.json` is explicitly synthetic,
not evidence of a live CMS response. Offline tests cover successful caching, 401/403/429,
key redaction, rate budgets, missing/invalid evidence, prefix restrictions, native/facade
responses and an actual premium resolved from 77001 plus the real PUF source cuts.

`node tests/fixtures/geo/check-zcta-order.mjs` places GeoNames ahead of ZCTA in a temporary
copy and requires the no-fallback-read test to fail. It never changes real source files.

`node dist/ingest/geo/fallback-realdata.js` is the explicit real-data check, outside offline CI.
It imports the GeoNames snapshot through the worker command into a temporary PGlite
database under the external cache, verifies 77001/85001 and their absence from the national Census ZCTA file,
and compares 1,000 deterministic national ZCTAs with GeoNames. The main Census county has
the largest land intersection (ties by FIPS); the sample is ordered by a fixed SHA-256 seed.
Report: `$OPENPLANS_DATA_DIR/reports/p2f-zip-fallback.md`. The agreement rate is an estimate,
not an activation gate. Without a CMS key, live checks are listed as unrun. With a key, the
script tries only the two named target ZIPs, subject to the same persistent request budget;
a blocked second ZIP is reported for a later individual check, never bypassed or retried early.
