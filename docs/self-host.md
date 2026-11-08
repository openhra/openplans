# Self-hosting OpenPlans

Run commands from the package directory containing compose.yml. Docker with
Compose v2 is sufficient; host Node.js and a CMS API key are not required. Follow
the [quickstart](../README.md#run-with-docker) to configure credentials and create
a Docker-visible cache, then run:

~~~sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --build --rm worker bootstrap --states DE --years 2026
~~~

The command builds the image, starts healthy Postgres/API dependencies, loads
cited rating rules, validates bundled subsidy parameters, acquires/imports PUFs,
and loads Census/CMS geography. The API remains running after ingestion. Use
--states TX,FL --years 2026,2027 for multiple catalogs. Only these publication
years are currently supported. A state absent from the publication fails
explicitly; it does not become an empty supported catalog.

## Options and completion

| Option | Adds | Existing implementation limits |
| --- | --- | --- |
| No optional flags | Catalog, filed premiums, geography and bundled subsidy parameters | Public PUF coverage and cited state rules determine support. State exchanges need separate adapters. Subsidies remain conditional estimates. |
| --with-drugs | Public RxNorm CPC, issuer discovery and all-readable formularies | Incomplete or blocked feeds stay unknown and can make the batch exit 1. |
| --with-providers | NPPES full/weekly/deactivation codes, discovery and participation | NPPES memberships are state-scoped, so several states share one database (P6h); a step that would overwrite another state's rows still fails. |
| --with-nucc-taxonomy | Optional NUCC specialty display names (also usable without --with-providers) | Explicit acceptance of operator responsibility for NUCC terms; commercial use requires a NUCC licence. |
| --with-geocode | Provider inputs above, then incremental Census batch geocoding | Currently TX only. Other states fail explicitly; no TX points are substituted. |
| --dry-run | Dependency plan and observed artifact sizes | No database, network, ingestion or writes. Unknown sizes stay unknown. |

NUCC taxonomy is off by default, including with --with-providers or --with-geocode.
No environment variable enables it: opt in on the command line with
--with-nucc-taxonomy after reviewing the [NUCC terms](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57)
and obtaining any required licence. NUCC requires a licence for commercial use,
including selling or licensing products using the code set. The software licence
and these flags do not supply that licence. A direct import requires
`worker ingest taxonomy --accept-nucc-terms`. Without the flag bootstrap emits
`status: skipped, reason: opt_in_required` for taxonomy, including in --dry-run,
and makes no NUCC request.

Without imported taxonomy, provider APIs retain NPPES codes with
`display_name: null` and `taxonomy_source: nppes_code_only`. Exact code searches
work with either `taxonomy=207Q00000X` or `specialty=207Q00000X`. Name searches
return HTTP 422 with `error.code: unsupported_without_taxonomy`; they become
available after the import. Compatibility responses include the same source note
and nullable display name. Omitting the flag on an existing installation does not
delete names previously imported. See the [taxonomy guide](../src/ingest/taxonomy/README.md).

Bootstrap runs sequentially: migrations, each year's rules and subsidy
validation, PUF acquisition/import and geography, then optional sources.
A failed prerequisite skips only transitive dependants. Geography does not
depend on catalog acquisition; providers do not depend on RxNorm; participation
evidence does not require NPPES identities. Geocoding requires geography and a
successful full NPPES import and runs after issuer attempts, including successful
source sets from an incomplete issuer batch. Weekly and deactivation updates
independently depend on the full NPPES baseline. The advertised November 2026
weekly file returned 404 in the recorded run; this fails its own step without
discarding the monthly baseline or blocking deactivation.

Each stdout line is JSON. Step results use completed, skipped or failed;
dependency skips include reason=dependency_failed and blocked_by. The last line
contains passed, failed, blocked and every step's elapsed milliseconds. Any
failure/block makes the CLI exit 1. Read the summary and /v1/data-availability
before relying on coverage. Failed replacements preserve prior ACTIVE evidence.

Reruns check the schema journal, current ACTIVE pointers and acquired hashes.
Matching catalogs/rules/geography and complete issuer sets skip; incomplete
issuer imports remain retryable while successful siblings skip. Discovery is
observed PARSED evidence, never ACTIVE coverage: every registry row must have
been attempted before reusing it. Subsidy parameters ship in runtime code and
are validated on each run, without a separate DB snapshot or download.
Geocoding reuses terminal address attempts and retries issue outcomes.
Run one bootstrap at a time against a database/cache.

“Current” means the latest local observation, not a fresh publisher check.
Cached files are hash-checked before use. Refresh explicitly as described below.
Dry-run byte sizes describe artifacts from cache metadata, not incremental
network traffic: shared national files can appear in several state/year steps,
cache hits need no download, and new issuer feeds remain unknown.
Raw snapshots are immutable; do not edit a payload to fix a source error.

## Measured resources

These are observations from this repository on 2026-11-07, not minimum hardware
requirements. Reports named below live under OPENPLANS_DATA_DIR/reports.
Allow extra disk for Docker images, indexes, WAL, replacement/history snapshots,
and backups. Streamed national inputs are still scanned for a small state.
Cache-backed timings exclude downloads.

| Scope | Observed disk | Observed elapsed time | Peak worker RAM | Evidence |
| --- | --- | --- | --- | --- |
| DE PY2026 base bootstrap | 44,637,207-byte DB; 135,438,336-byte volume; 38,361,673-byte raw cache | 62.87 s worker; repeat 0.15 s (both from cache) | 157,646,848 bytes (150.3 MiB); DB/API RAM excluded | p8b-bootstrap/, [committed evidence](../tests/worker-bootstrap-realdata.json) |
| TX PY2026 catalog + geography | 649,878,551-byte DB | 54 s catalog + 1 s geo; 94 s including startup/checks | Not recorded | h1-smoke-20261107T083344Z/summary.json |
| RxNorm national CPC, added to TX | About 394 MiB additional DB; release archive additional | 60 s on Postgres; 70.952 s independent PGlite import | Not recorded | h2-smoke-20261107T102924Z/{times.tsv,rxnorm-metrics.json}; p2a-rxnorm-realdata.json |
| Drug evidence, Cigna TX only | About 75 MiB additional DB | 5 s from cache | Not recorded | Same H2 qhp-formulary-metrics.json and times.tsv |
| NPPES TX identities/status | About 846 MiB additional DB; 1,130,479,129-byte national monthly ZIP additional | 805 s on Postgres; 800.149 s monthly + 6.759 s deactivation on PGlite | Not recorded | Same H2 nppes-metrics.json; p3a-nppes-validation.json; [NPPES measurements](../src/ingest/nppes/README.md) |
| Provider evidence, Cigna TX only | About 2.28 GiB additional DB | 101 s from cache | Not recorded | Same H2 qhp-providers-metrics.json and times.tsv |
| Census geocode, Harris County | About 202 MiB additional DB for 145,584 points/attempts | 83 s using cached replies; original live run 628.398 s / 15 successful requests | Not recorded | Same H2 geocode-metrics.json; p3c-geocode-harris-first-run.json; [live run](../src/ingest/geocode/README.md#harris-county-real-run--2026-11-07) |
| NUCC taxonomy | Not separately measured | Not separately measured | Not recorded | [Importer and terms](../src/ingest/taxonomy/README.md) |

The single-issuer H2 stack finished at 4,687,248,407 database bytes, before raw
downloads, Docker images and WAL. A 3 GB Docker disk budget is insufficient for
that option set. All-readable bootstrap attempts more issuers than this pilot:
p6c-tx-providers.md records one issuer at 5,180,962 provider records / 1,820.1 s
and another with 162,977,400 logical associations. These observations do not
establish a universal per-state estimate. Older optional-source reports do not
record peak RAM; the table labels those measurements missing. Measure the
intended issuer/state set and monitor both host-cache and Docker-VM disk.

## Sources and publisher terms

The software's [license](../LICENSE) does not replace publisher terms. Preserve
source URLs, versions, retrieval dates, hashes and record references through
backups and exports. See the [existing attribution](../README.md#sources-and-attribution)
and each source's ingest README.

| Source | Used for | Publisher guidance |
| --- | --- | --- |
| CMS Exchange PUFs and state GRA pages | Catalogs, rates, service areas, issuer registry and rating geography | [PUF landing page](https://www.cms.gov/marketplace/resources/data/public-use-files), data dictionaries and [Data Disclaimer–User Agreement](https://www.cms.gov/files/document/data-disclaimer-user-agreementpdf); retain the separate MR URL disclaimer. |
| Census ZCTA/county relationship, Gazetteer and geocoder | County resolution, internal points and optional public-address geocoding | [Citation guidance](https://www.census.gov/about/policies/citation.html) and [geocoder documentation](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html). The adapter submits at most 10,000 rows per request and preserves approximation flags. |
| CMS NPPES V2 | Published identities, codes and addresses, without network inference | [Official files and dissemination guidance](https://download.cms.gov/nppes/NPI_Files.html). Retain the release README/date; an NPI does not establish credentials or licensing. |
| NLM RxNorm CPC | RXNORM-source drug names, codes and relations | [Public subset](https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html) and [NLM terms/acknowledgement](https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html). This adapter does not use the licensed full release or a UMLS login. |
| NUCC taxonomy | Specialty display names | [NUCC CSV/licensing page](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57) states commercial use, including sales or licensing, requires a NUCC license. Off by default; --with-nucc-taxonomy opts in after you satisfy the terms for your use. |
| Issuer QHP indexes and children | Drug and provider participation evidence | Each issuer's terms and access restrictions apply. A 403 remains access_denied. No universal redistribution right or complete negative evidence is inferred. |
| Bundled rating/subsidy documents | State methods, FPL and contribution tables | Primary-source citations and review dates are versioned in data/rating-rules/ and data/subsidy/ and retained in the compiled subsidy registry. |

Missing evidence stays unknown. No proprietary health-plan API is called.
No publisher endorsement is implied.

## Refresh and yearly updates

Back up first. Rebuild with a release supporting the year and its cited rating
and subsidy documents. A new year is not enabled by guessing a download URL
or copying an old rule file. This release accepts 2026 and 2027.

Refresh PUF publications, then bootstrap:

~~~sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker ingest puf acquire
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker bootstrap --states TX,FL --years 2026,2027
~~~

Acquisition without --year publishes a manifest for both supported years.
Bootstrap preserves other observed years when it acquires a missing year.
Changed hashes trigger independent state/year imports; matching ACTIVE sets skip.
Historical snapshots remain evidence and consume disk.

For CMS geography, the acquisition API exposes an explicit refresh:

~~~sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm --entrypoint node worker --input-type=module -e 'import {acquireGeo} from "./dist/ingest/geo/sources.js"; for (const state of ["TX","FL"]) await acquireGeo({state,refresh:true});'
~~~

Then bootstrap again. Optional sources have existing refresh-capable commands;
run only the ones you use. The taxonomy command is optional and requires acceptance of NUCC terms:

~~~sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker ingest rxnorm
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker ingest nppes --state TX
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker ingest taxonomy --accept-nucc-terms
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker ingest qhp discover --state TX --year 2026
OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker bootstrap --states TX --years 2026 --with-drugs --with-providers
~~~

New discovery observations invalidate sets tied to an older discovery. Failed
refreshes preserve previous positives and leave absence unknown. Fix an import
failure's source/cache/connectivity cause, then repeat bootstrap. Do not alter
ACTIVE pointers or raw payloads. Corrupted cache hashes fail closed.

## Back up and restore

The DB lives in Compose's pgdata named volume. A normal down preserves it;
down -v destroys it. The host raw cache/reports are separate bind mounts.
Keep a logical DB dump and its immutable cache together: a DB-only backup cannot
supply original raw evidence. Do not copy a live Postgres volume's files.

Stop ingestion jobs and the API, leaving db running. Store configuration/secrets
in your normal secret-management system; these commands do not include .env.

~~~sh
export OPENPLANS_BACKUP_DIR="$HOME/openplans-backups/$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$OPENPLANS_BACKUP_DIR"
docker compose stop api
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$OPENPLANS_BACKUP_DIR/catalog.dump"
tar -C "$OPENPLANS_DATA_DIR" -czf "$OPENPLANS_BACKUP_DIR/cache.tar.gz" raw reports
docker compose up -d api
~~~

Record the application image/version, store the backup away from this host,
and test it in a separate openplans-restore project with distinct loopback ports.
The restore below replaces the selected destination's contents. Configure its
.env and external cache path first; consistently use that destination's Compose
project name for every command.

~~~sh
mkdir -p "$OPENPLANS_DATA_DIR/raw" "$OPENPLANS_DATA_DIR/reports" "$OPENPLANS_DATA_DIR/work"
tar -C "$OPENPLANS_DATA_DIR" -xzf "$OPENPLANS_BACKUP_DIR/cache.tar.gz"
docker compose up -d db
docker compose stop api
docker compose exec -T db sh -c 'exec pg_restore --exit-on-error --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$OPENPLANS_BACKUP_DIR/catalog.dump"
docker compose up --build --wait api
curl http://127.0.0.1:3000/healthz
docker compose run --rm worker status
~~~

Start with the same package version so migration checksums match. DB raw paths
record the original import; restored snapshots remain addressed by source/hash
under /data/raw. Re-establish UID 1000 write permissions on Linux.
Inspect availability and repeat a known raw-row premium check before use.
These are documented operator procedures; the P8b run validates bootstrap,
not a disaster-recovery drill.

## Memory budgets and runtime caching

`OPENPLANS_DB_MEMORY` is a Postgres memory **budget**, default `1g`, accepting
whole MiB/GiB (`512m` through `256g`). Set it before recreating the db service:

~~~sh
OPENPLANS_DB_MEMORY=4g docker compose up -d --force-recreate db
~~~

Allow memory for the API, optional Valkey, operating-system file cache and other
services; do not assign all host RAM to this setting. The following starting
profiles reserve half of each host for those uses:

| Host RAM | DB budget | shared_buffers | effective_cache_size | work_mem | maintenance/autovacuum_work_mem | max_connections |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 GiB | 2g | 512 MiB | 1433 MiB | 2 MiB | 204 MiB | 64 |
| 8 GiB | 4g | 1024 MiB | 2867 MiB | 2 MiB | 409 MiB | 100 |
| 16 GiB | 8g | 2048 MiB | 5734 MiB | 5 MiB | 819 MiB | 100 |
| 32 GiB | 16g | 4096 MiB | 11468 MiB | 10 MiB | 1024 MiB | 100 |

The conservative `1g` default uses 256/716/2/102 MiB and 32 connections.
The db service command calculates buffers at 25%, planner cache estimate at 70%,
connections as budget MiB / 32 (20–100), maintenance memory as 10% (max 1024 MiB),
and work memory as budget MiB / (connections × 16), clamped to 1–32 MiB.
Parallel workers per gather are capped at two. The work-memory divisor leaves
room for multiple sort/hash nodes and workers; it is not a hard RSS bound. The
API pool uses five connections per process; include workers and every API replica
when sizing the connection limit. Autovacuum workers also consume memory.
`effective_cache_size` is a planner estimate, not an allocation. These are starting
values; measure your query mix and concurrency before increasing them. See the
[PostgreSQL memory documentation](https://www.postgresql.org/docs/16/runtime-config-resource.html).

Search responses use a 64 MiB local LRU by default. To opt into the shared Valkey
service, set `OPENPLANS_CACHE_URL=redis://cache:6379` in the local environment and:

~~~sh
OPENPLANS_CACHE_URL=redis://cache:6379 docker compose --profile cache up -d api cache
~~~

Both the URL and the profile are required; a profile alone starts the service but
leaves the API in local LRU mode. `OPENPLANS_CACHE_MEMORY=256mb` controls Valkey's
memory limit with `allkeys-lru` eviction and no persistence. It has no published
host port. Set `OPENPLANS_API_CACHE_MB` for the local cap or
`OPENPLANS_API_CACHE=off` to disable either backend. When an explicitly selected
Valkey is down, requests bypass it and continue against Postgres; they do not fail
or switch back to local storage. `/v1/cache-stats` reports cache counters and byte scope;
`X-Cache` identifies each request's result. Imported data invalidates both backends
at transaction commit, independently of endpoint TTLs.

See the [cache contract](../src/api/cache/README.md) for eligible endpoints,
credentials, invalidation, metrics, bounds, and operator inspection commands.

## MCP endpoint

The API accepts stateless Streamable HTTP at `POST /mcp`. GET and DELETE return 405.
Catalog tools need no credential. To enable `estimate_premiums`, set a private
`OPENPLANS_MCP_TOKEN` and send it as a bearer token. REST and compatibility credentials
do not grant MCP access. Set `OPENPLANS_MCP=off` to remove the endpoint.

Clients can use 2026-07-28 or the legacy 2025-11-25 and 2025-06-18 protocols on the same
endpoint. Send `Accept: application/json, text/event-stream`. Modern clients must supply
protocol, method and applicable name headers that match the request body. The server stores
no sessions or replay state.

Direct Node launches bind to 127.0.0.1 by default. `HOST` overrides the listener. Compose
listens inside the container and publishes only to 127.0.0.1. For a TLS proxy, set
`OPENPLANS_MCP_ALLOWED_HOSTS` to comma-separated exact Host authorities, including any
nondefault port. Set `OPENPLANS_MCP_ALLOWED_ORIGINS` to exact scheme/host/port origins.
Native clients can omit Origin; the server rejects a supplied Origin outside that list.

Only socket peers listed in `OPENPLANS_TRUST_PROXY` may supply a forwarded client address.
The server uses the last X-Forwarded-For hop. Configure those proxies to overwrite incoming
forwarding headers. This bearer-token setup does not provide an OAuth server.

Each API process allows 60 anonymous or 120 authenticated requests per source per minute,
and four concurrent database-heavy requests. Input is limited to 64 KiB and output to
128 KiB. SQL statements have a five-second server timeout; requests have a fifteen-second
deadline. Rate and concurrency failures return 429 with Retry-After. Disconnects cancel
active SQL. Retry reads with a new RPC ID.

Logs contain only the recognized tool name, HTTP status, elapsed time, byte count and cache
outcome. MCP currently bypasses the REST response cache. Share a private random
`OPENPLANS_MCP_CURSOR_SECRET` across replicas to keep cursors valid between processes.
Without it, each process generates its own secret.

For subprocess clients, build and run `node dist/mcp/stdio.js` with `DATABASE_URL`.
The image also provides the `openplans-mcp` command. Attach stdin when running it in a
container. Stdout contains protocol JSON only; diagnostics go to stderr. The process closes
on EOF or signals. Set `OPENPLANS_MCP_ALLOW_PERSONALIZED=1` to grant local estimates.
HTTP tokens do not grant stdio estimates.
