# Database migrations

Run `worker migrate` before starting a new API image; for local PGlite, run `npm run api:pglite -- migrate`.

- The API never migrates at startup. `/healthz` checks liveness; `/readyz` returns
  503 until the database and schema are ready. Data routes return `schema_not_ready`
  with `Retry-After` while migrations are pending. The journal refreshes within five seconds.
- `worker migrate --check` reads pending files and reports their hashes, classifications,
  reasons and size evidence without writing. Review risky files before applying them.
- Never edit applied SQL. The journal checks each filename and SHA-256. Repair mistakes
  with a new migration. An older API image does not undo database changes.
- Migration sessions have a two-second lock timeout. Put each `CREATE INDEX CONCURRENTLY`
  in its own file. Concurrent files commit separately, so a failed run may have applied
  earlier files. Inspect invalid indexes before retrying.

## Core migration order

`migrations/INDEX` lists every core SQL filename once, in application order. The
loader refuses duplicate entries, invalid filenames, unlisted SQL files and entries
whose files are missing. Both `worker migrate` and `worker migrate --check` use this
list. The journal still verifies each applied filename and SHA-256.

For a new migration:

1. Name the file `<utc-timestamp>_<snake_case>.sql`. Generate the UTC timestamp with
   `date -u +%Y%m%d%H%M%S`, for example `20261117041530_add_lookup.sql`.
2. Append its filename to `migrations/INDEX`. Do not sort the list or insert into
   the existing order. Existing numbered files keep their names and order.
3. Commit the SQL and INDEX together. If two branches append to INDEX, resolve the
   conflict by reviewing dependencies and choosing the order, then rerun the gate.
   Different names may share a timestamp; the list decides their order.
4. Add contract notes for risky SQL and run `worker migrate --check` before applying.

Do not rename applied files or regenerate recorded hashes. On an existing database,
the runner skips matching journal entries and applies pending files in INDEX order.
Plugin migrations keep their separate numbering rules below.

## Size evidence

`worker migrate --size-evidence` reads relation sizes and capped row counts in a
read-only transaction. A small table has at most 10,000 rows and 16 MiB, measured
including indexes and TOAST. Estimates never substitute for counts. Unknown sizes
stay unknown; runtime checks use the connected database's sizes.

The classifier records these rules in `sizeRules`:

- `small-index`: an ordinary index on a measured small table.
- `small-constraint`: a supported additive constraint on small tables.
- `small-insert`: literal rows or a supported insert/select over small sources.
- `small-update`: a constant or supported scalar CASE update on a small table.
- `empty-not-null`: a NOT NULL change to a table known to be empty in the pending batch.

These rules do not clear destructive drops, renames, arbitrary execution or unknown SQL.

## Reviewed exceptions

Risky statements need review. A statement annotation has this form:

```sql
-- openplans-migration-allow: STATEMENT_SHA256 Retained readers use the replacement; measured lock budget is below two seconds
ALTER TABLE example DROP COLUMN retired;
```

Use `migrationStatements` and `migrationStatementHash` from `dist/db/migrate-safety.js`
to compute the statement hash. Changed SQL needs a fresh review. Invalid annotations
fail; annotations cannot waive malformed SQL or concurrent-index restrictions.
A valid annotation yields `reviewed-exception`, not `additive-safe`.

## Plugin migrations

Enabled plugins use `<package>/migrations/NNN_<snake_case>.sql`, numbered from `001`.
Each declares a unique `tablePrefix`; its objects must start with `plg_<tablePrefix>_`.
The worker checks scope before opening the database, then runs core files followed
by plugin files in configuration and numeric order under the same lock.
The journal uses `plugin:<manifest name>/<file>`. Disabling a plugin preserves its tables.
See [plugin migration rules](plugins.md#plugin-migrations) for allowed statements and tests.

## Contract notes checked by CI

CI requires these fields for new risky migrations. Runtime preflight checks every
pending file, including historical files. Notes do not grant runtime approval.
All lock budgets below use a two-second acquisition limit. Rehearse on a restored database.

### 1000_plugin_events.sql

Stage: expand

Expand release: Add plugin event, delivery and state tables.

Compatibility: Existing readers use catalog tables. Snapshot changes emit one event per snapshot and target state. Core installers add provenance and record-policy metadata; event writes do not change catalog generations.

Forward fix: Add a migration to repair the schema or snapshot trigger.

Lock budget: New empty tables; three literal provenance rows need small-table evidence. Creating the snapshot trigger locks that table.

### 1001_passthrough.sql

Stage: expand

Expand release: Add storage for pass-through sources.

Compatibility: Sources use the tables only after registration. Core installers add provenance and record-policy metadata. Only stored answers change catalog generations; their trigger preserves the source's record policy.

Forward fix: Add a migration to repair the tables or triggers.

Lock budget: New empty tables; registry seeds need small-table evidence.

### 1002_ingest_run_snapshot.sql

Stage: expand

Expand release: Link ingest runs to snapshots.

Compatibility: The trigger records only writes carrying the worker's run setting. Older images do not set it. Provenance and record-policy metadata apply; these rows do not change catalog generations.

Forward fix: Add a migration to repair the table or trigger.

Lock budget: New empty table and one provenance seed row. Creating the snapshot trigger takes SHARE ROW EXCLUSIVE; readers continue and snapshot writes wait.

### 1003_partd_dispensing_fee.sql

Stage: expand

Expand release: Add Part D dispensing-fee ranges, loaded with `worker ingest medicare part-d import --tables dispensing_fee`.

Compatibility: Older images ignore the table. Provenance, record policy and catalog-generation tracking apply. The foreign key points to the existing `partd_release` table.

Forward fix: Add a migration to repair the table or trigger.

Lock budget: New empty table; the generation seed needs small-table evidence. The foreign key takes SHARE ROW EXCLUSIVE on `partd_release`.

### 1004_partd_unit_cost_key.sql

Stage: expand

Expand release: Store unit costs in `partd_plan_unit_cost` with release keys mapped to snapshots by `partd_pricing_release`.

Compatibility: New images read the keyed table. Older images may write the retained `partd_unit_cost` table. Missing keys return `pricing_not_loaded`; reimport with `--tables pricing`. Provenance follows the release key to its snapshot.

Forward fix: Add a migration to repair the tables or triggers.

Lock budget: New empty tables; registry seeds need small-table evidence. The foreign key takes SHARE ROW EXCLUSIVE on `partd_release`.

### 1005_partd_staged_generation.sql

Stage: expand

Expand release: Change Part D price triggers so staged rows do not invalidate cached answers.

Compatibility: Served-row triggers invalidate answers only for listed pricing or dispensing-fee tables. TRUNCATE still invalidates them. Release-row locks serialize listing with imports. Older images keep using the same rows.

Forward fix: Add a migration to repair the functions or triggers.

Lock budget: DROP TRIGGER takes ACCESS EXCLUSIVE on the three price tables; CREATE TRIGGER takes SHARE ROW EXCLUSIVE. Readers wait until commit. This file stays risky and needs explicit approval.

### 1007_provider_search_keys.sql

Stage: expand

Expand release: Add two provider search slots and their build record; fill them with `worker backfill provider-search`.

Compatibility: Older images ignore the slots. Readers use keys only when source revisions match; otherwise they use the source tables. Provenance and record policy apply. Keys do not change catalog generations.

Forward fix: Add a repair migration. Empty `provider_search_build` to disable keys until a rebuild.

Lock budget: New empty tables; three provenance seed rows need small-table evidence.

### 1008_provider_search_key_a_cell.sql and 1009_provider_search_key_b_cell.sql

Stage: expand

Expand release: Add one concurrent grid-cell index per slot.

Compatibility: Readers use indexes only through current keys.

Forward fix: Inspect invalid indexes, remove a failed index with `DROP INDEX CONCURRENTLY`, then rerun `worker migrate`. Do not add `IF NOT EXISTS`.

Lock budget: SHARE UPDATE EXCLUSIVE on each new table. Run the first provider-search backfill after these files finish.

### 995_handy_lowest.sql

Stage: expand

Expand release: Add exact single-age silver cells and activation pointers, filled by `worker build lowest-premiums`.

Compatibility: Older images ignore them. The default-off route and tool use only complete, current cells with matching source revisions, scope, algorithm and hash. Other requests rate the full candidate list. Core installers add provenance and record policy; empty tables leave generation unchanged.

Forward fix: Add a repair migration and rebuild cells. Removing an activation pointer restores full enumeration.

Lock budget: New empty tables; the provenance seed needs small-table evidence. No source table is rewritten.

### 20261117210614_lowest_county_evidence.sql

Stage: contract
Expand release: Not required. This is a one-shot replacement of derived publications.
Compatibility: Older published cells are deleted. Rebuild county cells before enabling lowest premiums. Source datasets and household calculations retain their contracts.
Forward fix: Apply an additive repair and rebuild the derived inventory. Keep the feature off when publication checks fail.
Lock budget: Two seconds to acquire locks. The migration deletes only derived cells and creates empty evidence and accounting tables.

### 20261118000213_lowest_active_build_index.sql

Stage: expand
Expand release: Index active publication pointers by build id so renewal checks do not scan every pointer.
Compatibility: No response or source-data change.
Forward fix: Add a repair index if lookup needs change.
Lock budget: Two seconds to acquire the table lock; build the index before a large renewal.

### 20261119194358_annual_data_admission.sql

Stage: expand
Expand release: next release
Compatibility: adds an empty serving-admission ledger and its metadata rule. Existing annual
catalogs and rates remain unchanged. New readers wait for migration readiness. The public
instance uses the default window of prior/current years plus an admitted next year. This
migration does not admit a year or remove data.
Forward fix: add a repair migration and correct the admission manifest. Do not remove source rows.
Lock budget: two seconds. Only the new ledger, its provenance rule and generation counter are written.

### 20261120020048_restore_function_search_path.sql

Stage: expand
Expand release: v0.4.17. Apply the function fix before enabling backup restore verification.
Compatibility: Existing images keep the same function names, arguments and results. Geocode
checks and the provider expression index can resolve their functions with an empty search path.
Forward fix: Add a repair migration for the function definitions and take a new verified backup.
Lock budget: Two seconds to acquire locks. Only function definitions and settings change; no
table scan or rewrite is needed.

### 20261120123130_geocode_match_archive.sql

Stage: contract
Expand release: v0.4.18 or later adds the build-only matched-attempt archive.
Compatibility: Every API version reads only unresolved attempts and address points, so answers
are the same before the migration, after it, while `worker backfill geocode-archive` moves the
matches and after it validates the checks. Older workers write matches to geocode_attempt, so
stop them before this migration; the NOT VALID check refuses their matched writes. New geocoders
and compact refuse until the backfill has validated both checks. Serving artifacts omit the
archive; the next build recreates it and reuses matched address points.
Forward fix: Add a migration that repairs the archive or the served checks. Keep the matched
points and snapshot receipts. A stopped backfill resumes when run again.
Lock budget: Two seconds to acquire locks. The file changes the catalog only: dropping the
address_point foreign key takes ACCESS EXCLUSIVE on address_point and geocode_attempt, and both
checks are added NOT VALID, so the locks are held for milliseconds whatever the table sizes. The
backfill runs after the migration, outside its transaction. Each batch takes ROW EXCLUSIVE and
SHARE ROW EXCLUSIVE; VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE. None of these conflicts
with a reader. Leave free space for the archive heap, its indexes and about twice the moved bytes
of WAL. DELETE does not shrink geocode_attempt; compact rewrites it before export. Measure the
migration's lock hold on a live-shaped clone with `ops/openplans/bin/migration-lock-probe`.

### 20261121033244_formulary_document_status.sql

Stage: expand
Expand release: Add `data_availability.formulary_document_status`, written by the carrier formulary feed source.
Compatibility: The column has a constant default, so existing rows read `not_yet_verified` and older readers ignore it. The availability endpoint reports it as `unknown` until a feed run sets it.
Forward fix: Add a migration that repairs the column or its check. Do not drop it while readers select it.
Lock budget: Two seconds to acquire locks. Adding a column with a constant default and a check on the small availability ledger needs no table rewrite.

### 20261121120000_usage_report_state.sql

Stage: expand
Expand release: Add the small `usage_report_state` table and its metadata rule for the optional usage report.
Compatibility: A new empty table that no existing reader selects. Nothing is written to it while the usage report is off.
Forward fix: Add a migration that repairs the table or its rule. Do not drop it while the usage report reads it.
Lock budget: Two seconds to acquire locks. The migration creates one empty table and inserts one metadata rule row.
