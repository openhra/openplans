# CMS Exchange PUF acquisition

Build with `npm run build`, then run:

```sh
npm run worker -- ingest puf acquire
npm run worker -- ingest puf acquire --year 2026
npm run worker -- ingest puf acquire --year 2027 --dry-run
```

Downloads use `src/fetch/` and `OPENPLANS_DATA_DIR` (the project's shared external cache by
default). No database is required. The fetcher also saves the landing page as a raw snapshot. Discovery
uses explicit year sections and advertised ZIP hrefs; it never derives an unpublished URL.
Unrecognized labels can fall back to an advertised filename. When candidates conflict, discovery
reports `discovery_conflict` instead of choosing one.

Normal runs write `raw/cms-exchange-puf/manifest-<ISO-date-time>.json`, preserving earlier
runs. Each file records its year, kind, advertised URL, snapshot ID, SHA-256, archive bytes,
member sizes/formats and CSV headers. Publisher/HTTP provenance lives in the immutable
snapshot sidecars. Conditional requests check for republications; a 304 re-verifies the
cached hash, and equal downloaded bytes reuse the existing snapshot.

`--dry-run` snapshots and discovers the landing page only: it downloads no archives and
writes no manifest. Its JSON has `dry_run: true`; an `ok` file means its link was discovered,
with null acquisition fields. A missing year or file has `not_published` and no guessed URL.
Download/inspection failures record a stable fetch error code, allow the remaining files
to finish, and make the command exit nonzero after saving the manifest.

The command inspects ZIPs without extraction. CSV header inflation stops at the first physical
line and is bounded to 64 KiB. The command identifies XLSX files but does not parse them. A CSV without
`PlanId` or `StandardComponentId` gets a `missing_plan_identifier` member observation;
issuer-level files and crosswalks may legitimately use other keys, so this alone does not
change a successful download status. Acquisition does not import or activate catalog data.

Offline checks: `npx vitest run tests/ingest/puf/acquire.test.ts`. Fixture regeneration is
documented in `tests/fixtures/puf/acquire/generate.mjs`; pass an existing landing snapshot
payload. The fixtures contain only the real PY2026/PY2027 sections and a labeled synthetic
mutant, without contact details.
