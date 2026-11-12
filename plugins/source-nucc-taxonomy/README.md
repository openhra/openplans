# NUCC provider taxonomy

`@openplans/source-nucc-taxonomy` is the feed source behind `worker ingest taxonomy`. The core
plugin loads it, so it needs no entry under `plugins` in the configuration. Adding one is
refused, because its command would repeat a core command.

NUCC display names are **off by default**. `worker bootstrap --with-providers` and
`--with-geocode` keep NPPES taxonomy codes and issuer participation without fetching or
importing the NUCC dataset. Dry-run reports the taxonomy step as `status: skipped` with
`reason: opt_in_required`. No environment variable turns this import on.

Review the [NUCC terms page](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57)
and obtain any licence your use requires before opting in. NUCC says commercial use,
including selling or licensing products that use the code set, needs a NUCC licence. The
software licence grants no rights to this dataset, and passing a flag does not obtain one.

Add `--with-nucc-taxonomy` to bootstrap to accept responsibility for meeting those terms and
turn the import on. It works alone or alongside `--with-providers`:

```sh
worker bootstrap --states TX --years 2026 --with-providers --with-nucc-taxonomy
worker ingest taxonomy --accept-nucc-terms
```

## Access

The shipped access manifest holds `www.nucc.org` as `terms-restricted`. Until an operator
manifest (`OPENPLANS_ACCESS_MANIFEST`) clears the host after the operator's own terms review,
`worker ingest taxonomy --accept-nucc-terms` stops before it opens the database. It prints one
line on stderr with the manifest's reason and exits 1:

```json
{"source":"nucc-provider-taxonomy","code":"feed_run_failed","reason":"fetch_admission_denied","detail":"Publisher host is held by its reviewed manifest (terms-restricted)"}
```

The check runs only when the command runs, so a plain install still starts the API and worker.

## What a run does

The command runs on the core feed lifecycle (design 5.10.1). `plan` reads the
[NUCC CSV page](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57)
and picks the first `Version NN.N` link to a `nucc_taxonomy_NNN.csv` file. Each release has its
own URL, so the plan asks for the content-addressed cache (`cache: "content"`). The core keeps
the CSV at `OPENPLANS_DATA_DIR/raw/nucc-provider-taxonomy/<sha256>/payload`, and if that
directory already holds the URL, it reuses the copy instead of downloading it again. The core
fetches the CSV through the run's admission session and records a run receipt snapshot.
`stage` then writes, inside the core's transaction:

- the `nucc-provider-taxonomy` source row (kind `taxonomy`);
- an ACTIVE snapshot named by the CSV's SHA-256, with the NUCC version in `schema_version`;
  a release imported before keeps its row;
- every code in `provider_taxonomy`, replacing the previous release's codes, each pointing at
  that snapshot, so row provenance names the release.

On success stdout carries one JSON line: `version`, `source_url`, `snapshot_id` (the CSV's
SHA-256) and `codes`. A bad header, an invalid code or an empty file fails the run. The core
then quarantines the run receipt with the reason, and the previous release keeps serving.

## Responses

After import, provider responses include the NUCC display name, classification and
specialization alongside `taxonomy_status`. Each taxonomy entry carries its NPPES `code`, a
nullable `display_name` (also `taxonomy_display_name`) and a `taxonomy_source`, which is `nucc`
for a matched name and `nppes_code_only` otherwise. Codes missing from the loaded NUCC version have null
names and `unknown_code` status. An empty or absent taxonomy table gives the same code-only
response. The API never infers display names from codes.

`/v1/providers?taxonomy=207Q00000X` and `?specialty=207Q00000X` search exact codes without NUCC.
A specialty name search needs loaded taxonomy. It then searches NUCC names case-insensitively
along with issuer specialty text. Without taxonomy it returns HTTP 422 with
`error.code: unsupported_without_taxonomy`, even when the location or coverage would match
nothing. The compatibility API keeps the codes, nullable names and source note and passes this
error through. Imported names stay available on later bootstraps. Leaving out the opt-in flag
skips further imports and does not delete data already loaded.

## Attribution

Health Care Provider Taxonomy Code Set, maintained by the National Uniform Claim Committee
(NUCC), copyright American Medical Association. NUCC's CSV page states that commercial use,
including sales or licensing, requires a licence obtained from NUCC. Check and meet the
publisher's current terms before commercial redistribution. The dataset is versioned, and this
import is not evidence of licensing, credentialing or scope of practice.

## Tests

`tests/taxonomy.test.ts` runs the command on PGlite with a synthetic files page and the
committed fixture, a small cut of the official CSV. Regenerate the fixture after fetching the
source:

```sh
python3 tests/fixtures/taxonomy/regenerate.py
```
