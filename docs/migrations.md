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
   schema. A contract note and an operator approval are both required for risky SQL.

Never edit an applied SQL file. The journal binds each filename to its SHA-256.
A failed release gets a new forward-fix migration. Switching to an older API image
does not restore the database or undo migrations. If that image cannot use the
expanded schema, deploy a compatible fix image instead.

## Preflight and lock limits

`worker migrate --check` returns JSON with `format: 1` and a numeric-order `pending`
list. Each entry has `name`, `sha256`, `classification`, and `reasons`. This command
uses a read-only transaction and reads the journal without creating it. A risky
classification is a successful analysis result; database or history errors fail
the command. Use a read-only database role for extra protection.

The classifier checks statements, not filenames. It recognizes new tables,
nullable columns of known built-in types, constant defaults, concurrent indexes,
new functions, and new triggers. PostgreSQL 16 can add a column with a constant
default without rewriting its existing rows. A `NOT NULL` addition needs a non-null
constant default. Volatile defaults, type changes, destructive drops, renames,
and unknown SQL still need review.

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

The 910 through 992 regression cases pin every migration under an explicit synthetic
size scenario. With eligible existing tables below both limits, six still need
review: 920 and 934 execute procedural blocks; 937 and 946 drop constraints or
indexes; 990 executes an installer; 992 executes installers and backfills and
renames a function. The other thirteen qualify as additive-safe in that scenario.
Actual preflight uses the connected database's sizes. Without size evidence, sixteen
of the nineteen still require review.

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

See the PostgreSQL 16 documentation on
[constant defaults](https://www.postgresql.org/docs/16/ddl-alter.html) and
[concurrent indexes](https://www.postgresql.org/docs/16/sql-createindex.html).

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
