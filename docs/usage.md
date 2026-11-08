# OpenPlans

## Name

OpenPlans is the project name in prose. Package, CLI, path, environment-variable
and other technical identifiers keep their defined forms.

Self-hosted, open-source health-plan data service built from CMS plan files,
Census geography, NPPES provider identities, NLM RxNorm and issuer QHP files.
It serves a native HTTP API for plan search, premium estimates, drugs, providers
and data availability, backed by PostgreSQL 16 and PostGIS. Texas PY2026 and
PY2027 catalogs and per-member medical premiums are implemented; issuer feed
completeness varies. Read `/v1/data-availability` before relying on an answer.
A fresh database is empty: load public-source snapshots before searching.

Every result keeps its source evidence. Missing evidence stays `unknown`, not
"not covered". Optional [compatibility API routes](#optional-compatibility-api)
adapt the native API for existing clients. No proprietary health-plan API is
called. The CMS Marketplace API is a possible future live-data integration,
not a dependency of the current service.

## Run with Docker

Requires Docker with Compose v2 and a cache directory visible to Docker. From this
folder, do the one-time setup:

```sh
cp .env.example .env
# Replace the placeholder database credentials and both API tokens in .env.
export OPENPLANS_DATA_DIR="$HOME/.local/share/openplans"
mkdir -p "$OPENPLANS_DATA_DIR/raw" "$OPENPLANS_DATA_DIR/reports" "$OPENPLANS_DATA_DIR/work"
```

Then one command builds the image, starts Postgres and the API, and loads your
chosen states and years:

```sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --build --rm worker bootstrap --states TX,FL --years 2026,2027
```

For a small first run use `--states DE --years 2026`. Check the instance with
`curl http://127.0.0.1:3000/healthz` and
`curl 'http://127.0.0.1:3000/v1/plans?zip=19801&year=2026'` for DE. Read
`/v1/data-availability` for actual coverage. The API and DB keep running after the
worker exits. The same bootstrap command resumes interrupted imports and skips
current ACTIVE snapshots. Its last JSON line lists completed, skipped, failed
and dependency-blocked steps; a failure returns exit 1 while independent work
continues. Downloads use public sources; no CMS API key is needed.

Append `--with-drugs` for RxNorm and issuer formularies, `--with-providers` for
NPPES taxonomy codes and issuer participation, or `--with-geocode` to also include
provider inputs and Census address geocoding. NUCC display names are off by default.
To enable them, review [NUCC's terms](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57),
obtain the licence NUCC requires for commercial use, and append `--with-nucc-taxonomy`.
For a standalone import use `worker ingest taxonomy --accept-nucc-terms`. These
flags acknowledge operator responsibility; they do not obtain a licence. Without
that import, responses retain NPPES codes with `display_name: null` and
`taxonomy_source: nppes_code_only`. Search by code works; specialty name search
returns `unsupported_without_taxonomy`. See the [taxonomy guide](../src/ingest/taxonomy/README.md).
Provider identity enrichment supports multiple states; geocoding supports **TX only**.
Issuer access restrictions and incomplete feeds remain explicit gaps and can make
the optional bootstrap return exit 1. See [self-hosting](self-host.md) for
measured sizes/times, these limits, source terms, updates and backups.

Preview the dependency plan without opening a database, downloading or writing:

```sh
docker compose run --build --rm --no-deps worker bootstrap --states TX,FL --years 2026,2027 --dry-run
```

The plan shows observed artifact sizes from cache metadata, or `unknown`; shared
national files may appear in several steps and these are not incremental network
byte estimates. An empty cache therefore reports unknown sizes.

Export the cache path again in later shells or save it in `.env`. Acquisition
needs writable `raw/`; `OPENPLANS_RAW_READ_ONLY=false` applies only to the bootstrap
invocation above. Later import-only commands retain the read-only default. On
Linux, make all three directories writable by the image's `node` user (UID 1000).
On macOS, put the cache in a shared home directory or configure the Docker VM to
share it. See [.env.example](../.env.example) for configuration. Connection URL
credentials must be URL-safe (percent-encode reserved characters).

Both ports bind to `127.0.0.1`. `API_PORT` and `DB_PORT` avoid local conflicts.
The default project is `openplans-local`; use `docker compose -p openplans-name`
consistently to isolate an instance. `OPENPLANS_IMAGE` optionally selects a
separate local API/worker image tag (default `openplans:local`).
`docker compose down` preserves the DB volume; `docker compose down -v` deletes it.
`worker status` prints the same manifest as `/v1/data-availability`. The API
applies migrations at startup; `worker migrate` is safe to repeat.

Set `OPENPLANS_API_TOKEN` in `.env` for personalized premium requests and send
`Authorization: Bearer <token>`. Missing/incorrect credentials return 401;
an unconfigured server token returns 503 (`AUTH_NOT_CONFIGURED`). Premium
responses use `Cache-Control: no-store`. The DB image installs PostGIS on native
arm64 or amd64 PostgreSQL 16; no emulation override is required.

## Load the cached Texas catalog

Set `OPENPLANS_DATA_DIR` in `.env` to an absolute cache directory outside the repo
(Docker default `/var/lib/openplans`). It must contain the acquired PUF
manifest/archives and Census/CMS geography snapshots; imports reuse their hashes
and never replace raw inputs. See the [PUF acquisition guide](../src/ingest/puf/acquire-README.md)
and [geography guide](../src/ingest/geo/README.md) for preparing the cache. The
`raw/`, `reports/` and `work/` directories must already exist.
The Docker daemon must see these directories; on macOS, enable file sharing for
the cache path in Docker Desktop or mount it into the Colima VM before starting it.
Compose mounts `raw/` read-only at `/data/raw`, with writable `reports/` and
`work/` at `/data/reports` and `/data/work`; the worker sees `OPENPLANS_DATA_DIR=/data`.
Acquisition needs a writable raw cache: run it natively with Node.js 22+ (see
below), or explicitly set `OPENPLANS_RAW_READ_ONLY=false` for the acquisition
command, then restore the read-only default for imports.

```sh
docker compose run --rm worker migrate
docker compose run --rm worker ingest rating-rules
docker compose run --rm worker ingest geo --state TX
docker compose run --rm worker ingest puf import --year 2026 --state TX
curl 'http://127.0.0.1:3000/v1/plans?zip=77002&year=2026'
```

The image includes versioned rules in `data/rating-rules/`. `worker ingest rating-rules`
records its cited, versioned rules; it also accepts `--file <path>`. Importing a
PUF alone leaves rating unsupported until a cited rule set is loaded. The cached
TX PY2026 data yields 121 individual medical plans for ZIP 77002, with 50 per page.
An authenticated `POST /v1/premium-estimates` with this JSON returns 52928 cents
for the monthly gross premium (no subsidy calculation):

```json
{
  "plan_ids": ["87226TX0100013"],
  "zip": "77002",
  "coverage_start": "2026-01-01",
  "members": [{ "age": 35, "tobacco": false, "relationship": "subscriber" }]
}
```

For PY2027, acquire that year's PUFs, import `data/rating-rules/2027.json` with
`worker ingest rating-rules --file /app/data/rating-rules/2027.json`, then import
PUFs with `--year 2027` and query with `year=2027`. See the
[native API guide](../src/api/README.md) for household inputs, benchmarks and
conditional subsidy estimates.

## Scope and limits

- Texas is the validated state. NY/VT community and family-tier rating is not
  implemented. Unsupported rating methods return `unsupported_rating_method`;
  the service does not substitute a federal default price.
- Estimates are not bindable quotes (`bindable_quote: false`). Enrollment,
  carrier acceptance and final eligibility require the appropriate marketplace
  or issuer. Gross premium, estimated credit and net premium are separate.
- CSR eligibility is not evaluated. Subsidy estimates require explicit household
  eligibility inputs; Medicaid/CHIP eligibility is not determined. Pediatric
  dental benchmark adjustments can leave a subsidy estimate unresolved.
- Off-exchange and state-exchange coverage is incomplete. Dental catalog data
  does not imply supported dental rating; vision search is unsupported.
- A Census ZCTA is not a postal ZIP. PO-box ZIPs without a ZCTA return unknown.
  Provider locations may be ZIP-level approximations. An NPI alone proves
  neither licensing nor network participation. Issuer evidence may be incomplete
  or stale; inspect completeness and provenance rather than inferring a denial.

## Sources and attribution

The application code uses [Apache-2.0](../LICENSE). Source datasets retain their
publishers' terms; public access alone is not a redistribution license. Keep
the original URL, version, retrieval time, hash and record references with
derived data and fixture cuts.

| Publisher / source | Used for | Terms and attribution |
| --- | --- | --- |
| [CMS Exchange PUFs](https://www.cms.gov/marketplace/resources/data/public-use-files) and CMS state rating-area tables | Plans, rates, benefits, service areas and issuer feed discovery | Attribute CMS and the file/year/version. Read the linked data dictionaries and [Data Disclaimer–User Agreement](https://www.cms.gov/files/document/data-disclaimer-user-agreementpdf), including the separate machine-readable URL disclaimer on the landing page. |
| [U.S. Census Bureau](../src/ingest/geo/README.md) ZCTA/county relationships, Gazetteer and geocoder | County resolution and provider-location evidence | Attribute the U.S. Census Bureau, product and vintage under its [public-use and citation guidance](https://www.census.gov/about/policies/citation.html). Preserve approximation flags. |
| [CMS NPPES V2 dissemination files](https://download.cms.gov/nppes/NPI_Files.html) | Published provider identities, taxonomies and addresses | Attribute CMS/NPPES and release date; retain the release README and dissemination guidance. An NPI does not validate licensure or credentials. See the [import guide](../src/ingest/nppes/README.md). |
| [NLM RxNorm Current Prescribable Content](https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html) | Drug names, RxCUIs, relationships and NDC mappings | The public subset needs no UMLS license. This importer retains RXNORM-source content; it does not import the licensed full release. Follow [NLM's terms and requested acknowledgement](https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html). |
| Issuer QHP machine-readable indexes and child files | Formulary and provider participation evidence | Attribute each issuer and snapshot URL. Follow that publisher's terms and access restrictions; no blanket redistribution permission is assumed. Blocked or incomplete downloads remain explicit gaps. |
| [CMS Marketplace API](https://developer.cms.gov/marketplace-api/) (future, optional) | Potential live shopping integration | Separate CMS access approval and key terms apply. CMS describes live application access, not bulk extraction; keys expire every 60 days. No key is required for current offline CI or PUF ingestion. |

RxNorm data courtesy of the U.S. National Library of Medicine (NLM). NLM is not
responsible for this product and does not endorse it. The linked terms give
NLM's complete requested acknowledgement. No publisher endorsement is implied.

## Optional compatibility API

The native API is `/v1/*`. The isolated module at `src/compat/v1/` exposes
`/compat/v1/*` using shapes checked against optional captured responses.
Set `OPENPLANS_COMPAT_API_KEY` in `.env`; clients send the `X-Api-Key`
header. Optionally set `OPENPLANS_COMPAT_KEY_HEADER` to one additional credential
header name (a single RFC 7230 token; invalid names prevent startup). Both headers
accept the same key. These settings are separate from the native bearer token. The facade
reports unsupported or unavailable fields through nulls and `x-openplans-gaps`.
Read the [facade guide](../src/compat/v1/README.md) for routes, defaults and gaps.

The reference-capture mock is only an optional external test oracle: point `OPENPLANS_REFERENCE_CAPTURES_DIR`
at an existing capture directory to run those comparisons. When unset, they
skip. Neither runtime nor standalone CI needs the reference-capture mock or proprietary credentials.

## Local development

Requires Node.js 22 or newer. Dependencies are pinned in the package and lockfile.

```sh
npm ci --no-audit --no-fund
npm run build
export DATABASE_URL='postgresql://openplans:replace_this_placeholder@127.0.0.1:5432/openplans'
npm run worker -- migrate
npm start
npm run worker -- status
```

The server reads `DATABASE_URL` and `PORT` (default `3000`); it does not load `.env`
itself. Compose loads `.env`. On connection failure `/healthz` responds HTTP 503
with `{"status":"ok","db":"down"}` and stays alive. Manifest queries return HTTP
503 on DB failure; failures never become an apparently empty coverage manifest.
Database errors and connection URLs are not exposed in responses or CLI errors.

## Checks

```sh
./scripts/ci.sh
./scripts/smoke.sh
./scripts/smoke.sh --full
./scripts/realdata.sh
```

CI needs no Docker or network. Prime npm's cache with `npm ci` once; when local
dependencies are missing, CI uses `npm ci --offline`. It typechecks source and
tests, checks extraction boundaries, builds with strict unused-code checks and
runs Vitest. It prints `PASS` only after every check succeeds. PGlite runs the
actual SQL migrations in process; **only `002_postgis.sql` is omitted from the
test copy**. Tests use small real source cuts with provenance and explicitly
labelled synthetic records or mutations. The unreachable
database test uses a nonexistent Unix socket, without TCP or external requests.

Plain smoke builds the images, starts PostGIS and the API, checks health, migrates
twice, and checks API/worker empty manifests, PostGIS and refusal of personalized
requests when the server token is unconfigured. It needs no real-data cache.
`--full` additionally imports cached rating rules, TX geography and TX PY2026 PUFs,
checks exact row counts and all three plan-search pages, and verifies the 52928-cent
premium. Missing/incorrect request bearer tokens must return 401; the configured
placeholder must succeed. A deliberately wrong database must fail import without
changing the active catalog or ACTIVE snapshot count. Stage wall times, DB size,
API evidence and worker reports are saved in
`$OPENPLANS_DATA_DIR/reports/h1-smoke-<UTC timestamp>/summary.json`.

Both smoke paths use only `.env.example` public placeholders, project
`openplans-h1` (override `OPENPLANS_COMPOSE_PROJECT` with an `openplans-` prefix),
API port `43081`, and DB port `45432`. Override the port variables if needed.
Smoke refuses an existing project's containers/volumes and removes everything it
starts, including its database volume, even on failure. Full smoke requires a
populated cache and writable `reports/`; it is opt-in and never runs in `ci.sh`.
Full smoke defaults to the same shared machine cache as the native ingesters;
export `OPENPLANS_DATA_DIR` to select another cache (it does not read `.env`).
Native tools default to `$HOME/.local/share/openplans`;
set `OPENPLANS_DATA_DIR` to override it: export the variable to your own
absolute cache directory before acquisition, fixture regeneration or real-data checks.
Image pulls and package downloads during the Docker build need network access.
`realdata.sh` compares cached public raw files with imported catalogs and filed
premiums for 2026 and 2027, including dental. It writes reports below the external
cache. See the [real-data check details](../scripts/oracle/README.md);
`--year 2026` or `--year 2027` selects one year. A passing fixture suite does not
validate every issuer, state or live marketplace quote.

The tests include failing-migration and external-import negative controls. To
verify CI rejects a deliberately failing test in a disposable package copy:

```sh
./scripts/negative-controls.sh
```

Public releases use committed trees. Maintainers can run
`scripts/export-public.mjs <ref> <dest>` from the source checkout; see
[the export guide](public-export.md). Local development and data-provenance
rules are in [CONTRIBUTING.md](../CONTRIBUTING.md). The
[standalone CI workflow](../.github/workflows/ci.yml) runs the same offline checks.

## Data and migrations

The schema records sources, immutable snapshot provenance, snapshot states
(`DISCOVERED`, `FETCHING`, `PARSED`, `VALIDATED`, `RECONCILED`, `ACTIVE`,
`QUARANTINED`), quality issues and explicit coverage entries. An `ACTIVE` snapshot
must have a hash, retrieval/activation times and a complete declared child set.
PUF ingestion validates and reconciles before publishing the active catalog pointer;
a failed set cannot replace it. Coverage rows contain state, plan
year, market, optional issuer, four evidence statuses and a source snapshot ID.
Missing evidence defaults to `not_yet_verified`; ingestion must preserve `unknown`
for incomplete provider or formulary evidence. No coverage is inferred or seeded.

Add immutable numbered plain SQL files to `migrations/`. A migration run locks the
journal and applies the entire pending batch and its records in one transaction.
A failure rolls back the batch. Repeated runs are no-ops. Changed or missing
applied SQL and duplicate numbers are rejected. Previously unapplied lower-numbered
migrations merged from another branch are applied in numeric order. Fix forward
by adding a migration. PostGIS is enabled separately.

All build and runtime dependencies stay inside this directory so it can become
an independent repository. The extraction checker validates static/dynamic
imports, module-relative URLs, local package dependencies, TypeScript project
paths and symlinks. Internal parent-directory imports are allowed only when they
resolve inside this package. Existing research documents describe external data
locations and are not runtime dependencies.

Licensed under the full, unmodified Apache License 2.0 in [LICENSE](../LICENSE).
