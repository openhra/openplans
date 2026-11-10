# QHP provider source sets

`worker ingest qhp providers --year 2026 --state TX --issuer <issuer-id>` uses the latest
registry-backed discovery run and the active PUF catalog. Run discovery and catalog import
first. The importer acquires missing provider children through `fetchToCache`, restricted to the
index's evidenced child hosts, with a 4 GiB bound. Existing downloaded children are streamed
and SHA-256 checked at EOF. No dependencies were added.

The importer exhausts every advertised provider child and every plan definition before
publishing an issuer/year/state source set. If required definitions fail fetch, structure or
integrity checks, the importer cannot publish. It records every provider shard as
failed with `plan_definitions_incomplete`, without acquiring or parsing its provider bytes.
The source-set issue retains the definition failure; prior ACTIVE evidence is preserved.
Zero-record/zero-edge attempts derive zero identity and pair counts without scanning
unrelated national records.
A valid definition-year gap still follows the dated-positive exception described below. A parse, hash, missing-child or structural failure
quarantines the attempt. The prior ACTIVE pointer and its evidence remain intact; absent
identities return `unknown` until the current manifest is complete. Missing association years
are counted, omitted, and quarantine the attempt. Unknown catalog plans are counted and
omitted. Undeclared network tiers are counted warnings: the edge retains the publisher's
label with `tier_status=unresolved`, with a warning alongside the publisher's participation evidence.

The importer preserves records from the whole national feed, including records without target plan
edges. Only associations for the requested issuer/state/year that exist in the active PUF
catalog are stored as edges. Associations naming another state produce a counted
`plan_outside_state_scope` issue with the requested scope and first excluded plan; they never
produce edges. This is expected in national feeds and does not quarantine valid target-state
evidence. `record_id` is the immutable raw SHA-256 plus zero-based source
ordinal; it must not be treated as a cross-publication person identifier. NPI, when published,
is separate and nullable. Facilities retain the published `facility_name` and `facility_type`;
individual `name` and optional `group_name` remain separate. Every address retains its original JSON and ordinal. No edge has an
address foreign key. Three addresses and two plans produce three address rows and two edges.

`createProviderRepository(db).providerParticipation(planId, npiOrRecordId, year)` normalizes
validated catalog variants to their base plan, and returns five-state evidence with
`participation_scope=provider_record`, source dates, raw and publication snapshot identifiers,
and unresolved-tier provenance. Multiple positive tiers can be legitimate; contradictory
positive/explicit-negative evidence returns `conflicting`. The QHP positive-list adapter does
not infer explicit exclusions from absence or from `accepting`. A missing identity is
`not_listed` only for the current complete source set.

`providerIdentity(recordId, shardSnapshotId)` joins `npi_provider` and `npi_taxonomy` by NPI.
It never establishes network participation. Missing and deactivated NPPES identities are
counted findings, not reasons to remove issuer evidence. Findings cover retained national
source records; a TX-only NPPES import naturally leaves non-TX identities unmatched. The real
runner also reports a distinct-NPI match rate restricted to records with TX edges.

## Offline checks and fixture regeneration

Run `scripts/ci.sh` or the repository's `tools/gate.sh`. The fixtures in
`tests/fixtures/qhp/provider/` are synthetic: invented NPIs that fail the NPI check digit,
invented plan IDs, names, addresses and phone numbers. `truncated-tail.json` is a synthetic
provider feed cut mid-array, as an interrupted download leaves it. To regenerate:

```sh
node tests/fixtures/qhp/generate-issuer.mjs
```

`tests/fixture-lineage.test.ts` fails if a committed fixture drifts from the generator or
loses its synthetic label.

## Real-data verification

```sh
npm run build
node dist/ingest/qhp/provider-pglite.js ingest qhp providers --year 2026 --state TX --issuer <issuer-id>
```

The runner creates `provider-pglite-p3b` under `OPENPLANS_DATA_DIR`, with PostGIS omitted only
from its temporary migration copy. It copies registry discovery and real catalog rows from
the existing cache databases, verifies/reuses a cached provider download by SHA-256, and copies
matching real NPPES identities/taxonomies. Outputs include counts, issue totals, elapsed time,
shard bytes/hash, per-plan edges, distinct NPI/plan pairs and an example evidence lookup.

Migration 340 follows the lane's allocated namespace. The inherited migration runner applies
pending lane migrations in numeric order even when a higher-numbered migration is already
installed, and still verifies every previously applied checksum. The real runner uses a fresh
isolated database to keep source/candidate data separate from other lanes.

## All readable issuers

Use `worker ingest qhp providers --year 2026 --state TX --all-readable` after discovery and
catalog ingestion. Plan definitions and provider children are fetched once per original URL
hash across issuers, using the same 4 GiB cap. Only each issuer's own catalog plan edges are
retained. Every issuer gets a manifest row, including denied/unknown indexes and absent kinds;
issuer failures are isolated. HTML errors quarantine that issuer; a fetch size-cap failure is
recorded as `too_large`/partial without loading a truncated download. Previous ACTIVE evidence
survives failed attempts. Labels remain verbatim and unresolved when not declared.

See [formulary-README.md](formulary-README.md#all-readable-issuers) for the isolated P6a PGlite
runner, time budget and retry controls. Reports
include per-issuer files, bytes, records, edges, distinct NPI/plan pairs, issue counts and elapsed
time. Source records are streamed with bounded batches; full national feeds are never read
into memory as a single JSON value. The prior NPPES identity join still counts missing identity
rows as findings, independently of participation.

## Consolidated native runs and slow later children

Provider batches acquire plan definitions first, then acquire and parse each provider child
before waiting for the next download. Waiting for all downloads before parsing can exhaust an issuer's download budget. `acquireQhpChildren` also accepts
`childIds` for bounded acquisition. Acquisition inside a provider transaction uses that same
SQL session, including on PGlite; it must not query the outer single-connection database.

Parser `qhp-provider-v4` uses a savepoint for each child. Invalid schema, truncation, a hash
mismatch or an interrupted parse discards every record/address/edge from that child, including
batches already inserted. The shard still records the reason and offending source ordinal.
Complete children remain private if another child fails. Prior ACTIVE source sets stay intact.
Other-issuer TX associations are omitted with counted `plan_outside_issuer_scope` issues;
national/shared files remain supported without cross-issuer edges. An `onShard` callback gives
records, edges and elapsed milliseconds (including acquisition) after each child.

The native developer runner can consolidate the real cached releases into one loopback
Postgres/PostGIS database. The caller owns a Compose project named `openplans-<lane>`, applies
all migrations, and preserves its database volume when tearing the containers down. Set
`OPENPLANS_QHP_DATABASE_URL` explicitly, as for the existing native runner; it never uses a
production `DATABASE_URL` implicitly. No new dependencies are needed.

```sh
# Run from OpenPlans, after npm run build; configure the loopback URL separately.
export OPENPLANS_QHP_REPORT_PREFIX=p6c
OPENPLANS_QHP_ENRICHMENT=1 node dist/ingest/qhp/formulary-all-postgres.js bootstrap
node dist/ingest/qhp/formulary-all-postgres.js formulary
node dist/ingest/qhp/formulary-all-postgres.js providers
node dist/ingest/qhp/provider-postgres-audit.js
```

Enrichment copies the already validated full RxNorm and TX-filtered NPPES release tables
with 2,000-row cursors, retaining source snapshots, taxonomies and addresses. Restarted copies
use `ON CONFLICT DO NOTHING`; run each source copy only against its intended isolated database.
The report prefix isolates issuer checkpoints from P6a's reports. Resume skips issuers with a database coverage manifest (except `not_run_budget`); retry an incomplete issuer with `OPENPLANS_QHP_ISSUER` and without resume. Do not run
two imports for the same issuer concurrently. Native provider imports should run sequentially:
their in-transaction ANALYZE locks are held until the issuer commits.

The audit starts a temporary loopback HTTP server, checks one exact drug lookup and one plan-scoped provider search for every issuer with
either kind ACTIVE (the missing kind must return unknown), then closes
it. Missing identity matches fail the audit for an ACTIVE source rather than silently skipping
the check. JSON output includes all-attempt attribution counts, current NPPES absence counts
and the migration inventory. The P6c report retains the original D1/D2 reference limitations
and exact immutable publisher bytes for the FirstCare/CHRISTUS quarantines. The runner does not repair source files
locally or treat missing evidence as negative coverage.

## Dense association lists (migration 480)

Some issuer files list the same long run of plan associations on most of their records.
Parser `qhp-provider-v4` factors lists of at least 8 associations into immutable
`provider_plan_group_edge` lists plus `provider_record_plan_group` links. The hash includes
every original association ordinal, plan, year, exact tier and resolution status. Repeated
associations within a record remain distinct. Identical lists are stored once; each record
retains its own snapshot, addresses and participation scope.

`qhp_provider_plan` remains the same queryable relation, now a view over sparse legacy rows
and shared lists. Per-record SQL inserts/updates/deletes use sparse overrides and tombstones;
changing one record never changes a shared list or another record. Migration 480 retains all
pre-existing rows. Invalid/truncated children roll back their links and new lists with their
other rows. Tests compare all expanded ordinals, exercise conflicting evidence on one record,
and truncate a dense source after flushed batches.

The native audit verifies logical edge counts against the shard counters using list
multiplicity, including sparse overrides, without materializing the full dense join. TX NPI
match rates use record-level existence. The batch deliberately omits the optional distinct
NPI/plan-pair measurement above 10 million associations (`not_measured_large_source_set`);
raw/expanded edge counts remain measured. This avoids a large deduplication sort during
ingestion.

A provider child that fails JSON parsing is marked `truncated`/`invalid_json` while retaining
its failed raw snapshot. Its next acquisition bypasses the invalid cached hash and requests
the public URL again; a newly validated SHA becomes a new immutable acquisition. Other
issuers sharing that failed raw snapshot cannot silently reuse it as downloaded evidence.
Explicit caller hash pins still apply. The old bytes and quarantined attempts are retained.

## Published and historical projections (migrations 481–482)

Migration 481 tracks sparse overrides in a small keyed table, avoiding a hash of every sparse
association to expand dense lists. Migration 482 exposes current ACTIVE source sets through
`qhp_provider_plan`; `qhp_provider_plan_all` retains every stored historical/private association
for ingestion and audit. The columns and per-record write triggers are preserved.

Native checkpoints are merged under an advisory lock and written by atomic rename. The audit
reconciles the provider JSON report to the database manifest and immutable shard snapshots,
recovering timings from completed runner logs. Missing timings are labelled unmeasured.
`OPENPLANS_QHP_MIGRATIONS_DIRECTORY` may select a checksum-verified combined migration directory
when another lane has applied a migration that has not yet reached develop.

The HTTP audit uses the production database factory, including its five-second query timeout.
A matching server statement limit cancels abandoned audit SQL. A timeout fails the audit; bulk audit statements have separate 120-second limits and disable
parallel query to fit small Docker shared-memory allocations. API search performance on large
ACTIVE sources remains a separately reported result, not an ingestion success condition.

Medium-sized repeated lists are common too. The eight-entry threshold captures them using
the same exact group keys, original ordinals and sparse override semantics. No published
associations are removed; the expanded view and shard counters still count every one. The offline
controls cover lists of 8, 27, 34, 63 and 100 entries, duplicate ordinals and isolated overrides.

Provider ingestion uses transaction-local generic plans. A newly allocated shard ID can be
absent from the snapshot column's most-common-value statistics; a custom foreign-key plan
then estimates an empty snapshot and scans the snapshot/source-ordinal index while filtering
record IDs. A generic plan uses both primary-key columns. This setting ends with the issuer
transaction, preserving normal API session defaults. Near-empty tables still get initial
statistics priming. Final statistics refresh uses a savepoint and a one-second lock timeout;
a competing issuer's advisory statistics lock can skip that refresh while retaining fully
validated evidence. Unexpected SQL errors still fail the attempt. The offline lock control
raises a real PostgreSQL 55P03 error, verifies publication and checks both session settings.

## Bootstrap with several states

`worker bootstrap --states TX,FL --years 2026 --with-providers` selects NPPES
import runs by state, kind and archive SHA-256. An existing TX import does not
satisfy the FL step. Migration 680's `npi_state_scope` retains both observations;
the shared identity follows the importer's date rules. Equal-date releases add
memberships without rewriting existing identities, addresses or taxonomies.
Bootstrap refuses identities missing their original state membership, so an
inconsistent legacy selection must be repaired before another state is loaded.
The TX-only geocoding guard remains in place.

Offline bootstrap tests load TX first, then select TX and FL from the same
hash-verified synthetic ZIP around public NPPES cuts. Checksums cover every TX
identity, address, taxonomy, membership and import-run row, including a shared
identity with a Florida primary and Texas secondary practice. Removing the
bootstrap import-run state predicate makes the FL completion assertion fail.

On populated data, bootstrap allows one hour per query for schema/index upgrades.
An explicit `query_timeout` in `DATABASE_URL` takes precedence.

## Georgia PY2026 source boundary (P6i)

Georgia uses a state-based exchange. The cached 2026 federal Plan Attributes PUF and
MR URL PUF both contain zero Georgia rows. As a result, `--state GA --all-readable`
currently emits an empty issuer list and exits zero. This means the selection is empty;
it does not establish Georgia coverage. The generic native runner's GA catalog bootstrap has no
validated cache to copy. Do not manufacture registry rows or infer issuer hosts from
another state's discovery.

CMS publishes a separate [Georgia SBE bundle](https://www.cms.gov/files/zip/georgiasbepuf2026.zip),
linked from its [SBE PUF page](https://www.cms.gov/marketplace/resources/data/state-based-public-use-files).
The inspected bundle contains 896 plan rows for 16 issuers, with spaced SBE column names.
Its network and formulary URL fields are empty, and it contains no MR URL registry.
P6i records each real SBE issuer's drug/provider attempt as QUARANTINED with missing
catalog/index/children reasons; it publishes no GA issuer evidence. Loading the catalog
and discovering evidenced issuer index URLs require an SBE source adapter and registry
work before the normal streaming path can run. Missing evidence remains unknown.

The external report is `$OPENPLANS_DATA_DIR/reports/p6i-ga.md`, with acquisition hashes,
immutable reference counts, GA NPPES results, FL preservation checks and HTTP timings.
Operational scripts and logs are under `$OPENPLANS_DATA_DIR/work/p6i/`. The offline
GA-source/FL-plan control requires zero edges and a `plan_outside_state_scope` issue;
a temporary copy with the state guard removed fails that assertion.

## North Carolina PY2026 (P6j)

North Carolina is present in both federal PY2026 inputs: the hash-verified Plan Attributes
PUF contains 1,102 variant rows and 239 base plans for 13 issuers, and the MR URL PUF lists
those same 13 issuers. The validated state catalog can therefore feed the existing native
discovery and `--all-readable` batch implementation without a new state adapter.

The P6j operation adds NC alongside the retained FL/GA evidence and TX/FL/GA NPPES
memberships. Its external report is `$OPENPLANS_DATA_DIR/reports/p6j-nc.md`; acquisition,
per-issuer outcomes, source hashes, first/repeat HTTP measurements, immutable reference
counts and preservation checks remain in that external cache. An HTTP access failure is
recorded as missing evidence; it does not authorize a different client identity or URL.
The issuer-boundary disk guard stops further work below 40 GiB free in `/var/lib/docker`.

The labelled synthetic NC-source/FL-plan regression control requires zero associations
and `plan_outside_state_scope` with the requested NC scope and excluded FL plan. Removing
the state guard in a temporary source copy makes that assertion fail. NC NPPES membership
uses the normal state-scoped importer and does not establish plan participation.

On the four-core validation database, a saved provider-name query for a large issuer times out
with the default parallel-query setting. API connections using PostgreSQL's
`options=-c max_parallel_workers_per_gather=0` retain the five-second query limit and
use a serial plan. The external report keeps both the default-setting failures and
the same-request serial measurements. This is an explicit connection setting; the
database's global defaults are restored after ingestion.
The serial API replay also times out for this saved request; the five-second
provider-name performance acceptance remains open. No API implementation change
was authored by this ingestion lane.
