# Configuration and command reference

Native Node entry points read the process environment. They do not load `.env`.
Compose reads `.env` for interpolation and forwards only variables listed under
that service's `environment`. Adding a variable to `.env` alone does not pass it
into the container. Use `docker compose run --rm -e NAME=value worker ...` for a
one-off worker option. For an API option absent from `compose.yml`, add it to the
API service in a local Compose override and recreate the service.

[.env.example](../.env.example) lists placeholders, including native developer
options. Keep credentials in local environment files. See [self-hosting](self-host.md)
for publisher reviews, cache mounts, backups and proxy configuration.

## Database, listener and cache

| Variable                                            | Default or requirement                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Required Compose interpolation. Replace the example credentials.                                  |
| `DATABASE_URL`                                      | Required by the native API, worker and stdio server. Compose constructs it for the container.     |
| `PORT`, `HOST`                                      | Native API defaults `3000`, `127.0.0.1`. Compose sets `3000`, `0.0.0.0` inside its API container. |
| `API_PORT`, `DB_PORT`                               | Host ports `3000`, `5432`, published only on loopback.                                            |
| `OPENPLANS_IMAGE`                                   | Compose API/worker image, `openplans:local`.                                                      |
| `OPENPLANS_DB_MEMORY`                               | Compose database budget `1g`, whole m/g units, `512m` to `256g`.                                  |
| `OPENPLANS_API_CACHE`                               | On unless exactly `off`. Applies to both cache backends.                                          |
| `OPENPLANS_API_CACHE_MB`                            | Local response-cache cap, `64` MiB.                                                               |
| `OPENPLANS_CACHE_URL`                               | Unset. Selects shared Redis-compatible storage instead of local LRU.                              |
| `OPENPLANS_CACHE_MEMORY`                            | Compose Valkey cap `256mb`; start the `cache` profile too.                                        |

## Access and optional sources

| Variable                                 | Default and effect                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENPLANS_PUBLIC_QUOTING`               | `on`. `off` disables `/v1/quotes` and MCP `quote_plans`.                                                                                 |
| `OPENPLANS_PUBLIC_HOUSEHOLD`             | `on`. Anonymous household REST and MCP access when their respective token is unset.                                                      |
| `OPENPLANS_API_TOKEN`                    | Unset. If set, requires a bearer token for household REST routes, benchmark and ICHRA.                                                   |
| `OPENPLANS_PUBLIC_COMPAT`                | `on`. Anonymous compatibility access when no compatibility key is set.                                                                   |
| `OPENPLANS_COMPAT_API_KEY`               | Unset. If set, requires `X-Api-Key` or the configured extra credential header.                                                           |
| `OPENPLANS_COMPAT_KEY_HEADER`            | Unset. One additional RFC 7230 token header name; invalid values prevent startup.                                                        |
| `OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE` | Off. `on` filters catastrophic plans for applicants aged 30 or older unless exempted.                                                    |
| `OPENPLANS_COMPAT_BENEFIT_TEXT`          | Full cells. `compact` selects short compatibility benefit phrases.                                                                       |
| `OPENPLANS_CMS_FALLBACK`                 | Off. `on` admits keyed CMS requests and enables coverage fallback with a key.                                                            |
| `OPENPLANS_CMS_FALLBACK_QUOTES`          | Off. `on` also allows coverage calls for public REST quotes and compatibility medical search; requires the main fallback switch and key. |
| `CMS_API_KEY`                            | Unset. Enables eligible live ZIP-county lookups; coverage also needs its opt-in switches. No key is needed for bulk imports.             |
| `OPENPLANS_MEDICARE_PART_D`              | Off. `on` serves loaded Part D drug and pharmacy data after the operator reviews its agreement.                                          |
| `OPENPLANS_GA_QUOTE_RECOVERY`            | Off. `on` permits the documented Georgia CSV quote recovery and records a warning per recovered row.                                     |

Public access switches accept `on`, `off` or empty. Empty means on; other values
fail. A configured REST/MCP token or compatibility key still grants access with
the corresponding public switch off. Credentials for one protocol do not grant
access to another. NUCC taxonomy has no enabling environment variable; the
operator must pass its explicit command-line opt-in.

## MCP tools

With default access, the server lists these 15 tools:

| Tool                        | What it reads or calculates                      |
| --------------------------- | ------------------------------------------------ |
| `search`                    | Search across public entities.                   |
| `fetch`                     | Read an entity and a selected section.           |
| `lookup_geography`          | Resolve ZIP and county evidence.                 |
| `search_plans`              | Search the loaded plan catalog.                  |
| `get_plan`                  | Read one plan and its evidence.                  |
| `quote_plans`               | Quote ages and a location without income.        |
| `quote_premiums`            | Quote a household, with optional subsidy inputs. |
| `check_ichra_affordability` | Calculate ICHRA affordability from cited rules.  |
| `search_providers`          | Search loaded provider identities and addresses. |
| `check_provider_network`    | Read provider participation evidence.            |
| `search_drugs`              | Search loaded drug terminology.                  |
| `check_drug_coverage`       | Read plan formulary evidence.                    |
| `get_data_status`           | Read data availability and limitations.          |
| `list_carriers_networks`    | List loaded carriers and networks.               |
| `search_medicare_plans`     | Search loaded Medicare catalogs.                 |

| Variable                           | Default and effect                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENPLANS_MCP`                    | On unless `off`, which removes HTTP `/mcp`.                                                                                                         |
| `OPENPLANS_MCP_TOKEN`              | Unset. If set, HTTP household tools require this bearer token.                                                                                      |
| `OPENPLANS_MCP_ALLOW_PERSONALIZED` | Stdio only. `1` grants household tools; `0` withholds them. Unset inherits anonymous household access and withholds tools when an MCP token is set. |
| `OPENPLANS_MCP_CURSOR_SECRET`      | Random per process. Set a shared private value across replicas for stable cursors.                                                                  |
| `OPENPLANS_MCP_ALLOWED_HOSTS`      | Loopback names `127.0.0.1`, `localhost`, `[::1]`, with and without `:PORT`. Exact comma-separated authorities.                                      |
| `OPENPLANS_MCP_ALLOWED_ORIGINS`    | `http://localhost:PORT`, `http://127.0.0.1:PORT`, `http://[::1]:PORT`. Exact comma-separated origins.                                               |
| `OPENPLANS_TRUST_PROXY`            | Empty. Only listed exact socket peers may supply forwarded client addresses.                                                                        |

## Downloads and geocoding

| Variable                                                                                       | Default and effect                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENPLANS_DATA_DIR`                                                                           | Native `$HOME/.local/share/openplans`; Compose host mounts default to `/var/lib/openplans`, seen as `/data` in the worker. Keep it outside Git.                                 |
| `OPENPLANS_RAW_READ_ONLY`                                                                      | Compose `true`. Set `false` for acquisition commands that write raw inputs.                                                                                                     |
| `OPENPLANS_ACCESS_MANIFEST`                                                                    | Unset. An operator manifest layers over the shipped publisher reviews.                                                                                                          |
| `OPENPLANS_SHIPPED_ACCESS`                                                                     | On unless `off`, which removes shipped manifests.                                                                                                                               |
| `OPENPLANS_PROJECT_URL`                                                                        | `https://plans.openhra.com/`, used in the fetcher identity.                                                                                                                     |
| `OPENPLANS_EGRESS_COUNTRY`                                                                     | Unset. Records the collection country; does not authorize access.                                                                                                               |
| `OPENPLANS_EGRESS_FILE`, `OPENPLANS_EGRESS_SHA256`                                             | Unset. A bound egress record requires its exact hash, an open validity window and matching declared countries.                                                                  |
| `OPENPLANS_GEOCODER_URL`, `OPENPLANS_GEOCODER_KEY`                                             | Unset. Optional operator URL template and key. No URL means no operator request.                                                                                                |
| `OPENPLANS_GEOCODER_LAT_PATH`, `OPENPLANS_GEOCODER_LON_PATH`, `OPENPLANS_GEOCODER_COUNTY_PATH` | `latitude`, `longitude`, `county_fips`. Dot-separated JSON paths may include array indexes.                                                                                     |
| `OPENPLANS_GEOCODER_INTERVAL_MS`                                                               | `1000`, minimum `1000` ms.                                                                                                                                                      |
| `OPENPLANS_GEOCODER_STORE`                                                                     | Off. `1` permits external storage when the operator's provider terms allow it. Serving stored points also requires `OPENPLANS_API_CACHE=off`.                                   |
| `OPENPLANS_OPEN_GEOCODER_URL`                                                                  | Unset. Optional self-hosted Nominatim on a literal loopback IP.                                                                                                                 |
| `OPENPLANS_GEOCODER_STATE`, `OPENPLANS_GEOCODER_SNAPSHOT`, `OPENPLANS_GEOCODER_PORT`           | Regional deployment requires a state `tx`, `fl` or `nc` and an explicit `YYMMDD` snapshot; port defaults to `58080`. See the [geocoder guide](../src/ingest/geocode/README.md). |

## Native developer and check runners

These options are read by the named developer programs, not the standard worker.
Paths and generated reports stay in the external data cache unless overridden.

| Variable                                               | Reader and default                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENPLANS_PGLITE_DIR`                                 | `npm run api:pglite`, required absolute DB path. Its default `PORT` is `3001`.                                                |
| `OPENPLANS_PUF_DB`                                     | `worker:puf:pglite`, cache `puf-pglite-p1d` or `puf-pglite-all-states` when `--all-states` is present.                        |
| `OPENPLANS_FORMULARY_DB`, `OPENPLANS_FORMULARY_REPORT` | `formulary-pglite.js`, cache DB `formulary-pglite-p2c` and report `p2c-formulary-realdata.json`.                              |
| `OPENPLANS_PROVIDER_DB`                                | `provider-pglite.js`, cache DB `provider-pglite-p3b`.                                                                         |
| `OPENPLANS_QHP_DB`                                     | `formulary-all-pglite.js`, cache DB `qhp-pglite-p6a`.                                                                         |
| `OPENPLANS_QHP_DATABASE_URL`                           | Postgres QHP batch/audit scripts, required explicit loopback connection URL.                                                  |
| `OPENPLANS_QHP_CATALOG_DB`                             | Postgres formulary runner, cache `puf-pglite-p1d` for TX 2026, otherwise `puf-pglite-p6d-YEAR-STATE`.                         |
| `OPENPLANS_QHP_MIGRATIONS_DIRECTORY`                   | Postgres formulary runner, bundled migrations.                                                                                |
| `OPENPLANS_QHP_STATE`, `OPENPLANS_QHP_YEAR`            | Postgres state runners, `TX`, `2026`.                                                                                         |
| `OPENPLANS_QHP_ISSUER`                                 | Formulary batch runners, unset processes the eligible issuer set.                                                             |
| `OPENPLANS_QHP_ENRICHMENT`                             | Postgres formulary runner, off; `1` adds enrichment.                                                                          |
| `OPENPLANS_QHP_RESUME`                                 | Formulary batch runners, off; `1` uses the prior batch checkpoint.                                                            |
| `OPENPLANS_QHP_RUN_BUDGET_MS`                          | Formulary runner budget, Postgres `1800000`, PGlite `3000000` ms.                                                             |
| `OPENPLANS_QHP_REPORT_PREFIX`                          | Runner-specific: `p6a-postgres`, provider audit `p6c`, state audit `qhp-state-year` with lowercase state.                     |
| `OPENPLANS_REFERENCE_CAPTURES_DIR`                     | Optional external regression fixture directory. Checks needing it skip when unset.                                            |
| `OPENPLANS_DENYLIST_FILE`                              | Publication checks, external nonempty regex policy. Unset contributor CI skips the optional policy audit; export requires it. |

Docker smoke checks use `OPENPLANS_COMPOSE_PROJECT`, default `openplans-h2`,
and `OPENPLANS_SMOKE_TMPDIR`, default `$HOME/.cache`. Use a project beginning with
`openplans-` and a Docker-visible scratch path. Set `OPENPLANS_PUBLIC_HOUSEHOLD=off`
for the smoke authentication control, as shown in the [package README](../README.md).

## Worker commands

Run `npm run worker --` before these arguments on a native installation, or
`docker compose run --rm worker` in Compose. Most worker commands print usage and
exit 1 for `--help`; the worker has no general help subcommand. Guides below name
required cache inputs and source-access limits.

| Arguments                                                                                                                                                                                                                                                                  | Guide                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap --states TX,FL --years 2026,2027 [--with-drugs] [--with-providers] [--with-geocode] [--with-nucc-taxonomy] [--qhp-cache-only] [--qhp-profile PATH] [--dry-run]`                                                                                                 | [Bootstrap and options](self-host.md#options-and-completion). SBE-only scopes may omit years to select 2026.                                                                                                                                                  |
| `migrate [--check]`, `status`                                                                                                                                                                                                                                              | [Migrations](migrations.md), [availability](self-host.md#reading-availability).                                                                                                                                                                               |
| `backfill row-provenance [--table NAME] [--blocks N]`                                                                                                                                                                                                                      | [Row provenance](row-provenance.md).                                                                                                                                                                                                                          |
| `record-policy list`, `record-policy set NAME --ttl INTERVAL [--stale INTERVAL]`, `record-policy expire NAME [--before TIMESTAMP]`                                                                                                                                         | [Record policies](record-policy.md).                                                                                                                                                                                                                          |
| `ingest puf acquire [--year 2025\|2026\|2027] [--dry-run]`, `ingest puf import --year YEAR (--state ST \| --all-states)`, `ingest puf lineage --year 2026\|2027`                                                                                                           | [PUF acquisition](../src/ingest/puf/acquire-README.md), [catalog import](../src/ingest/puf/import-README.md). Acquisition without a year selects 2026 and 2027; import also accepts 2025. Acquisition dry-run reads the landing page and may write its cache. |
| `ingest sbe acquire\|import --year 2026\|2027 (--state ST \| --all-states)`                                                                                                                                                                                                | [State-exchange bundles](../src/ingest/sbe/README.md). Publication availability limits each year.                                                                                                                                                             |
| `ingest state --state NY\|VT --file /absolute/path/to/prepared-2026.json`                                                                                                                                                                                                  | [Filed family tiers](../src/ingest/state/README.md).                                                                                                                                                                                                          |
| `ingest rating-rules [--file PATH]`                                                                                                                                                                                                                                        | [Rating rules](../data/rating-rules/README.md). Default file is the TX rule set.                                                                                                                                                                              |
| `ingest geo [--year 2026\|2027] [--state ST \| --all-states]`, `ingest geo --source geonames`                                                                                                                                                                              | [Geography](../src/ingest/geo/README.md). Defaults TX 2026. GeoNames acquisition remains held.                                                                                                                                                                |
| `ingest qhp discover --year YEAR --state ST`, `ingest qhp providers\|formulary --year YEAR --state ST (--issuer NNNNN \| --all-readable)`                                                                                                                                  | [Discovery](../src/ingest/qhp/discover-README.md), [providers](../src/ingest/qhp/provider-README.md), [formularies](../src/ingest/qhp/formulary-README.md).                                                                                                   |
| `ingest nppes --state ST [--kind full\|weekly\|deactivation\|all]`, `ingest rxnorm`, `ingest taxonomy --accept-nucc-terms`                                                                                                                                                 | NPPES defaults to all three update kinds. [NPPES](../src/ingest/nppes/README.md), [RxNorm](../src/ingest/rxnorm/README.md), [taxonomy](../src/ingest/taxonomy/README.md).                                                                                     |
| `ingest geocode [--state TX] [--county FIPS] [--zips ZIP,ZIP] [--source npi_address\|qhp_provider_address]`                                                                                                                                                                | [Census and optional geocoders](../src/ingest/geocode/README.md). This legacy command accepts TX counties only and defaults to both address sources. Bootstrap uses the statewide geocoder and accepts all 50 states and DC.                                  |
| `ingest medicare acquire\|import --year 2026\|2027 [--family landscape\|pbp\|stars\|crosswalk\|service_area] [--service-area-month YYYY-MM]`, `ingest medicare part-d acquire --url URL`, `ingest medicare part-d import --kind quarterly\|monthly [--tables TABLE,TABLE]` | [Medicare](medicare.md).                                                                                                                                                                                                                                      |
