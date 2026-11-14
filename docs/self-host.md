# Self-hosting OpenPlans

Run commands from the package directory containing compose.yml. Docker with
Compose v2 is sufficient; host Node.js and a CMS API key are not required. Follow
the [package README](../README.md) to configure credentials and create
a Docker-visible cache, then run:

~~~sh
OPENPLANS_RAW_READ_ONLY=false docker compose run --build --rm worker bootstrap --states DE --years 2026
~~~

The command builds the image, starts healthy Postgres/API dependencies, loads
cited rating rules, validates bundled subsidy parameters, acquires/imports PUFs,
and loads Census/CMS geography. The API remains running after ingestion. Use
--states TX,FL --years 2026,2027 for multiple catalogs. Bootstrap supports these
two publication years. The lower-level PUF acquisition/import commands also accept explicit PY2025
scopes. Bootstrap and bundled rating/subsidy rules remain limited to 2026 and 2027.
A state absent from the publication fails
explicitly; it does not become an empty supported catalog.

> **Public quoting is on by default.** Once the API runs, anyone who can reach it can
> request quotes by age and ZIP (`POST /v1/quotes`, MCP `quote_plans`) without a token.
> These quotes take no income or identity data. Set `OPENPLANS_PUBLIC_QUOTING=off` in
> `.env` before starting the API if you do not want this.
>
> **Household quotes and the compatibility API are on by default too.** With no
> `OPENPLANS_API_TOKEN`, anyone can send income and ages to `POST /v1/premium-quotes`,
> `/v1/benchmark` and `/v1/ichra/affordability`. With no `OPENPLANS_MCP_TOKEN`, the MCP
> tools `quote_premiums` and `check_ichra_affordability` are listed. With no
> `OPENPLANS_COMPAT_API_KEY`, `/compat/v1/*` is
> open. These routes are rate-limited per source, never cached, and never log request values.
> Set the REST token, MCP token or compatibility key for the protocol you use.
> With no corresponding credential, `OPENPLANS_PUBLIC_HOUSEHOLD=off` closes
> household access and `OPENPLANS_PUBLIC_COMPAT=off` closes compatibility access.
> A configured credential still grants access when the public switch is off.

## Options and completion

| Option | Adds | Existing implementation limits |
| --- | --- | --- |
| No optional flags | Catalog, filed premiums, geography and bundled subsidy parameters | Public PUF coverage and cited state rules determine support. State exchanges need separate adapters. Subsidies remain conditional estimates. |
| --with-drugs | Public RxNorm CPC, issuer discovery and all-readable formularies | Cannot collect today. The RxNorm download host disallows automated access, so the rxnorm step fails with `admission_denied` (see [publisher access](#publisher-access)). Issuer feeds need operator manifests. Incomplete or blocked feeds stay unknown and can make the batch exit 1. |
| --with-providers | NPPES full/weekly/deactivation codes, discovery and participation | NPPES works with the shipped manifests. Issuer discovery and participation need an operator manifest entry per issuer host. NPPES memberships are state-scoped, so several states share one database; a step that would overwrite another state's rows still fails. |
| --with-nucc-taxonomy | Optional NUCC specialty display names (also usable without --with-providers) | Explicit acceptance of operator responsibility for NUCC terms; commercial use requires a NUCC licence. Also needs your own manifest entry for www.nucc.org. |
| --with-geocode | Provider inputs above, then incremental Census batch geocoding | Any of the 50 states and DC. County outlines come from one national Census boundary file, downloaded once. |
| --dry-run | Dependency plan and observed artifact sizes | No database, network, ingestion or writes. Unknown sizes stay unknown. |

For a prepared cache with read-only raw inputs, add `--qhp-cache-only` to
`--with-providers` or `--with-drugs`. Missing indexes or shards stay unknown.
Registry workbooks are extracted under
`OPENPLANS_DATA_DIR/work/qhp-registry-workbook`, which must be writable.

For a prepared provider profile, pass `--qhp-profile /data/reports/inputs.json`.
The profile pins the allowed issuer/state pairs and exact cached URLs, sources,
hashes and sizes. The profile also enables cache-only QHP reads. Existing admission
receipts still apply, and no DNS or HTTP request is allowed on a miss. Shared
index bytes can serve several states or years when their public registry rows
name the same URL. Georgia uses its admitted Georgia Access MR-PUF.

Prepared provider steps accept a quarantined source as unknown with its recorded
status and reason. They still fail on an issuer transaction error or an interrupted
batch. The generic bootstrap requires every discovered issuer to be complete. The profile
flag applies only to QHP inputs. Other bootstrap sources keep their normal
acquisition rules, and missing catalogs still fail their own steps.

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
delete names previously imported. See the [taxonomy guide](../plugins/source-nucc-taxonomy/README.md).

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
dependency skips include reason=dependency_failed and blocked_by. A step that
failed on a download carries `error` with the fetch code and message (for example
`admission_denied`, "Path is outside the publisher's reviewed permitted paths")
and uses the code as its reason. Access refusals add an `action` saying what to
do. The last line contains passed, failed, blocked and every step's elapsed
milliseconds, including those error fields. Any
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

## Reading availability

`worker status` prints the stored coverage manifest. `GET /v1/data-availability`
adds current drug/provider completeness, premium rule and geography evidence,
and ICHRA readiness. It accepts optional `state` and `year` filters. An absent
state/year row means no manifest entry, not a supported empty catalog. Database
failures return 503, not an empty list.

Catalog, premium, provider and formulary statuses describe separate evidence.
A catalog can be available while provider or drug evidence remains unknown.
Rate-row counts do not establish household quote support. California may report
partial premium support where rating-area geography needs a ZIP. Read
`premium_reason`, `provider_coverage` and `drug_coverage` before using a result.
The [ICHRA guide](ichra.md#coverage) describes its readiness and look-back fields.
[Medicare availability](medicare.md#routes) is a separate endpoint,
`GET /v1/medicare/data-availability`, with its loaded releases and counts.

A catalog import stores the rate-row count of each plan with its rate file, so
availability reads one small row per file instead of counting rate rows again.
Catalogs imported before migration 993 have no stored counts, so availability
counts their rate rows on every read. That takes seconds on a national catalog. Run
`worker backfill rate-plan-count` once after migrating to store their counts.
The command handles one rate file per transaction and skips files that already
have counts. Responses are the same either way.

## Publisher access

OpenPlans downloads only from hosts that a reviewed access manifest clears. Before
each transfer it reads the host's robots.txt and checks that the terms document
still matches the reviewed hash. A robots `Disallow` or a changed terms document
stops collection, whatever the manifest says. Requests are paced per host and
capped per session.

### What ships

OpenPlans ships reviewed manifests for the federal public-domain hosts a new
installation needs, in [`data/access/`](../data/access/README.md). A first
`bootstrap --states DE --years 2026` needs no access setup.

| Host | Cleared for | Pacing |
| --- | --- | --- |
| www.cms.gov | PUF landing pages, state rating-area pages, PY2026 state-based PUF archives | 10 s |
| download.cms.gov | Exchange PUFs PY2026 and PY2027, NPPES files | 5 s |
| www2.census.gov | ZCTA to county relationship file, ZCTA Gazetteer | 30 s |
| geocoding.geo.census.gov | Census batch geocoder | 5 s |

Insurer hosts are never shipped. You review and add them yourself.

### What each optional flag needs

| Flag | With the shipped manifests | What to do |
| --- | --- | --- |
| None | Works: catalogs, rates, geography | Nothing. |
| --with-providers | NPPES works. Issuer index and feed requests are refused until you add issuer hosts; refused indexes stay unknown coverage gaps. | Add a reviewed entry per issuer host (below). |
| --with-drugs | The rxnorm step fails with `admission_denied`. The RxNorm download host, download.nlm.nih.gov, publishes `User-agent: *` / `Disallow: /`. NLM provides this subset "without any licensing restrictions", but its other download route, the UMLS download API, needs a UMLS account API key. The RxNav APIs return concepts, not the release files the importer reads. | None yet. Run without --with-drugs. Formulary steps also need issuer hosts. |
| --with-nucc-taxonomy | The taxonomy step fails with `admission_denied`. www.nucc.org is held because NUCC says "For commercial use, including sales or licensing, a license must be obtained from this web site." | Review the NUCC terms for your use, add your own entry for www.nucc.org, and still pass the flag. |
| --with-geocode | Works. County outlines come from the Census 2024 cartographic boundary file on www2.census.gov, and the Census geocoder host is shipped. | Nothing. |

The GeoNames postal-code fallback is also held: download.geonames.org publishes
`Disallow: /` for every agent. It is not a bootstrap step.

### Adding your own manifest

Write a version 1 manifest in the format of
[the fetch guide](../src/fetch/README.md) and the shipped file, one entry per host
you have reviewed. Put it under the cache's `work/` directory, which the worker
container mounts, and point the worker at it:

~~~sh
mkdir -p "$OPENPLANS_DATA_DIR/work/access"
# write "$OPENPLANS_DATA_DIR/work/access/operator.json"
OPENPLANS_ACCESS_MANIFEST=/data/work/access/operator.json OPENPLANS_RAW_READ_ONLY=false \
  docker compose run --rm worker bootstrap --states TX --years 2026 --with-providers
~~~

Your manifest is layered over the shipped ones. An entry for a new host adds it.
An entry for a shipped host, such as www.nucc.org, replaces the shipped entry. Each
allowed entry needs the host's robots observation, the terms URL with its SHA-256,
your review and expiry dates, exact `permittedPaths`, `delayMs` of at least 5000
and `jobCaps`. Review the terms for your own use: robots permission and
reachability do not grant permission to reuse a publisher's data. Set
`OPENPLANS_SHIPPED_ACCESS=off` to use only your own manifest.

Set `OPENPLANS_EGRESS_COUNTRY` (for example `US`) to record the country you collect
from in every admission receipt. It is a record only. A host that answers robots.txt
with a direct 404 or 410 has no robots rules wherever you collect from.

### Review cadence

The OpenPlans maintainers re-review every shipped entry before each release.
`scripts/check-publisher-review.mjs` runs in CI and fails when a review is older
than the previous release or more than 90 days old. Each shipped terms review
expires 180 days after review. After that an old release stops collecting with
"Publisher terms review is missing or expired" until you upgrade or add your own
entry. If a publisher changes its terms, collection from that host stops with
"Publisher terms changed or are unavailable" until a new release or your own
re-review. Cached files keep working offline in both cases.

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
| NPPES TX identities/status | About 846 MiB additional DB; 1,130,479,129-byte national monthly ZIP additional | 805 s on Postgres; 800.149 s monthly + 6.759 s deactivation on PGlite | Not recorded | Same H2 nppes-metrics.json; p3a-nppes-validation.json; [NPPES measurements](../src/ingest/nppes/README.md) |
| Census geocode, Harris County | About 202 MiB additional DB for 145,584 points/attempts | 83 s using cached replies; original live run 628.398 s / 15 successful requests | Not recorded | Same H2 geocode-metrics.json; p3c-geocode-harris-first-run.json; [live run](../src/ingest/geocode/README.md#harris-county-real-run--2026-11-07) |
| NUCC taxonomy | Not separately measured | Not separately measured | Not recorded | [Importer and terms](../plugins/source-nucc-taxonomy/README.md) |

Issuer drug and provider evidence is not in this table. Its size depends on which issuers
you load, so measure your own set.
These observations do not establish a universal per-state estimate. Older optional-source reports do not
record peak RAM; the table labels those measurements missing. Measure the
intended issuer/state set and monitor both host-cache and Docker-VM disk.

## Sources and publisher terms

The software's [license](../LICENSE) does not replace publisher terms. Preserve
source URLs, versions, retrieval dates, hashes and record references through
backups and exports. The table below and each source's ingest README list
the attribution and source-specific requirements.

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
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner \
  --exclude-table-data=cms_api_attempt --exclude-table-data=cms_api_conflict \
  --exclude-table-data=cms_api_drug_coverage --exclude-table-data=cms_api_provider_coverage \
  --exclude-table-data=cms_zip_attempt --exclude-table-data=cms_zip_lookup' > "$OPENPLANS_BACKUP_DIR/catalog.dump"
tar -C "$OPENPLANS_DATA_DIR" --exclude='raw/cms-marketplace-*' -czf "$OPENPLANS_BACKUP_DIR/cache.tar.gz" raw reports
docker compose run --rm -T worker backup-args --manifest > "$OPENPLANS_BACKUP_DIR/manifest.json"
[ -f "$OPENPLANS_DATA_DIR/reports/inputs.json" ] && cp "$OPENPLANS_DATA_DIR/reports/inputs.json" "$OPENPLANS_BACKUP_DIR/inputs.json"
docker compose up -d api
~~~

The `--exclude` arguments keep answers stored from the CMS Marketplace API, and the log of
calls to it, out of the dump and the archive. Those answers were fetched for one question
each and expire; a restored installation asks again when it needs them. The tables stay
empty unless `OPENPLANS_CMS_FALLBACK=on`. If you run your own installation and want them in
your backup, remove the six `--exclude-table-data` arguments and the tar `--exclude`. Do not
publish or pass on a dump made that way.

`worker backup-args` prints the `--exclude-table-data` arguments for your installation, and
`worker backup-args --tar` prints the tar `--exclude` arguments. Use their output instead of
typing the names. Without pass-through plugins the table list is the six names above plus the
three generic pass-through tables (`passthrough_answer`, `passthrough_attempt` and
`passthrough_conflict`), which stay empty until a plugin uses them. Each registered source
that stores answers in its own tables adds those tables, unless the source opts back in to
backups.

The coverage fallback requires `OPENPLANS_CMS_FALLBACK=on` and `CMS_API_KEY`.
The separate `OPENPLANS_CMS_FALLBACK_QUOTES=on` switch also lets native quotes and
compatibility medical searches use it. It defaults to off and spends the shared
daily budget faster. Each request shares the two-call cap across all its plans,
providers and drugs. Native quote cells label the source and freshness in `cms_api`;
compatibility searches put those labels in `x-openplans-gaps`.
Review [fallback limits and expiry policies](../src/ingest/cms-api/README.md)
before enabling either switch.

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
docker compose run --rm -T worker backup-restored --manifest - < "$OPENPLANS_BACKUP_DIR/manifest.json"
docker compose up --build --wait api
curl http://127.0.0.1:3000/readyz
docker compose run --rm worker status
~~~

The dump keeps the `snapshot` receipts of the answers it left out. `worker backup-restored`
reads the manifest and marks each of those receipts `QUARANTINED`, with an
`answers_excluded_from_backup` quality issue, so no `ACTIVE` receipt points at an answer that
is not there. It touches only pass-through receipts with no answer row left, and only for
sources whose tables the manifest lists. Pass-through sources are the CMS Marketplace API and
any registered source that stores answers. It never changes catalog, provider or other
imported receipts. A second run changes nothing. Run it before the API starts: once
the API has stored new answers, they have rows and stay `ACTIVE`. If your dump keeps the
answers, their receipts still have rows and the step leaves them alone. For an older backup
without a manifest, use the output of `worker backup-args --manifest` from the package version
that made it.

The backup also saves `reports/inputs.json` next to the archive when you keep one, such as the
prepared provider profile. A readiness check after a restore should use that copy, because the
live file can list data loaded after the dump. The `worker backup-args` and
`worker backup-restored` commands above read the plugins your installation loads, so run them
with the same `OPENPLANS_PLUGINS` and `OPENPLANS_CONFIG` as production. The
[plugin operations guide](plugins-operations.md#backups-and-restores) has the details.

Start with the same package version so migration checksums match. DB raw paths
record the original import; restored snapshots remain addressed by source/hash
under /data/raw. Re-establish UID 1000 write permissions on Linux.
Inspect availability and repeat a known raw-row premium check before use.
These are documented operator procedures. The recorded bootstrap run validates
bootstrap, not a disaster-recovery drill.

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
Parallel workers per gather are capped at two. The command also sets
`random_page_cost=1.1` and `effective_io_concurrency=200` for solid-state storage. On
spinning disks, override them in a Compose override file. The work-memory divisor leaves
room for multiple sort/hash nodes and workers; it is not a hard RSS bound. The
API query pool uses five connections per process, plus one separate cancellation
connection. When a read passes its 5-second client timeout, the API uses that cancellation
connection to stop the statement on the server, so a timed-out request leaves no query running. Include workers
and every API replica when sizing the connection limit. Autovacuum workers also consume memory.
`effective_cache_size` is a planner estimate, not an allocation. These are starting
values; measure your query mix and concurrency before increasing them. See the
[PostgreSQL memory documentation](https://www.postgresql.org/docs/16/runtime-config-resource.html).

The db service sets `shm_size: 256m` for `/dev/shm`, which PostgreSQL uses for
parallel work. Docker's default is 64 MiB. The row-provenance backfill uses
`VACUUM (PARALLEL 0)` and migrations disable parallel maintenance for their
transaction, so these operations also work with the Docker default. This does
not change parallel query settings or autovacuum.

The shared-memory size takes effect only when the db container is recreated.
A restart does not apply it. Schedule a database interruption, then run:

```sh
docker compose up -d --force-recreate db
```

This keeps the existing `pgdata` volume. Use the same Compose project, files and
environment as the running installation.

REST searches and MCP catalog tools share a 64 MiB local LRU by default. To use
the shared Valkey service, set `OPENPLANS_CACHE_URL=redis://cache:6379` in the local
environment. Start both services:

~~~sh
OPENPLANS_CACHE_URL=redis://cache:6379 docker compose --profile cache up -d api cache
~~~

Set both the URL and the profile. The profile alone starts Valkey while the API
continues to use its local LRU. `OPENPLANS_CACHE_MEMORY=256mb` controls Valkey's
memory limit with `allkeys-lru` eviction and no persistence. It has no published
host port. Set `OPENPLANS_API_CACHE_MB` for the local cap or
`OPENPLANS_API_CACHE=off` to disable either backend. When an explicitly selected
Valkey is down, requests bypass it and continue against Postgres; they do not fail
or switch back to local storage. `/v1/cache-stats` reports shared cache counters and
byte scope. REST responses carry `X-Cache`; MCP logs report hit, miss or bypass.
Publication and failed or denied source observations invalidate entries when their
database transaction commits, even if their TTL has not expired.

MCP caches successful public DTOs for 60 seconds, or 300 seconds for geography
lookups. Keys include the tool, normalized filters, page offset, output-size budget,
data generation and application version from `package.json`. Entries share the
existing 2 MiB cap and backend memory limit. Requests check authorization and cursor
validity before a lookup. Quoting tools (`quote_plans`, `quote_premiums` and
`check_ichra_affordability`) bypass cache reads and writes.
Credentials, household fields, errors and signed cursors never enter MCP entries.
The server signs a new cursor and computes the access label for each caller.
Old-generation cursors return `CURSOR_EXPIRED`; restart the search.

See the [cache contract](../src/api/cache/README.md) for eligible endpoints,
credentials, invalidation, metrics, bounds, and operator inspection commands.

## Plugins

Plugins are off by default. Set `OPENPLANS_PLUGINS` in `.env` to a comma-separated list of
package names, or set `OPENPLANS_CONFIG` to the absolute path of a JSON config file on the
Docker host when a plugin needs options:

~~~sh
OPENPLANS_PLUGINS=@openplans/plugin-status
# or
OPENPLANS_CONFIG=/etc/openplans/config.json
~~~

Compose passes both variables to the `api`, `worker` and `scheduler` services and mounts the
config file read-only at the same path in each. Recreate the services after a change with
`docker compose up -d api`, plus `docker compose --profile scheduler up -d scheduler` when the
scheduler runs. Plugin secrets need a local Compose override. The
[operator guide](plugins-operations.md) walks through the status page and the operator token, the
`scheduler` profile, Slack and the webhook, pass-through cache levels, backups and restores, the
approved-plugin list and the checks to run before an update. The [plugin guide](plugins.md) covers
the first-party plugins, config file entries, event delivery and writing a plugin.

## MCP endpoint

Send Streamable HTTP requests to `POST /mcp`. GET and DELETE return 405.
The server registers 15 tools, listed in the [configuration reference](configuration.md#mcp-tools).
Every tool needs no credential by default, `quote_premiums` and
`check_ichra_affordability` included. To restrict those two, set a private
`OPENPLANS_MCP_TOKEN` and send it as a bearer token. REST and compatibility credentials do not grant MCP access. Set
`OPENPLANS_MCP=off` to remove the endpoint.

> **Public quoting is on by default.** Every install answers anonymous quotes by age and
> ZIP: `POST /v1/quotes` and the MCP tool `quote_plans`. They refuse income, household
> size, tax filing, dates of birth and names, and never estimate a subsidy. Set
> `OPENPLANS_PUBLIC_QUOTING=off` to disable both; the route then returns 503
> `QUOTING_DISABLED` and the tool is no longer listed. Public quotes allow 30 requests
> per minute per source with 2 in flight, and at most 10 members, 10 plans, 5 NPIs and
> 5 RxCUIs. See the [quoting guide](quoting.md).

Clients can use 2026-07-28 or the legacy 2025-11-25 and 2025-06-18 protocols on the same
endpoint. Send `Accept: application/json, text/event-stream`. Modern clients must supply
`MCP-Protocol-Version`, `Mcp-Method` and, for named operations, `Mcp-Name` headers.
Their values must match the request body. The server stores no sessions or replay state.

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
128 KiB for tool results and resources. Tool discovery (`tools/list`) has a separate
512 KiB budget and returns all 15 tools in one response when access permits. Signed
cursors still resume a listing. Follow `nextCursor` whenever it is present.
SQL statements have a five-second server timeout; requests have a fifteen-second
deadline. Rate and concurrency failures return 429 with Retry-After. Disconnects cancel
active SQL. Retry reads with a new RPC ID.

Logs contain the recognized tool name, HTTP status, elapsed time, byte count and cache
outcome. They exclude arguments, addresses and credentials. Share a private random
`OPENPLANS_MCP_CURSOR_SECRET` across replicas to keep cursors valid between processes.
Without it, each process generates its own secret.

For subprocess clients, build and run `node dist/mcp/stdio.js` with `DATABASE_URL`.
The image also provides the `openplans-mcp` command. Attach stdin when running it in a
container. Stdout contains protocol JSON only; diagnostics go to stderr. The process closes
on EOF or signals. Local stdio offers household quotes when public household access is on and no
MCP token is configured. Set `OPENPLANS_MCP_ALLOW_PERSONALIZED=1` to grant them
explicitly or `0` to withhold them. Stdio does not authenticate bearer headers.
`OPENPLANS_PUBLIC_QUOTING` applies to stdio too. See the
[configuration reference](configuration.md) for environment defaults and the
[worker command index](configuration.md#worker-commands) for ingestion commands.

## Optional second geocoder

A separate Nominatim service can retry addresses still unresolved after Census cleanup.
It uses public OSM state extracts and binds its port to 127.0.0.1. Start with TX, FL or NC, one state at a time. The download, import, retry and
stop commands are in [the geocoder guide](../src/ingest/geocode/README.md#self-hosted-open-geocoder).

Leave `OPENPLANS_OPEN_GEOCODER_URL` unset to disable it. Stored open results retain their
source, licence, attribution and extract date in a separate SQL ledger. They do not yet
replace Census/ZCTA evidence in provider API responses. Keep 40 GiB free on both the VM
Docker disk and external data disk, monitor imports, and stop the service when finished.
The stop command retains its state database for reuse.
