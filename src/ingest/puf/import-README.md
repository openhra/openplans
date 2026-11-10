# CMS PUF catalog import

Build with `npm run build`, then run:

```sh
npm run worker -- ingest puf import --year 2026 --state TX
```

The production worker uses `DATABASE_URL` and runs the normal migrations. It reads
only the newest `OPENPLANS_DATA_DIR/raw/cms-exchange-puf/manifest-*.json`, verifies
each selected archive's SHA-256 and byte count against acquisition metadata, and
streams its single CSV member. It never downloads. The observed 2026/2027 schema
requires six catalog files; the XLSX MR URL file belongs to later work. The Plan ID
Crosswalk PUF has its own command, described in the plan lineage section below.
A changed archive layout or a missing critical column fails closed.

Each invocation creates an immutable parent snapshot plus six file snapshots.
Each file has one transaction and batches of at most 250 rows. Source row numbers
are physical starting CSV lines, including the header. Other states are skipped
before row conversion. Invalid selected rows create row-addressed quality issues;
file-level failures roll back that file. The importer retains all original fields as raw
JSON or in the immutable acquired input.

`plan_attribute` preserves input rows independently of the canonical `plan` and
`plan_variant` tables. Base exchange eligibility is the union of published variant
eligibility, while each variant keeps its original classification. Issuer names
are the published marketing names; no legal name is inferred. Internal service
area and network IDs are scoped by issuer/year/market/dental flag. Service-area
source row counts refer to `service_area_county`, including statewide blank-county
rows; `service_area` is their deduplicated parent.

Reconciliation checks exact file row counts, identifier lengths, plan/rate/variant/
benefit references, service-area and network references, duplicate rate keys and
complete 51-band per-member rate groups. Unused service areas are reported as
warnings because a published area can legitimately have no current plan. Missing
or duplicate per-member bands quarantine the set; missing prices are never filled.
Family tiers retain all seven published amounts and are never converted into
per-member premiums. Cost sharing parses only unconditional exact dollar texts;
conditions and all other text remain raw, with null parsed values.

Only a passing set advances `PARSED -> VALIDATED -> RECONCILED -> ACTIVE` and
atomically updates `puf_active_catalog`. Failed sets become `QUARANTINED`; the
previous pointer and its ACTIVE snapshots remain unchanged. Earlier successful
snapshots remain immutable historical ACTIVE evidence; the pointer defines which
set is currently served. The importer writes JSON and Markdown reports under
`OPENPLANS_DATA_DIR/reports/`.

The importer stores rows of every market, including `SHOP (Small Group)` rows, and keeps the
published value in each table's `market` column. Individual routes still filter on
`Individual`. `puf_market_catalog` records which ACTIVE import serves each state, year and
market. An import that publishes serves every market in its Plan Attributes rows. With
`marketsWithoutPublish`, an import that holds only SHOP plans serves that market and leaves the
individual pointer alone. `marketCatalogCensus(db, year, market?)` counts the stored base plans
and variants per served market.

PUF imports alone create `unsupported` state/year/market rules, including NY and VT.
Separately ingest `data/rating-rules/2026.json` or `2027.json` for cited TX individual
medical support (`worker ingest rating-rules --file data/rating-rules/2027.json`). Filed
rate-row shape (`per_member` or `family_tier`) does not grant state rating support.
Consumers must honor `state_rating_rule` before invoking the premium engine.

## County query contract

```ts
import { plansForCounty, createPufRepository } from "./import.js";
await plansForCounty(db, "48201", 2026, "Individual");
await createPufRepository(db).plansForCounty("48201", 2026, "Individual");
```

Results are canonical base plans from the active set, with `on_exchange`,
`off_exchange`, `dental_only`, `rating_method`, snapshot/row provenance,
`zip_restricted`, normalized `zip_codes` and the original `raw_zip_codes` lists.
Statewide areas apply to every county in that state. Partial-county rows retain
ZIP restrictions; a matching unrestricted county or statewide row makes the union
unrestricted. This query does not assert address-level ZIP availability. Filter
`on_exchange && !dental_only` for the Harris medical comparison.

## Offline checks and fixture regeneration

`npm test -- tests/ingest/puf/import.test.ts tests/ingest/puf/import-source.test.ts`
uses PGlite, real CMS cuts and explicitly synthetic mutants. Regenerate the small
CSV cuts with `npm run fixtures:puf:import` using already cached archives. The
provenance manifest records archive hashes and original physical end-line offsets;
fixture CSV row numbers identify positions in the cut, not the original archive.
The tests cover D3, D4, D6 and D8, ten missing rates preserving the previous ACTIVE
set, malformed HIOS IDs, unsupported NY rules, changed hashes/headers/manifests,
and the successful worker ZIP/manifest path.

## Real-data validation

```sh
npm run build
npm run worker:puf:pglite -- ingest puf import --year 2026 --state TX
scripts/realdata.sh --year 2026
```

The developer runner requires dev dependencies, stores its DB at
`OPENPLANS_DATA_DIR/puf-pglite-p1d`, and skips PostGIS only in a temporary migration
copy. The production worker does not skip extensions. No Docker is started.
The public checks compare imported rows and premiums with independently parsed
CMS CSVs and write per-state reports below the external cache. Each production
import writes `reports/puf-2026-TX-<import UUID>.json` and `.md`.

The initial real run stored exactly 4,277 attribute rows, 1,954 service-area rows,
44 networks, 896 business rules, 203,592 rates and 285,465 benefits. It produced
896 base plans and 4,277 variants. Harris has 121 on-exchange individual medical
base plans. All 13 statewide TX service-area rows are dental (49 individual
base plans); they do not increase this medical count. The two unscoped area labels
represent 13 issuer/market/dental-scoped areas. No Harris medical result is partial.

No premiums or catalog entries are fabricated to fill missing public evidence.
Premium support requires separately cited state rules before the API computes it.

For the PY2027 schema audit, import evidence, rating-area review and year-over-year
comparison, see [tx-2027-README.md](tx-2027-README.md).

## All publication-listed individual medical states

`worker ingest puf import --year 2026 --all-states` (also PY2027) discovers states
from on-exchange individual medical Plan Attributes rows. It reads each archive
once into bounded temporary partitions under the external data cache, preserving
original physical row numbers, acquired hashes and URLs. The importer hashes
and counts each partition before import. The state count is checked independently of inserted
rows. Partitions are removed when the batch completes.

Each state has its own immutable six-file import, reconciliation and ACTIVE pointer.
The importer records a quarantine or state exception and continues with the next state. The command
returns nonzero if any state failed. `reports/puf-<year>-all-states.json` is updated
after each state, with exactly one result per attempted state. Per-state reports
retain the original acquired manifest path. NY/VT cannot gain per-member support.

The cache-only `node scripts/oracle/all-states.mjs --year 2026` independently reads
raw CSV through Python Decimal, compares every imported row count and ID set, and
checks every member-rate row across its ages and both tobacco flags. It records
Family Option counts without pricing the tiers. State developer databases are
`puf-pglite-p6d-<year>-<state>`; it never opens another lane's databases. Two bounded
state processes run concurrently, each state is resumable only with matching raw
archive hashes, and failures do not stop sibling states. `scripts/realdata.sh` runs
this check for both selected years after the existing TX checks. Detailed per-state
results are `reports/p6d-<year>-<state>.json`; aggregate reports are
`reports/p6d-all-states-<year>.json`.

Activate the cited state methods separately with
`worker ingest rating-rules --file data/rating-rules/<year>.json`. The no-file
rating-rules command intentionally retains the original TX PY2026 bootstrap;
it replaces the active 2026 rule set with TX only. Use explicit year files after
multi-state imports. The all-state oracle always selects these complete files.

## Plan lineage from the Plan ID Crosswalk PUF

```sh
npm run worker -- ingest puf lineage --year 2026
```

The command reads the acquired `plan-id-crosswalk` archive named by the newest manifest and
checks its SHA-256 and byte count. It stores every CSV row in `plan_lineage` as one immutable
snapshot and keeps the original row in `raw`. The PY2026 file maps 2025 plan IDs to 2026
plan IDs, county by county. CMS writes `00000XX0000000` when a row has no successor, and the
importer stores that as `NULL`. Each plan ID must match its row's state and issuer columns.
One rejected row, a missing column or a stored count that differs from the input count
quarantines the snapshot. Otherwise the snapshot becomes ACTIVE and `plan_lineage_active`
points the year at it. Reports go to `reports/puf-lineage-<year>-<UUID>.{json,md}`.

`planLineage(db, planId, year, state)` returns the distinct prior-year IDs whose crosswalk
rows name the plan, through every served year. A 2027 plan reaches both its 2026 and its
2025 IDs. The function returns `unknown` when no served crosswalk covers the state, which is
the case for state-based exchange states. It follows the primary crosswalk column only. The
age-off and silver CSR destinations stay in their own columns and in `raw`.

`scripts/oracle/lineage.mjs` imports both acquired years into a disposable database. It
compares per-state row counts, the prior and successor ID sets, the pair set and every served
ancestor chain with an independent stdlib parse in `lineage-reference.py`. A planted wrong
prior-year ID must make that comparison fail. Offline tests use a real cut in
`tests/fixtures/puf/lineage/`, which its `regenerate.py` rebuilds.
