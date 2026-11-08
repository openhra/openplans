# QHP discovery

After PUF acquisition and with `DATABASE_URL` configured:

```sh
npm run build
npm run worker -- ingest qhp discover --year 2026 --state TX
```

The command verifies the MR URL PUF snapshot in the newest P1a manifest, reads the
first XLSX worksheet, and selects the state's issuer rows. It retains only State,
Issuer ID and URL Submitted; contact columns are discarded. An unusable registry or
database fails the command. Publisher failures become individual `qhp_index.status`
values and do not fail the run. Exit zero means discovery finished, not that every
issuer was accessible. JSON output includes each issuer's statuses and child counts.

Index requests use a 30-second DNS/connect deadline and the fetcher's existing three-attempt
cap with exponential backoff and jitter. Child downloads retain the 10-second default.
HTTP 403 becomes `access_denied` after one attempt; its index metadata retains the safe
fetch evidence and explicit `unknown` provider/drug statuses. This neither activates a
source nor establishes a negative coverage result. Set `OPENPLANS_PROJECT_URL` to the
public project homepage for the honest fetcher identity (default:
`https://plans.openhra.com/`). JSON requests send `Accept: application/json, */*;q=0.1` (some publishers answer 406 to a strict JSON-only Accept, e.g. issuer 66252 serves its index as text/plain).

`qhp_index` retains the registry snapshot/row, issuer/year/state, fetched index snapshot,
status, PUF hosts and index-child hosts separately. `qhp_child_url` records every distinct
advertised child and its kind, index snapshot, delegated host, status and optional download
snapshot. Original HTTP child URLs are retained in `published_url`; requests use only the
same host/path over HTTPS. Unexpected redirect hosts remain blocked. No provider file is
requested. Only issuer 76589's plan and formulary children are downloaded in this lane.

Query values are redacted in persisted URLs. `url_sha256` hashes the original child URL
so distinct query shards remain distinct. Query-bearing URLs are not conditionally matched
against a redacted cache URL. Discoveries retain all submitted resources without guessing
which are shards or superseded versions. Published year/update/version metadata is kept;
plan-year membership still requires the plan adapter.

Discovery is not publication. Index snapshots are PARSED (or QUARANTINED for invalid JSON);
downloaded children remain FETCHING until an adapter validates them. Index snapshot
expected/fetched child counts include the unrequested provider children. Nothing becomes
ACTIVE, and an unavailable feed never establishes a negative coverage result.

A developer runner can use portable SQL without Docker/PostGIS:

```sh
node dist/ingest/qhp/discover-pglite.js ingest qhp discover --year 2026 --state TX
```

It uses `OPENPLANS_DATA_DIR` for the database (`qhp-pglite-discovery-<year>-<state>`), downloads and
`reports/qhp-discovery-<year>-<state>.json`. Each report includes only that discovery's records.
It omits only the PostGIS extension migration in a temporary
copy of the migration directory; the production worker uses all migrations.

To reproduce the P2e failed-issuer diagnosis using the cached 2026/2027 registries:

```sh
node dist/ingest/qhp/discover-diagnose.js
```

This makes one plain HTTPS GET per distinct failed-issuer index and host root, with
certificate verification, public-address checks, the honest client identity and the same
redirect-host restrictions. It records DNS, negotiated TLS on responses, redirect hops,
selected headers and relevant root-page links in `reports/p2e-discovery-diagnosis.json`.
Root HTML is processed in bounded memory and discarded. No alternate URL is substituted
into discovery; a changed 2027 PUF URL is evidence to review, not proof of 2026 membership.

## Readers and limits

- `streamZipMember` supports stored/deflated ZIP and ZIP64. It reuses archive structural
  checks, enforces actual output bytes and expansion relative to inflater input actually
  consumed (padding cannot disguise a bomb), and verifies inflated length and CRC. Exhaust
  the iterator to verify the complete member. Early cancellation closes streams.
- `readXlsxRows` reads workbook relationships, bounded shared strings and the first worksheet
  as streamed XML tokens/rows. Strings and raw cached values remain strings. It never
  evaluates formulas or interprets styles/dates. DTDs, external entities and external worksheet
  relationships are rejected. Defaults: 32 MiB total inflated XML, 100,000 shared strings/rows,
  1,024 columns, 1 MiB per cell/token, depth 64. This is a registry reader, not a general Excel
  implementation.
- `readJsonArray` yields one value at a time from a root array or a direct named property of a
  root object. Defaults: depth 64 (including the envelope), 8 MiB per element, 20 million
  elements. Ancillary root-object values use the same size/depth bound. The full input,
  including text after the selected array, is validated when exhausted. A `},` EOF yields
  complete preceding elements then throws `JsonStreamError('truncated')`. Callers must exhaust
  the iterator and quarantine partial results on error. `readJsonValue` shares these guards
  for small bounded index documents (discovery uses 4 MiB and depth 32).

## Offline controls and real evidence

`tests/ingest/json`, `tests/ingest/xlsx` and `tests/ingest/qhp/discover.test.ts` run in CI.
They exercise a Sanford-shaped synthetic truncated tail, an error-swallowing mutant,
depth/size/count limits, dishonest ZIP headers and padding, CRC corruption, HTML index
responses, blocked addresses/redirects, query shard identity and downstream continuation.

Regenerate synthetic security fixtures with:

```sh
node tests/fixtures/qhp/generate.mjs
node tests/fixtures/json/generate.mjs
```

Regenerate the small real TX registry cut from the shared P1a snapshot, without contact
columns, with `python3 tests/fixtures/qhp/regenerate.py`. Its provenance records archive,
workbook and fixture hashes. No network or large real files are needed for CI.

Real-run reports remain in the external cache: `p2b-qhp-discovery.json`,
`p2b-cigna-stream-validation.json`, and `p2b-cigna-tar.json`. The latter hashes only the
requested tar member using a streamed read; it does not extract the archive.
