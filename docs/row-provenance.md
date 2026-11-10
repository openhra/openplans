# Row provenance columns

Every table has five columns that say when the row was written and where its data came from.
Migration `990_row_provenance.sql` adds them, and a row trigger fills them on every write.

| Column         | Type                  | Meaning                                                                                                                                                                                 |
| -------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created_at`   | timestamptz, not null | When this database first wrote the row. Updates keep it.                                                                                                                                |
| `updated_at`   | timestamptz, not null | The last write to the row. Every `UPDATE` sets it to `now()`.                                                                                                                           |
| `sourced_by`   | text, not null        | The `source_id` of the snapshot the row came from, such as `cms-nppes` or `cms-exchange-puf:2026:TX`. `openplans` for rows OpenPlans makes itself. `unknown` when no snapshot is known. |
| `sourced_at`   | timestamptz           | The snapshot's `retrieved_at`: when the source bytes were downloaded, not when the row was inserted. Null when nothing was downloaded or the time is not known.                         |
| `sourced_slug` | text, not null        | The `snapshot_id`, which joins to the `snapshot` receipt. Rows OpenPlans makes carry `app:`, `job:`, `cache:`, `derived:` or `registry:` slugs instead.                                 |

The columns copy the existing `source` and `snapshot` records onto each row. They add no new
provenance. The snapshot remains the full receipt: URL, hash, byte count and validation state.

## How values are set

Each table has a rule in `row_provenance_rule`. A rule names the columns that hold the row's
snapshot id (`snapshot_id`, `import_id`, `publication_snapshot_id` and so on) or a fixed value
for application state. The trigger looks up the snapshot on insert, and again on update when the
reference changes. It ignores values a caller passes for `sourced_*`, so no ingest path can
record the wrong source. A row that points at a snapshot id with no snapshot record keeps the id
as its slug and says `unknown`.

On insert the trigger keeps a `created_at` or `updated_at` the caller passes, so rows copied
between databases keep their times.

## New tables

`worker migrate` installs the columns and trigger on any table that lacks them, whatever order
the migrations ran in. A table with a `snapshot_id` column, or a single foreign key to
`snapshot`, gets a rule automatically. For any other table, insert a row into
`row_provenance_rule` in the same migration. Otherwise `tests/row-provenance.test.ts` fails.
Views and extension tables carry no rows of their own; that test lists them with a reason.

## Upgrading an existing database

The migration adds the columns without rewriting tables, and fills tables of up to 100,000 rows.
Larger tables say `unknown` until you run:

```sh
docker compose run --rm worker backfill row-provenance
```

The command works through each table in batches of 2,000 heap blocks, one transaction per batch,
and runs `VACUUM` every five batches. It can be stopped and run again; filled rows are skipped.
`--table NAME` limits it to one table and `--blocks N` changes the batch size. For rows written
before the migration, `created_at` and `updated_at` are set to the snapshot's `created_at`, the
time of the import that wrote them.

On a 3-million-row rate table (625 MB) the migration took under a second. The backfill took
97 seconds, and the table grew to 892 MB. Only `VACUUM FULL` or a rebuild returns that space. Leave that much
free disk before running it. The trigger adds about a third to the time of a bare bulk insert.

## API responses

API responses do not include these columns. Native responses already return the snapshot id
and retrieval time in their provenance fields, and compatibility responses keep their shape.

A query that returns a whole table row must drop them. Use `rowJson(alias)` where you would
write `to_jsonb(alias)`, and pass a row selected with `alias.*` through
`withoutRowProvenance(row)`. Both are in `src/db/row-provenance.ts`.

The test setup in `tests/response-columns.setup.ts` reads every JSON response of every app the
tests build with `createApp`. A request fails when its response has one of the five names. Two
documented fields share a name with a column and are allowed: the `cms_api` object of the CMS
Marketplace API fallback, and `updated_at` on a compatibility plan.
