# QHP formulary ingestion

After PUF, RxNorm and QHP discovery ingestion:

```sh
npm run build
npm run worker -- ingest qhp formulary --year 2026 --state TX --issuer 76589
```

The importer downloads missing plan and formulary children through `fetchToCache` with a 4 GiB cap.
The command selects every formulary child advertised by
all issuer registry rows in the latest discovery run, deduplicating by kind and original URL
hash (including distinct query shards). It does not combine historical discovery runs. Cached
plan children supply published tier definitions; cached bytes are SHA-256 checked while
streaming. Drug record and association indexes are zero-based.

Migration 320 adds `formulary_source_set`, `formulary_shard`, `formulary_edge`,
`formulary_active_set`, and `qhp_coverage_manifest`. Each attempt gets independent snapshots
linked to the original raw acquisitions. The manifest records issuer/year/state/kind,
completeness and reason; `data_availability.formulary_status` also becomes available or unknown
for the issuer's catalog markets, without overwriting catalog/premium/provider provenance.

Only active PUF catalog plans in the requested state/year/issuer are retained. Unknown target
plans generate counted `plan_not_in_catalog` issues; other states/issuers/years are skipped.
The importer retains duplicate publisher associations with their association index. Missing/null
optional flags remain NULL. Nonboolean flags reject the association and quarantine the set.
Unresolved tier labels remain verbatim on ACTIVE edges with `tier_status: unresolved`.
Migration 330 adds the explicit tier status. These labels generate one warning per label × plan
across the source set; each warning counts its affected associations. No synonym mapping is
inferred. `cost_sharing` and `patient_price` remain null. Reimport older snapshots to derive
the tier status under parser `qhp-formulary-v3`.
Quality issue explanations contain `count` and `first_source_record`; structural issue counts are per reason
per shard rather than one database issue row per repeated association. Tier warnings instead
include `base_hios_id`, `drug_tier`, and the affected association count.

All required shards must reach EOF, pass hash/schema validation, and have an available
catalog before publication. One issuer-scoped transaction/advisory lock atomically publishes
the ACTIVE pointer and manifest. Any failed attempt leaves prior ACTIVE snapshots and their
positive evidence intact. Its latest manifest blocks absence from becoming `not_listed`.
A quarantined attempt exits 1 and still emits the JSON report.

Use `createDrugRepository(db).drugCoverage(planId, rxcui, year)` from `domain/drugs`.
The exact RxCUI must exist in the current ACTIVE RxNorm release. A 17-character variant
must exist in the active catalog and resolves to its 14-character base. Results retain all
source evidence, shard/raw/source-set snapshot IDs, source URLs, row indexes, published tier
and nullable flags; `patient_price` is always null. Contradictory tiers, explicit statuses or
known boolean facts return `conflicting`; an unknown flag does not contradict a known value.
Explicit negative evidence is supported by storage/query, but this adapter emits only positive
listings: no undocumented source field or tier label is interpreted as an exclusion.

## Offline fixtures and developer real-data checks

```sh
npm run build
node tests/fixtures/qhp/formulary/regenerate.mjs
npx vitest run tests/ingest/qhp/formulary.test.ts tests/domain/drugs
node dist/ingest/qhp/formulary-pglite.js ingest qhp formulary --year 2026 --state TX --issuer 76589
python3 src/ingest/qhp/formulary-compare.py
```

Regeneration uses cached real Cigna files plus the real active PUF and RxNorm PGlite databases;
it retains selected drug objects, projects only tier fields from plans, and excludes contact
fields. Source hashes and original drug indexes are in fixture provenance. Mutants and their
acquisition/catalog identity test setups are labelled synthetic in tests. Every fixture is below
200 KB. CI needs neither the data cache nor network access.

The developer runner clones `qhp-pglite-p2b-integrated` into `formulary-pglite-p2c` on first run,
copies the real active Cigna catalog and exact RxNorm atoms for the feed's codes (plus 6809 for
an absence query), and omits only the PostGIS extension migration. Set `OPENPLANS_DATA_DIR`
for the cache and `OPENPLANS_FORMULARY_DB` for an alternate isolated output DB. Reports stay in
`$OPENPLANS_DATA_DIR/reports/p2c-formulary-{realdata,comparison}.json` and the comparison Markdown.
Archive-dependent comparisons are omitted from public releases.

The measured live Cigna file has two tier labels absent from its plan definitions. Under the
2026-11-07 tier policy it is ACTIVE with 44 warnings, covering 35,226 unresolved associations.
Truncated/missing shards, malformed records, unknown years and string booleans still quarantine.
This validation did not run production PostgreSQL/Docker.

`OPENPLANS_FORMULARY_REPORT` changes the developer runner's report filename
(default `p2c-formulary-realdata.json`). Reports retain the source hashes,
imported counts and issues for inspection. Public fixture tests check nullable
PA/ST/QL evidence and unknown coverage behavior.



Migration-order integration note: this lane's reserved migration is 330. The current
migration runner refuses pending migrations below an already-applied version. A database
that already applied 400 or later needs the orchestrator to resolve migration ordering
before this upgrade; a fresh database and the P2d validation database apply 330 before 400.
This lane does not change `src/db/migrate.ts` or use numbers outside its 330–339 lease.

## All readable issuers

```sh
npm run worker -- ingest qhp formulary --year 2026 --state TX --all-readable
node dist/ingest/qhp/formulary-all-pglite.js formulary
node dist/ingest/qhp/formulary-all-pglite.js providers
```

Migration 420 extends the manifest to `complete`, `partial`, `failed`, `access_denied`, and
`unknown`. The batch considers each registry issuer's latest discovery run. It imports readable
indexes and also writes unknown/denied rows for unreadable indexes, so they are visible in the
manifest. An absent kind is unknown. One issuer's failure never stops the next issuer. A batch
exits 1 if any issuer is incomplete and still emits every issuer's report.

Plan definitions and the requested kind are deduplicated by the original URL hash, including
across issuers. Cached acquisition metadata is reused through the safe fetcher and feed hashes
are checked while parsing. Each issuer gets an independent source set and only its own active
catalog plan edges; raw acquisitions can be shared. HTML, access denial and size-cap failures
retain their reason codes. `too_large` is partial even when zero records were downloaded;
no capped body is parsed. Up to three children download concurrently, with streamed bodies
and bounded buffers. No tier synonyms are inferred. Every active catalog plan must have
a definition explicitly publishing the requested year; an evergreen index containing only
next-year definitions cannot establish current-year absence. Missing declarations are
`catalog_plan_year_not_in_definitions`, independently of unresolved tier warnings. If every
shard reaches EOF and passes structural/hash validation and this definition gap is the only
issue, valid positive associations can be ACTIVE with a partial manifest. Absent drugs and
providers still return unknown. Fetch, schema, hash and budget failures never use that path.

The isolated PGlite runner bootstraps the current `qhp-pglite-discovery-2026-TX` and
`puf-pglite-p1d` cache databases; run discovery and catalog ingestion first. Only its temporary
migration copy omits PostGIS. `OPENPLANS_QHP_DB` changes the destination, and
`OPENPLANS_QHP_RUN_BUDGET_MS` sets a time budget covering downloads and parsing (default 50 minutes).
An expired budget records `run_budget_exceeded`/partial and never publishes shortened feeds;
unstarted issuers remain explicitly not run with `unknown`/`not_run_budget` manifest rows. SIGINT/SIGTERM stop the runner through the same
quarantine-and-close path. `OPENPLANS_QHP_RESUME=1` retains issuer rows from a previous run and
starts only issuers without a report row. To retry a partial issuer, use `OPENPLANS_QHP_ISSUER`
without resume.
`OPENPLANS_QHP_ISSUER` retries one issuer and replaces its previous report row. Run the two
kinds sequentially against a PGlite directory. Reports persist after each issuer under
`reports/p6a-{formulary,providers}-realdata.json`; the comparison script writes
`reports/p6a-tx-issuers.md` and caches immutable SQLite reference counts separately. It records
D1/D2 completeness limits and explicitly lists issuers not yet run. These counts do not prove
record equivalence, and quarantined rows never establish absent coverage.


For an isolated native Postgres run, set `OPENPLANS_QHP_DATABASE_URL` explicitly to the
loopback database owned by a Docker project named `openplans-p6a`. Then run
`node dist/ingest/qhp/formulary-all-postgres.js formulary|providers`. This developer runner
applies every migration, including PostGIS, and bootstraps discovery/catalog from the same
cache databases. It supports the same issuer, resume and budget controls and writes separate
`p6a-postgres-{formulary,providers}-realdata.json` reports. It does not use a default production
`DATABASE_URL`. The caller must tear down the container it starts and preserve data below
`OPENPLANS_DATA_DIR`. No new dependencies are required.

The native runner also supports `OPENPLANS_QHP_STATE` and `OPENPLANS_QHP_YEAR` (defaults TX/2026).
Run its `discover` mode to discover every selected-state issuer directly on Postgres using the
cached official MR URL PUF. It writes `qhp-discovery-<year>-<state>.json`. The catalog bootstrap
uses `OPENPLANS_QHP_CATALOG_DB`, otherwise `puf-pglite-p1d` for TX/2026 and the validated
`puf-pglite-p6d-<year>-<state>` cache for other scopes. Existing selected-state ACTIVE catalog
and discovery rows are retained. `OPENPLANS_QHP_REPORT_PREFIX` isolates batch reports. For FL:

```sh
OPENPLANS_QHP_STATE=FL node dist/ingest/qhp/formulary-all-postgres.js discover
OPENPLANS_QHP_STATE=FL node dist/ingest/qhp/formulary-all-postgres.js formulary
OPENPLANS_QHP_STATE=FL node dist/ingest/qhp/formulary-all-postgres.js providers
OPENPLANS_QHP_STATE=FL node dist/ingest/qhp/state-postgres-audit.js
```

Set the explicit loopback database and a unique report prefix for all commands; run discovery
to completion before starting the full batches. When adding a state/year to an existing
database, run `discover` first; cached discovery serial IDs are copied only into an empty
discovery database. The HTTP audit checks one drug lookup and one
plan provider search for each issuer with ACTIVE drug or provider evidence, using the real app
and its five-second query limit. Each measured HTTP operation must finish within five seconds.
The comparison uses immutable, query-only SQLite and states P6a's D1/D2 limits; counts do not
prove source equivalence. The worker's `--all-readable` path remains the production batch API.
