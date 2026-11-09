# NPPES V2 identity import

NPPES supplies public identity, taxonomy and address evidence. It establishes neither licensing
nor carrier/network participation. The importer never invents coordinates or plan/address joins.

```sh
npm run build
node dist/worker/cli.js ingest nppes --state TX
# Optional: --kind full | weekly | deactivation (default: all)
# Developer alternative, file database outside the checkout, no Docker/PostGIS:
node dist/ingest/nppes/pglite.js all
```

The worker requires the normal Postgres `DATABASE_URL`. The developer runner copies migrations
to a temporary directory and omits only PostGIS; it never changes production migrations. Its
PGlite database and JSON reports live below `OPENPLANS_DATA_DIR`, which defaults to
`$HOME/.local/share/openplans`. Do not run two file-DB runners against the same path.

The `ingest nppes` command supports importing another state into an existing database.
`worker bootstrap --states TX,FL` also loads each state's NPPES memberships side by side (P6h);
it still refuses anything that would overwrite another state's rows.

Discovery reads the [official CMS files page](https://download.cms.gov/nppes/NPI_Files.html).
Only official HTTPS `_V2.zip` links qualify. Every download uses `fetchToCache` under
`raw/cms-nppes/`, reusing the cached SHA256 for the same published URL. The importer rehashes the bytes.
Both compressed and actual inflated bytes are bounded (2 GiB / 25 GiB, ratio 200). Primary
and secondary CSVs stream from the ZIP with CRC verification; they are never extracted.
The deactivation ZIP currently contains XLSX, which is streamed to a temporary file in the
external data cache, read with the existing bounded XLSX reader, and removed even on failure.
Endpoint/other-identifier/contact-email data are not imported.

A database can retain multiple state-scoped observations of shared last-observed identities.
`npi_state_scope` keys membership by `(npi,state_filter)`, with independent `in_scope`, bundle
date and snapshot provenance. Migration 680 backfills existing one-state databases without
changing their identity, address or taxonomy rows. Snapshot IDs include state, kind and archive
SHA-256, so importing the same release for TX and FL records both selections; replaying either
selection is a no-op. Keep a new provider if **any
primary or secondary practice location is in the requested state**. Mailing address alone
does not qualify. Keep every published practice location for that identity, including locations
outside the selected state, plus its mailing address. `ordinal=0` is primary practice (or mailing);
secondary ordinals preserve their CSV physical row numbers. Equal address text at distinct
published locations is not deduplicated. Raw address/ZIP/phone text survives unchanged; `zip5`
and `zip4` are additional nullable parsed fields. A foreign/unparseable ZIP remains raw text.
A bounded SQL staging table holds secondary locations; only the target-state secondary NPI set
and previously observed NPI set are held in memory.

The importer applies monthly files and weekly updates atomically in batches of 500. A newer observed
record replaces the provider's taxonomies and addresses; older bundles cannot overwrite it. Weekly bundles preceding the most recent full monthly cutoff
are reported as superseded without modifying identities.
Known providers moving out of a selected state retain that state's membership with
`in_scope=false`. Only providers previously observed for that selected state are followed when
moving out; importing FL does not enroll every TX identity into the FL scope. The shared
`npi_provider.in_scope` compatibility field is true if any imported state's observation is in
scope, and its `state_filter` records the first import state. Consumers selecting a state must
use `npi_state_scope`, not that legacy field. An equally dated release adds membership without
rewriting existing shared identity, address, taxonomy or status provenance. A newer observation
can update a shared identity, while other states' membership observations retain their own date
and provenance; those observations are not claims about the latest national location.
Weekly cutoffs are selected per state. Equal-date national deactivation events retain their
first status provenance rather than changing on each state import.
The importer retains omitted/redacted records as last-observed evidence.
They do not prove deletion, current practice, or non-participation. A redacted deactivation
row updates status without erasing prior identity/locations. A previously unseen redacted NPI is kept only when a published secondary practice location
establishes the state; identity fields remain null. Without that location evidence no state is inferred. An explicit deactivation report is stored and applied to observed identities;
a same-day or later reactivation takes precedence. `snapshot_id` traces identity/address/taxonomy
rows, and `status_snapshot_id` separately traces status. Bad NPI check digits are skipped with
`quality_issue`; malformed/version-mismatched input quarantines the snapshot and rolls back all
identity changes. Repeating a successfully imported bundle is a no-op. Import counters distinguish
read, kept, skipped and invalid rows; table counts are totals after each import.

Version 2 expanded field lengths; V1 and V2 can share column names, so a CSV header alone is
not proof of version. The importer requires an official V2 URL, the bundle's V2 README marker,
and the current required columns. Legacy headers (including `Provider Gender Code` in place
of current `Provider Sex Code`) are rejected. Names are unbounded SQL text, not V1-length fields.
The trusted fixture adapter is only for offline cuts; production always verifies the archive.

`providerByNpi(db,npi)` includes deactivated and formerly in-state identities, with status and
provenance. `providersNearZip(db,zip5,taxonomy?,state?)` matches exactly on practice ZIP5, returns each
NPI once with all locations, and optionally filters any published taxonomy and state membership. It includes explicit
deactivation status; clients choose whether to display it. It is not a radius search.

Regenerate the small real-data cuts after acquiring the CMS archives:

```sh
python3 tests/fixtures/nppes/regenerate.py
```

The generator verifies cache hashes, scans the source independently for raw TX counts, and writes
only published CSV columns/values. Synthetic test mutations (bad checksum, deactivation event,
truncated weekly file, legacy header) are explicitly named and never represented as real events.
See `tests/fixtures/nppes/provenance.json` for source hashes and selected NPI roles. CMS redacts
identity in deactivated monthly rows; the real cut includes a redacted NPI with published TX secondary
location evidence. A separately labelled synthetic event on another real identity checks that an
applied deactivation preserves previously observed identity and locations.

Real TX validation on 2026-11-07 used the November 2 V2 monthly and deactivation releases.
The PGlite file run read 9,891,116 main records, kept 628,644 and skipped 9,262,472, with no
invalid NPIs or quality issues. Of the retained NPIs, 13,895 qualify only through secondary
TX practices. Independent Python CSV counts matched every requested table exactly:

| Table | Rows | Table and index bytes |
|---|---:|---:|
| npi_provider | 628,644 | 195,051,520 |
| npi_taxonomy | 859,576 | 207,110,144 |
| npi_address | 1,384,496 | 421,044,224 |
| npi_deactivation (national status ledger) | 360,014 | 63,627,264 |

334 retained NPIs are deactivated and still available by NPI. Monthly import took 800.149 s;
deactivation took 6.759 s. The monthly ZIP is 1,130,479,129 bytes, and the file database uses
1,979,092 KiB on disk (including PostgreSQL files/WAL). The regenerated fixture bytes were
identical; the largest fixture is 19,270 bytes. Both offline CI and the repository gate passed.

The official linked weekly ZIP returned HTTP 404. The `all` runner therefore exited 1 while
preserving the successful monthly/deactivation imports; weekly application is verified offline.
The linked weekly cutoff precedes the monthly cutoff, so it would be superseded if restored.
The runner saves complete machine-readable import evidence under
`OPENPLANS_DATA_DIR/reports/p3a-nppes-validation.json`.
