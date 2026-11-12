# Database changes while the API serves requests

Run migrations as a separate worker job before switching API images. Neither the
API server nor the developer PGlite server applies migrations at startup. For a
new local database, run `worker migrate` before starting the API. With the portable
developer runner, use `npm run api:pglite -- migrate` first.

## Expand, deploy, contract

1. Expand in release A. Add tables, nullable columns, or columns with constant
   defaults. Keep the old columns and their meaning. Build indexes on existing
   tables with `CREATE INDEX CONCURRENTLY` in a standalone migration file.
2. Deploy code that accepts both shapes. Keep old writes valid while old and new
   API images overlap. Backfill large tables in bounded worker batches outside
   the migration job. Check completeness before changing reads or constraints.
3. Contract in a later release B. Remove old reads and writes before dropping or
   renaming columns, changing types, or tightening constraints. Confirm that every
   running image and every supported rollback image tolerates the contracted
   schema. Risky SQL needs a contract note and an explicit review, recorded by an
   operator approval or the statement annotation described below.

Never edit an applied SQL file. The journal binds each filename to its SHA-256.
A failed release gets a new forward-fix migration. Switching to an older API image
does not restore the database or undo migrations. If that image cannot use the
expanded schema, deploy a compatible fix image instead.

Migration numbers 1000 and above are reserved for plugin-system core tables.

## Preflight and lock limits

`worker migrate --check` returns JSON with `format: 1` and a numeric-order `pending`
list. Each entry has `name`, `sha256`, `classification`, and `reasons`. This command
uses a read-only transaction and reads the journal without creating it. A risky
classification is a successful analysis result; database or history errors fail
the command. Use a read-only database role for extra protection.

The classifier checks statements, not filenames. It recognizes new tables,
nullable columns of known built-in types, constant defaults, concurrent indexes,
new functions, plain views, comments, and new triggers. Plain views store a query
without running it. Replacing a view or function still requires review, as does
creating a materialized view. PostgreSQL 16 can add a column with a constant
default without rewriting its existing rows. A `NOT NULL` addition needs a non-null
constant default. Volatile defaults, type changes, destructive drops, renames,
and unknown SQL still need review.

A table created earlier in the pending batch can accept `NOT NULL` without a
default while it is still known to be empty. Inserts or unknown execution remove
that evidence. A small populated table does not receive this exemption.

Preflight reads the public-schema relation inventory and total relation bytes,
including indexes and TOAST. It counts at most 10,001 rows per eligible table and
skips counting tables already above 16 MiB. It does not trust planner row estimates.
An existing table qualifies as small only at 10,000 rows or fewer and 16 MiB or
less. Partitioned, inherited, foreign, materialized-view, and row-security tables
have unknown sizes for this purpose. The effective search path must contain only
the public schema to use size evidence. Other search paths keep table sizes unknown.
Growth and concurrent writers can change lock duration after preflight.

Ordinary indexes, simple literal seeds, scalar CASE updates, and supported additive
constraints can use that small-table evidence. An `INSERT SELECT` needs a simple
projection and equality joins over small sources. Arbitrary functions and subqueries
remain risky. Check constraints and unique constraints on large or unknown tables
still need review. A nullable foreign-key column also needs a small referenced table.
A new table starts empty. `CREATE TABLE IF NOT EXISTS` proves emptiness only when
the inventory says the public table is absent. Literal seeds increase its size
bound. Other writes invalidate that evidence unless their result sizes are bounded.
Unknown execution invalidates size evidence for later statements and pending files.

A plain `DO` block containing only `BEGIN`, recognized statements, and `END` is
checked statement by statement. Loops, conditional control flow, dynamic execution,
and arbitrary function calls require review. Function definitions stay opaque
because creating a function does not execute it. A familiar function name does not
exempt an installer or backfill call. Successful earlier execution and historical
migration hashes never exempt SQL from runtime preflight.

The 910 through 1001 regression cases pin every migration under an explicit synthetic
size scenario. With eligible existing tables below both limits, six still need
review: 920 and 934 execute procedural blocks; 937 and 946 drop constraints or
indexes; 990 executes an installer; 992 executes installers and backfills and
renames a function. The other fifteen qualify as additive-safe in that scenario.
Migration 1000 creates the plugin event, delivery and state tables. Its snapshot
trigger is a recognized new trigger, so the file is additive-safe in this scenario.
Migration 1001 creates the pass-through tables and seeds a small registry with
literal rows, so it is additive-safe in this scenario too.
Actual preflight uses the connected database's sizes. Without size evidence, eighteen
of the twenty-one still require review.

Read `reasons` and review application compatibility yourself. Additive DDL still
acquires locks, and a new trigger can change write behavior. Migration sessions
use a two-second lock timeout. Ordinary batches keep their transactional rollback
behavior. A release containing concurrent index files uses a pinned session and
the same advisory lock, committing each migration separately. Use exactly one
concurrent index statement per file. PostgreSQL cannot build concurrent indexes
inside a transaction. A failed concurrent build can leave an invalid index;
inspect and remove or repair it before retrying. Earlier files in that release may
already be committed. Never hide this state with `IF NOT EXISTS`.

The release runner checks the built candidate before running its migration job or
changing the live image pin. It refuses each pending risky file unless the operator
passes `--allow-risky-migration NAME.sql`. Repeat that option for each reviewed file.
The receipt records the checked hashes, classifications, and approved names. An
approval for an absent or safe migration fails, so a typo cannot silently pass.
A dry run lists this step but does not build or check a candidate image.

## Reviewed exceptions

For a reviewed exception, put this line comment before the affected statement.
Use a concrete reason covering reader compatibility and lock expectations.

```sql
-- openplans-migration-allow: STATEMENT_SHA256 Retained readers use the replacement; measured lock budget is below two seconds
ALTER TABLE example DROP COLUMN retired;
```

Compute `STATEMENT_SHA256` after building the package. The command below prints
the statement number and digest for a migration file.

```sh
node --input-type=module - migrations/1234_example.sql <<'JS'
import { readFileSync } from 'node:fs';
import { migrationStatements, migrationStatementHash } from './dist/db/migrate-safety.js';
migrationStatements(readFileSync(process.argv[2], 'utf8')).forEach((statement, i) =>
  console.log(i + 1, migrationStatementHash(statement)));
JS
```

The digest covers executable tokens and quoted bodies. Outer SQL comments are
excluded; quoted bodies are hashed verbatim, including their comments. ASCII
letters in unquoted keywords and identifiers are normalized to uppercase. Each annotation
applies to one top-level statement. A changed token or body needs a fresh review
and digest. A reason must contain 12 to 500 printable ASCII characters. Duplicate,
misplaced, orphan, and stale annotations fail the check. Do not annotate safe SQL
or add annotations to applied migrations.

When every risky statement has a valid annotation, preflight returns
`reviewed-exception` with the original risk and review reason. Mixed files with
unreviewed risks stay `risky`. Malformed SQL and concurrent-index execution rules
cannot be waived. Reviewed execution still invalidates later size evidence.
CI still requires contract notes for reviewed exceptions.

The ordinary release strategy accepts `reviewed-exception` and records its name,
file hash, and classification in the receipt. It omits free-form review prose.
Blue-green releases refuse reviewed exceptions even with a command-line approval.
An annotation records a human review; it does not prove compatibility or turn a
destructive operation into an additive change.

See the PostgreSQL 16 documentation on
[constant defaults](https://www.postgresql.org/docs/16/ddl-alter.html) and
[concurrent indexes](https://www.postgresql.org/docs/16/sql-createindex.html).

## Plugin migrations

An enabled plugin can ship its own migrations as
`<package>/migrations/NNN_<snake_case>.sql`, with the same file-name rule as the
core and its own numbering from `001`. The plugin's manifest must declare a
`tablePrefix`: a lowercase letter followed by 1 to 15 lowercase letters or
digits. No two loaded plugins may share one. Every object a plugin's migrations
create or change must be named `plg_<tablePrefix>_...`.

`worker migrate` runs the core migrations first. Then it runs each enabled
plugin's files, in configuration order and by number, inside the same lock. The
journal records them as `plugin:<manifest name>/<file>`. Before it opens the
database, the worker reads every plugin file and refuses the whole run on the
first statement outside the plugin's prefix. It prints one line, such as
`{"plugin":"@example/plugin","code":"plugin_migration_scope","reason":"002_x.sql statement 1: table outside the plugin prefix"}`,
and exits 1. Allowed statements are `CREATE TABLE`, `CREATE INDEX`,
`CREATE FUNCTION`, `ALTER TABLE` and `INSERT INTO`, each naming a prefixed object
in `public`. The worker refuses everything else, including a partition or child
of another table, triggers, views, `DO`, `UPDATE`, `DELETE` and `DROP`. It also
refuses migration files from a plugin that declares no `tablePrefix`. The core installers then give plugin tables the
row provenance and record policy columns, as they do for core tables. Since a
plugin may not create triggers, the core also gives each `plg_<tablePrefix>_`
table the `api_data_changed` trigger and a row in `api_data_generation`, so
cached responses expire when the table changes.

`worker bootstrap` and the `worker ingest` commands migrate before they write.
With plugins enabled, that step runs the plugins' files too, after the same
scope check; a refusal prints the same line and exits 1 before the database
opens. With no plugins enabled, these commands run as before.

The plugin test kit runs a plugin's migrations too. Pass the package root to
`loadForTest(plugin, { packageRoot })`: the kit applies the core migrations,
then `<packageRoot>/migrations`, and fails setup when a plugin table lacks the
`api_data_changed` trigger or its generation row. A plugin that declares a
`tablePrefix` must pass `packageRoot`.

`worker migrate --check` lists pending plugin files after the core ones. They
carry the same `plugin:` names and go through the same classifier. The release
runner approves a risky one with
`--allow-risky-migration plugin:<manifest name>/<file>`. It finds the file in the
first-party package under `plugins/` whose `package.json` name is the manifest
name, and checks its hash there.

Disabling a plugin drops nothing. Its tables and journal rows stay, and
`migrate` and `migrate --check` stop listing its files. While a plugin is enabled,
a missing or changed applied file is an error, the same as for core files.

## Contract notes checked by CI

CI checks every migration. It exempts only the exact historical hashes frozen in
`tests/migrate-history.json`. Runtime preflight has no such exemption. New files
and changed historical files classified as risky need a section below whose
heading is the exact filename. Do not add files to the history snapshot.

Use these fields with concrete release identifiers, reader and writer behavior,
recovery steps, and measured lock expectations. A note records a review; it never
changes the runtime classification or grants release approval.

```text
### 1234_example.sql
Stage: contract
Expand release: 1.2.0 added the replacement column; 1.3.0 stopped old writes.
Compatibility: 1.4.0 and the retained rollback image read the replacement only.
Forward fix: Deploy a compatible image and add a new migration to repair the schema.
Lock budget: Two-second lock acquisition limit; rehearse on a restored database first.
```

### 1000_plugin_events.sql

Stage: expand

Expand release: Plugin event storage, before the event worker and subscribers ship.

Compatibility: Existing readers keep using the catalog tables. Snapshot validation-state updates emit an outbox row in the same transaction. The unique idempotency key allows one event per snapshot and target state. The migration runner installs provenance and record-policy metadata on all three new tables. These tables have no catalog-generation trigger because their writes do not change catalog responses.

Forward fix: Add a new migration to repair the event schema or snapshot trigger. Keep applied SQL files unchanged.

Lock budget: Two-second lock acquisition limit. The partial index covers a new empty table. The provenance registry receives three literal rows and must qualify as small during preflight. Creating the snapshot trigger acquires a table lock; rehearse on a restored database before release.

Activation payloads carry `sourceId`, `snapshotId` and `rows: null`. Snapshots do
not record imported-row counts, so the trigger cannot report a count. Quarantine
payloads carry the first error issue code for the snapshot, or `unknown` when
none exists. Both events use `emitted_by='db'` and an idempotency key of
`snapshot:<snapshot_id>:<validation_state>`.

### 1001_passthrough.sql

Stage: expand

Expand release: Generic tables for pass-through sources, before any source uses them.

Compatibility: Nothing reads or writes these tables until a pass-through source without its own storage is registered. The migration runner installs provenance and record-policy metadata on all four tables. Only `passthrough_answer` feeds responses, so only it has the catalog-generation trigger. Its generation row is added with the first stored answer, so the data generation of an installation that stores none stays the same. A second trigger on it keeps the record policy the source named, because the record-policy trigger would otherwise give new rows the table's default policy.

Forward fix: Add a new migration to repair the pass-through schema or its trigger. Keep applied SQL files unchanged.

Lock budget: Two-second lock acquisition limit. `row_provenance_rule` receives literal rows and must qualify as small during preflight. The new foreign keys to `snapshot` and `record_policy` take share row locks on those tables; rehearse on a restored database before release.

### 1002_ingest_run_snapshot.sql

Stage: expand

Expand release: A log of which ingest run wrote each snapshot, so that run's `ingest.completed` event lists only its own snapshots.

Compatibility: Readers of `snapshot` are unchanged; the new table has no column on it. For each snapshot insert or validation-state update, a new trigger adds one row to `ingest_run_snapshot`, but only when the writing transaction set `openplans.ingest_run` to a run id. The worker sets it only for snapshot writes made by an `ingest *` command while events are on. Older images never set it, so their writes add nothing. The migration runner installs provenance and record-policy metadata on the table. It has no catalog-generation trigger because its writes do not change catalog responses.

Forward fix: Add a new migration to repair the table or its trigger. Keep applied SQL files unchanged.

Lock budget: Two-second lock acquisition limit. The table is new and empty. `row_provenance_rule` receives one literal row and must qualify as small during preflight. With that size evidence the file is additive-safe and needs no allow marker. Creating the trigger takes a SHARE ROW EXCLUSIVE lock on `snapshot` for the catalog change. Readers keep running. Snapshot writes, which only ingest makes, wait for it. The trigger runs after each snapshot write and adds at most one row to `ingest_run_snapshot`, so no reader waits on it. Rehearse on a restored database before release.
