# Record expiry policies

Every owned table has three internal columns, added by migration `992_record_policy.sql`.
They do not appear in API responses.

| Column          | Type                  | Meaning                                                                                                                 |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `record_policy` | text, not null        | Name of the row's policy in `record_policy`.                                                                            |
| `record_ttl`    | interval, nullable    | Validity period measured from `sourced_at`, or `created_at` when no source time exists. Null means no scheduled expiry. |
| `expired_at`    | timestamptz, nullable | End of the validity period. Null means no scheduled expiry. An operator can expire a row earlier.                       |

The `record_policy` table holds `name`, `default_ttl`, `stale_window` and `description`.
The initial policies are:

| Name                       | Default TTL | Stale window | Used for                                                           |
| -------------------------- | ----------- | ------------ | ------------------------------------------------------------------ |
| `source_snapshot`          | null        | 0            | Imported public files. Snapshot activation still controls serving. |
| `app_state`                | null        | 0            | Application state written by OpenPlans.                            |
| `cms_api_fallback`         | 7 days      | 30 days      | CMS Marketplace API coverage answers.                              |
| `cms_api_fallback_no_data` | 1 day       | 30 days      | `DataNotProvided` coverage answers.                                |
| `unknown`                  | null        | 0            | Rows without a known source.                                       |

`row_provenance_rule.policy_name` chooses each table's policy. The expiry trigger runs after
row provenance, so it reads the receipt's source and retrieval time. Coverage rows select the
no-data policy when their coverage value is `DataNotProvided`. A caller cannot change that
mapping by supplying another policy name.

The trigger fills `record_ttl` from the policy. Writers can supply a shorter TTL, but cannot
extend it past the policy default. A source or policy change starts a new validity period.
Other updates preserve an earlier expiry, including one set by the operator.

## Operator commands

Run these in the worker container after `worker migrate`:

```sh
docker compose run --rm worker record-policy list
docker compose run --rm worker record-policy set cms_api_fallback --ttl '3 days' --stale '7 days'
docker compose run --rm worker record-policy set cms_api_fallback_no_data --ttl '2 hours'
docker compose run --rm worker record-policy expire cms_api_fallback
docker compose run --rm worker record-policy expire cms_api_fallback --before '2026-11-01T00:00:00Z'
```

`set` accepts PostgreSQL intervals. Negative intervals fail. Use `--ttl none` or `--ttl null`
for no scheduled expiry. Omitting `--stale` keeps the current stale window. The command updates
the policy and recomputes its rows in batches of 2,000 heap blocks. Rows using the old default
follow the new default. Rows with a shorter writer TTL keep that limit.

`expire` sets expiry to the command time, capped at the policy deadline. It deletes nothing. `--before` selects rows whose source time, or creation time when no source time exists,
is at or before that timestamp. The next eligible coverage request tries to fetch again.
A read-only request can still serve the expired answer within the stale window.

Policy edits and row batches commit separately. Run one policy command at a time. If a command
stops midway, some rows may still have their previous TTL. Run `list`, inspect the worker's exit
status and audit the database before relying on a changed policy. Repeating a tightening is safe;
if an interrupted widening left old TTLs behind, those TTLs remain shorter until explicitly reset.
Direct SQL edits to `record_policy` affect future writes and stale reads immediately. Use `set`
to recompute existing rows.

Leave `source_snapshot` at its no-expiry default for normal operation. The readiness audit
rejects TTL or expiry fields on official snapshot rows. Coverage readers never turn expired
imported evidence into a negative answer. Missing evidence stays `unknown`.

## Coverage fallback behavior

Freshness uses `expired_at`. A row is fresh before that time, or indefinitely when it is null.
An expired row remains eligible for stale serving until `expired_at + stale_window`. OpenPlans
tries a live refresh first when it can. After that window, an unsuccessful refresh leaves the
answer `unknown`.

The two coverage tables retain `expires_at` as a deprecated alias for this release. The trigger
copies `expired_at` into it on every write. New readers must use `expired_at`.
Each successful fetch gets a receipt that includes the fetch time in its identity, even when the
response bytes match an earlier fetch. A refresh therefore uses the new retrieval time.

Before enabling the fallback, run the migration, list the policies and choose both coverage
TTLs and stale windows. Then follow the [fallback switch-on notes](../src/ingest/cms-api/README.md).
The feature remains off unless its environment switch and API key are set.

## Large tables and later migrations

Migration 992 adds `record_policy` with a constant per-table default and adds the two nullable
fields without defaults. It does not update official-data heaps. Existing coverage rows need
TTL initialization, so the migration initializes those two tables. Their size determines that
part of the migration's duration.

`worker migrate` installs the three columns and trigger on later tables after installing row
provenance. `worker backfill row-provenance` also fills policy metadata in its existing batches.
It skips rows whose policy and TTL are already set. Official rows need no extra backfill when
their table default already names the correct policy.
