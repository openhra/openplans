# Census batch geocoding and radius primitives

```sh
npm run build
node dist/worker/cli.js ingest geocode --state TX --county 48201
# Intersect with an optional comma-separated ZIP list:
node dist/worker/cli.js ingest geocode --zips 77002,77030
# Developer file database, reusing completed NPPES and geography caches:
node dist/ingest/geocode/pglite.js 48201
# Statewide bulk queue on an already populated Postgres/PostGIS database (DATABASE_URL required):
node dist/ingest/geocode/tx-cli.js --run-id tx-20261107 --budget-minutes 120
node dist/ingest/geocode/tx-cli.js --run-id tx-20261107 --report-only --http-check
```

The worker uses Postgres and its normal `DATABASE_URL`; geography and NPPES must already be
imported. With no filter, it selects in-scope TX NPPES practice locations and ACTIVE issuer provider locations. This lane's developer
runner is restricted to Harris County. Its fresh `geocode-pglite-p3c` database, immutable raw
responses, request CSVs and reports remain under `OPENPLANS_DATA_DIR` (the usual external
GameDev data cache by default). It reads the completed `nppes-pglite-p3a` and `geo-pglite`
caches to copy selected published rows. Do not run it while either source cache is importing,
or open another runner on the same file database. A rerun reuses completed address attempts.

`--county` selects ZIPs whose Census ZCTA intersects that county; a ZCTA can cross county lines.
This is a candidate selection, not an assertion that every selected address lies in the county.
ZIPs with no ZCTA relationship cannot be selected by this filter; use `--zips` to include them.
NPPES locations carry no network or plan-membership inference.

## Publisher contract

[Census API documentation](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html)
and the [May 2026 user guide](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_User_Guide.pdf)
describe CSV submission and the limit of 10,000 records per batch. We submit at most that many,
sequentially, pausing one second between batches. The reviewed documentation gives no numeric
request-frequency limit; this pause is our conservative choice. Existing fetch controls enforce
public DNS pinning, HTTPS, a fixed reviewed endpoint, no upload redirects, a 16 MiB response
limit, timeouts, three attempts, jitter and Retry-After (stop rather than retry prematurely when
the publisher delay exceeds the retry budget). HTTP success containing HTML is a failure, not
an unmatched response. Network failure never silently turns the batch into ZIP centroids.

Benchmark `4` is `Public_AR_Current`; it changes over time. The requested benchmark and request
hash are retained beside the raw response snapshot. Incremental reuse intentionally keeps the
previous observation; it does not claim a fresh benchmark lookup. A transport adapter is needed
because the shared fetcher supports GET only. It delegates caching, validation and retries to
`fetchToCache`, with POST limited to the exact Census batch endpoint.

Census matches are interpolations along TIGER street ranges, including the `Exact` match class;
they are not surveyed building coordinates. Preserve match indicator and quality exactly as
returned. Ties and No_Match rows use a published active ZCTA internal point when available,
with `method=zcta_centroid` and its own centroid snapshot. Without a ZCTA, retain a no-point
attempt and count it. Malformed, missing and duplicate response rows become quality issues;
valid sibling rows still commit. Invalid/missing rows are retriable issues, never exact points.

## Incremental identity and provenance

Identity is SHA-256 of the NFKC, uppercase, whitespace-normalized five-field address array
(line 1, line 2, city, state, ZIP5), plus source table and the NPI/kind/ordinal row key. Line 2
is retained, so suite changes are distinct evidence. No street abbreviation guessing occurs.
The attempt ledger records no-point outcomes as well as points. Identical source-row/address
text reuses the prior observation across NPPES refreshes and advances input snapshot provenance.
Changed text creates a new observation. Both Census response and input snapshots are stored;
centroid fallback adds the active centroid snapshot. Domain queries exclude historic points
whose input source snapshot no longer matches the current NPPES address.

`createGeoRepository(db)` exposes `zipCentroid(zip)` and `pointsWithinRadius(lat,lon,miles)`;
standalone helpers take `db` first. Unknown ZIP centroids return null. Radius results preserve
method, quality and snapshot identifiers so callers can display “approximate (ZIP centroid)”.
Production uses indexed geography `ST_DWithin` and spherical `ST_Distance` (`use_spheroid=false`);
PGlite uses haversine with the same WGS84 mean radius. Distances are statute miles (1609.344 m).
PostGIS/PGlite parity is tested with the recorded fixtures, including a corrupt-distance control.

## Validation and fixture regeneration

```sh
# Offline (included in the normal CI):
npx vitest run tests/ingest/geocode tests/domain/geo
# Re-record explicitly with network, retaining raw snapshots externally:
node tests/fixtures/geocode/regenerate.mjs --record
# Optional parity test against an EMPTY disposable PostGIS database:
GEOCODE_POSTGIS_URL=postgres://postgres@127.0.0.1:55463/postgres npx vitest run tests/domain/geo/postgis.test.ts
```

The fixture includes public building addresses and published NPPES practice locations. The PO
box and incomplete Main Street probes are explicitly test inputs; their recorded unmatched/tie
responses are genuine. Synthetic test identifiers and mutations are labelled in the harness.
The Gazetteer cut is regenerable and carries source SHA-256 and row numbers. The Houston City
Hall ↔ Texas Children's Hospital (TMC campus, 6621 Fannin) fixture distance is about four miles;
swapping latitude and longitude fails validation. Tests also cover malformed lines, no-ZCTA
PO-box ZIP 77001, fallback provenance, paging/pacing, ZIP/county selection, incremental reuse,
changed input snapshots, HTML failures, retry delay and raw-cache reuse.

## Migration ordering

Migration 360 deliberately does not reference `npi_address`, created by migration 400.
The migration runner on develop now applies pending migrations merged below existing history
in numeric order, while preserving hash checks on already applied migrations. This resolves the
initial 360/400 ordering issue. The developer runner uses its own file database and never edits
an existing migration journal or the source cache tables.

## Harris County real run — 2026-11-07

The fresh file database selected 145,584 practice locations from 131,716 providers through
143 ZCTAs intersecting 48201. It processed all locations in 628.398 seconds, using 15 successful
batch requests: 103,861 Exact, 29,312 Non_Exact, 323 Tie and 12,088 No_Match. The latter two
classes produced 12,411 centroid fallbacks; no-point and quality-issue counts were both zero.
All inputs in this county selection have a ZCTA; the no-ZCTA case is exercised offline and can
be selected explicitly by ZIP. An earlier 10,000-address submission attempt failed before committing points while the
multipart format was being corrected; an HTML rejection was reproduced during diagnosis.
Accounting for that initial attempt gives 16 HTTP requests and 155,584 submitted rows
(10,000 retried), with 145,584 distinct source rows processed.

Evidence: `OPENPLANS_DATA_DIR/reports/p3c-geocode-harris.json` and
`p3c-geocode-run.log`; the DB is `geocode-pglite-p3c`. Responses and input CSVs are under
`raw/census-geocoder-batch` and `raw/census-geocoder-requests`. PostGIS/PGlite fixture parity
passed against a disposable PostGIS 16 container, which was removed afterward.

A network-forbidden rerun reused all 145,584 observations in 16.738 seconds with zero requests
and zero submitted addresses. A real PGlite radius query within 4.1 miles of Houston City Hall
returned 27,168 source locations, including 513 explicitly marked centroid approximations.
Table counts reconciled exactly to the run report. Evidence is in
`OPENPLANS_DATA_DIR/reports/p3c-geocode-harris-reuse.json`.

## Issuer addresses (P3d)

The worker now selects both in-scope NPPES practice addresses and locations on ACTIVE issuer
provider records. `--source npi_address` or `--source qhp_provider_address` narrows the selection;
county/ZIP filters work for either source. Issuer ZIP+4 values are normalized to ZIP5 at this
boundary. Source identity is shard_snapshot:record_id:address_index for issuer addresses and NPI:kind:ordinal
for NPPES, with input snapshot also kept explicitly. Including the issuer shard snapshot keeps identical raw records in concurrent source sets independently located. Null-NPI issuer records remain geocodable.

Completed normalized hashes (including no-point results) are reused across publishers as well
as source refreshes. Duplicate hashes within a batch are submitted once and then attributed to
every source row. Input provenance advances independently; the original Census and centroid
snapshot dates are preserved. Address normalization retains suite text and does not guess street
abbreviation equivalences. The radius helper's optional fifth argument selects
`qhp_provider_address`; the original NPPES default is unchanged. Issuer radius results include
only addresses whose input snapshot belongs to the current ACTIVE source set.

## Statewide TX (P3e)

`tx-cli.js` stages all in-scope TX NPPES practice rows and the TX addresses of every ACTIVE
issuer shard captured when the run is created. It includes null-NPI issuer records and normalizes
ZIP+4 to ZIP5. Staging is paged, streaming and resumable. It scans one indexed issuer shard at a
time, avoiding repeated sorts over nationwide addresses. The five-field normalized address hash
is shared across sources; each distinct address is submitted once, then attributed to every
source row in the normal `geocode_attempt` and `address_point` tables. The API uses those tables
without a separate statewide route or database.

The run ID freezes the issuer shard selection. A newly activated issuer set requires a new run
ID, which reuses completed entries in the statewide result ledger and publishes their evidence
onto the new source rows. NPPES text is frozen as each staging page commits. Do not refresh NPPES
while a staging pass is in progress. Once both staging flags are true, its input census is fixed.
An advisory lock permits one statewide CLI writer per database. The bulk CLI applies only the
hash-checked migrations 520–521, 600, 870–872 and 900, so concurrent lanes' independent migration journals need not yet be
available in its checkout. Its staging tables deliberately avoid new foreign-key locks on live
ingest tables; the ordinary published attempt/point tables continue enforcing snapshot provenance.

The writer connection stays open while Census is processing a batch, so its lock cannot expire
through pool idle eviction. Its lock key is distinct from the geography import lock. Bulk CLI
queries disable parallel workers and JIT on that connection only, allowing large joins to work
with a stock Docker Postgres's small shared-memory allocation. API settings are not changed.
Geocoding refuses to start without an imported TX centroid snapshot; load geography first with
the normal geography importer. Staging can precede that import. If geography becomes available
later, rerunning attaches newly available, verified TX centroid fallbacks to existing Tie/No_Match
observations without another Census request. Their original Census provenance remains intact.

Each batch manifest (ordered hashes and exact CSV) commits **before** the network request. After
the hash-verified response passes structural parsing and each row is classified, the distinct results, all source
attributions, and the completion marker commit in **one transaction**. An interruption leaves
either the complete batch or its original pending manifest. Resume with the same run ID; both
completed batches and no-point observations are skipped. A response downloaded before a process
dies is reused from the request-hash cache. Malformed, duplicate, missing and unexpected response
rows fail the batch rather than becoming fabricated `No_Match` observations.

The run also records its Census response format. It can be chosen while staging, before the
first batch manifest, and is then immutable. A resume with a different format is rejected before
making a request. Existing pre-521 runs used geography responses; resume those with `--geographies`.

Requests default to Census `locations/addressbatch`, benchmark 4. The publisher limit remains
10,000, with sequential submissions, one-second pacing and the existing error backoff. Matched
coordinates are classified against independently acquired **2026 Census TIGERweb county polygons**
(all 254 counties, WGS84), then checked against that county's bounding rectangle. This avoids a
second publisher geography lookup for each point. Ohio, `(0,0)`, and a point outside every TX county
are rejected before publication without discarding valid sibling rows. `--geographies` selects `geographies/addressbatch` with vintage 4 instead;
its returned county FIPS is the claim checked against the independent bounds. A missing publisher
county is a structural failure that retains the pending batch. A coordinate outside that claimed county rejects only that row. Bounding rectangles alone do not prove
polygon membership of a publisher-provided county claim. The exact raw county geometry and its
SHA-256 are retained externally; results label `county_basis` and preserve the bounds snapshot.

Out-of-state or out-of-county Census matches are stored as `rejected_out_of_bounds`.
The original returned state, coordinates, county claim, quality and raw CSV line are retained in
`geocode_tx_result.rejection`; the immutable full response remains linked through `snapshot_id`.
Neither rejected coordinates nor their original match quality become a published Census point.
A returned address state that differs from the input state also rejects the row, even when its
coordinate lies in TX. Rejected rows use the same verified ZCTA fallback as Tie/No_Match, with
`method=zcta_centroid`, null match quality and separate centroid provenance. Without a usable
centroid they remain resolved no-point observations. A later geography import can add a fallback
without another Census request or changing the rejection evidence. The atomic batch commits
valid matches, rejections, fallbacks and all source attributions together.

Tie/No_Match statuses remain unchanged. When an active ZCTA internal point is available it is
published as `zcta_centroid`, with nullable match quality and the separate centroid snapshot.
Fallback county is determined by point-in-polygon against the retained Census county rings; it
does not claim to locate the original provider address. Without a usable centroid, the result
remains no-point. County scheduling and unresolved-address reporting use the greatest published
TX ZCTA overlap as a **candidate**, never as a confirmed address county. Known counties run
largest first; inputs without a county candidate run last.

Useful options: `--stage-only`, `--max-batches N`, `--budget-minutes N`, `--report-only`, and
`--http-check`, plus `--geographies` for publisher geography responses. The deadline and SIGINT/SIGTERM stop between atomic operations; an in-flight
request/transaction may finish first. Reports are written outside the repo:
`OPENPLANS_DATA_DIR/reports/p3h-geocode-finish.{md,json}`. They include distinct addresses, matched,
tie, no-match, rejected, fallback (a subset, never added to matched), no-point, pending, and bounding-box
results per county, plus source-row counts and frozen staging scope. `--http-check` starts a
temporary listener on `127.0.0.1` and checks real HTTP radius requests for Dallas 75201, Austin
78701 and El Paso 79901 against this database, then closes it.

```sh
# Offline tests (also run by scripts/ci.sh):
npx vitest run tests/ingest/geocode
# Regenerate the small bounds cut from the existing external raw snapshot:
node tests/fixtures/geocode/regenerate-statewide.mjs
# Explicitly record fresh Census geography replies for the public-address fixture:
node tests/fixtures/geocode/regenerate-statewide.mjs --record
# Real Postgres SIGKILL control: creates/drops its own disposable DB on DATABASE_URL's server.
# Uses recorded fixtures, makes zero network requests, and starts no containers:
node scripts/oracle/geocode-statewide-controls.mjs
```

The crash control kills a child **after SQL point/attempt writes and before COMMIT**, verifies
rollback and the surviving pending manifest, resumes the identical CSV, and reconciles all six
distinct results and three completed batches. Evidence goes to
`reports/p3e-negative-controls.{json,log}` (redirect stdout for the log). Offline tests additionally
mutate a real Houston Census response to Ohio, substitute a wrong TX county, truncate/duplicate
response rows, resume staged input pages, and verify cross-source deduplication and captured
ACTIVE source selection. Test identifiers and rectangular test rings are labelled synthetic;
the recorded bounds, public addresses and Census responses retain their source hashes.

## P3h row rejection controls

Offline tests submit a mixed batch with a synthetic Ohio mutation of a recorded Census match:
valid siblings publish, the rejected row retains its raw response and uses a labelled TX ZIP
centroid. A mutant that writes the Ohio coordinates to the actual published point table fails
the independent county-bounds/publication audit. Additional controls cover location-only replies,
a wrong claimed TX county, a mismatched returned state with an in-TX coordinate, rejection without
a usable centroid, and adding that centroid later without a request. Structural CSV failures and
missing geography claims still retain the exact pending batch. Prior P3e reports remain intact.


## FL and NC statewide runs

The same queue now supports `TX`, `FL` and `NC`. Historical `geocode_tx_*` table names and
`tx-cli.js` remain compatible with existing TX runs; a run now freezes its state as well as its
request profile. Reusing a run ID with another state fails before submission. County snapshots
are separate by state (254 TX, 67 FL, 100 NC counties), and every query, centroid fallback and
publication audit uses the selected state. Migration 870 extends the bounds; 871 adds state
keyset indexes for the larger shared address cache. Neither changes existing TX observations.

```sh
# First import NPPES, ACTIVE issuer sets and geography for the selected state.
node dist/worker/cli.js ingest geo --state FL --year 2026
node dist/worker/cli.js ingest geo --state NC --year 2026
node dist/ingest/geocode/tx-cli.js --state FL --run-id fl-20261108 --budget-minutes 100
node dist/ingest/geocode/tx-cli.js --state NC --run-id nc-20261108 --budget-minutes 100
# Resume with the same state/run ID. Report-only never changes the frozen selection.
node dist/ingest/geocode/tx-cli.js --state NC --run-id nc-20261108 --report-only --http-check
# Bootstrap uses this bulk queue, including its row rejection and labelled fallback rules:
node dist/worker/cli.js bootstrap --states FL,NC --years 2026 --with-geocode
```

The scoped single-county `worker ingest geocode` command and Harris developer runner retain
their TX-only interface. Use the statewide CLI or bootstrap for FL/NC. Bootstrap holds the bulk
writer lock on a reserved connection while each queue operation commits independently; an
interrupted bootstrap run resumes its frozen input census. A completed bootstrap invocation reuses its queue when the ACTIVE shard list and immutable
NPPES import pointers are unchanged (migration 872). New pointers capture current source rows
in a new run, reusing existing normalized results without Census requests. The bulk CLI likewise permits one writer per database and applies migrations 520,
521, 600, 870–872 and 900 through the hash-checked journal.

FL/NC per-state reports are `reports/p3l-geocode-fl.{md,json}` and
`reports/p3l-geocode-nc.{md,json}` under `OPENPLANS_DATA_DIR`; existing TX report paths stay
unchanged. The operational combined report is `reports/p3l-geocode.md`. Resolved includes
terminal no-point observations. Fallback is a labelled subset of ties, unmatched and rejected
rows, never another matched address. Source-row and distinct-address counts are separate.
Offline multistate tests use explicitly synthetic coordinates/rectangles and check mixed-state
selection, immutable run state, TX match rejection with a separately labelled local fallback,
publication corruption, wrong-state database bounds and network-forbidden reuse.


Batch publication first materializes the requested address keys and seeks their source rows
through the run/address-hash index. Full reuse starts from completed results using the same
indexed lookup. This prevents a merge join from scanning the entire multi-million-row input
ledger for each batch. Attempts and points still commit together with the batch completion
marker. Duplicate publication keys are deduplicated before the lookup.

To run the multistate controls against PostGIS, create empty disposable databases named
`openplans_p3l_controls_fl` and `openplans_p3l_controls_nc`, then set
`GEOCODE_MULTISTATE_POSTGIS_URL` to their server URL with database path
`/openplans_p3l_controls` while running `tests/ingest/geocode/multistate.test.ts`. The harness
adds the state suffix, requires that explicit disposable prefix, and runs normal migrations.
Drop both test databases afterward. Offline CI uses PGlite and requires no server or network.

## Completed FL and NC runs

The 2026-11-08 runs resolved every staged address. Counts are distinct normalized addresses;
fallbacks are a subset of ties, no-match and rejected results.

| State | Resolved | Matched | Ties | No match | Rejected | Labelled fallbacks | No point |
|---|---:|---:|---:|---:|---:|---:|---:|
| FL | 392249 | 359362 | 2837 | 30037 | 13 | 32120 | 767 |
| NC | 137240 | 123865 | 818 | 12533 | 24 | 11801 | 1574 |

All 40 FL and 14 NC batch manifests completed. The publication audits reconciled 5,200,800 FL
and 2,539,541 NC source rows with zero errors. Both spatial indexes stayed enabled. Scope follows
the address state, so an ACTIVE issuer feed from another state can contribute addresses.
Per-state JSON reports retain county counts, rejections and snapshot provenance under
`OPENPLANS_DATA_DIR/reports/`. The final HTTP checks and closeout extend `p3l-geocode-fl.md`.

NPPES radius queries validate current address keys and snapshots before paging. They fetch
street-address fields for the final page, preserving exact totals and missing-point counts.

## Cleanup retries

Run cleanup against a fully staged statewide run. The source run ID and cleanup run ID must differ.

```sh
node dist/ingest/geocode/cleanup-cli.js --state TX \
  --source-run tx-20261107-p3e-active14 --run-id cleanup-tx-v1 --budget-minutes 60
```

Only changed No_Match and Tie addresses qualify for another Census submission. Completed request
hashes reuse the existing cache. PO boxes keep their labelled fallback and are never submitted.
The cleanup ledger retains the original address, original Census observation, normalized address,
request address and rule IDs. A suite stays in the normalized address and original identity;
the street-only retry omits recognized secondary units. Unknown line-two text stays in the request.
A successful retry publishes against the original source key. Unsuccessful or rejected replies
leave its prior fallback intact. Resuming the same cleanup run reuses its ledger and pending batches.

The rules use [USPS Publication 28 secondary units](https://pe.usps.com/text/pub28/28c2_003.htm),
[directionals](https://pe.usps.com/text/pub28/pub28c2_014.htm) and
[street suffixes](https://pe.usps.com/text/pub28/28apc_002.htm).
The suffix table covers common forms. Directionals change only at the start or end of a street
name; a directional that is the whole name stays spelled out. Adjacent repeated nonnumeric
words are removed. House numbers, hyphens and fractions must survive. ZIP+4 is trimmed when
present; previously staged statewide inputs already have ZIP5. These rules are retry candidates,
not postal address verification.

Per-state results go to `reports/p3m-geocode-{tx,fl,nc}.json` under `OPENPLANS_DATA_DIR`.
Counts use distinct original addresses. A recovered address can have several rule IDs, so per-rule
recoveries overlap and must not be summed. Network submissions count distinct cleaned requests.
The combined measurement and validation report is `reports/p3m-geocode-quality.md`.

## Optional operator geocoder

An unset `OPENPLANS_GEOCODER_URL` disables the adapter. Configuration is described in `.env.example`.
The URL template accepts URL-encoded address fields and `{key}`; the key comes only from
`OPENPLANS_GEOCODER_KEY`. Dot-separated JSON paths select numeric latitude and longitude and a
five-digit county FIPS, including array indexes. Replies lacking these fields are discarded.
Requests run sequentially with at least one second between starts. HTTPS is required; plain HTTP
is accepted only on a loopback IP for tests. Redirects, oversized replies, timeouts and HTTP failures
retain the fallback. Logs use fixed messages and never include a URL, raw response or exception text.

The adapter runs only after the Census cleanup attempt completes for an address. PO boxes and
out-of-bounds points are excluded. County validation checks both the claimed county extent and
polygon. Without `OPENPLANS_GEOCODER_STORE=1`, the adapter contributes only counts to the run report;
it writes no coordinates to disk or SQL.

Setting `OPENPLANS_GEOCODER_STORE=1` attests that the operator's provider permits coordinate storage.
Stored points carry `source: operator_geocoder`, the observation date, original address hash,
county and county-bounds snapshot. They live only in the private external file
`OPENPLANS_DATA_DIR/operator-geocoder/points.json`, with directory mode 0700 and file mode 0600.
The writer rejects a data directory inside a checkout. Do not distribute this private directory.
The source export and SQL dumps contain no operator points. No public fixture uses a provider reply.

To serve stored operator points, set both `OPENPLANS_GEOCODER_STORE=1` and
`OPENPLANS_API_CACHE=off` in the API process. The latter keeps private responses out of shared cache
dumps. With either setting absent, searches use public Census/ZCTA evidence. Provider search reads
and validates the private points, then overlays them for the current source keys in a query-local
CTE. It never writes them into Postgres or replaces a successful Census match. API addresses expose
`geocode_label` as `census_match`, `census_match_after_normalisation`, `operator_geocoder` or
`zcta_fallback`. Operator coordinates have `precision: operator_reported` and `geocode_as_of`;
a Census Exact match remains a street-range interpolation.
