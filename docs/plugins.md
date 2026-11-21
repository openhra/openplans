# Plugins

A plugin is a Node package that adds routes, MCP tools, worker commands, schedules, event
handlers, data sources or storage providers to OpenPlans. This guide is for people who run their
own installation and for people who write plugins. It covers turning plugins on, the first-party
plugins, how sources, events and storage work, writing a plugin from the template, the rules the
core enforces, what to check before you approve a plugin, and how versions work. Day-to-day
operation is in [Running plugins](plugins-operations.md).

Plugins are trusted code. They run inside the API and worker processes with the same operating
system rights as the core. The core limits what a plugin can register, read and reach, but it is
not a sandbox. Install only packages you have reviewed, and record the reviewed version and
package hash (see [Status page](#status-page)).

The plugin API is experimental. Its version is `0.1`, and the loader refuses a plugin that
declares any other version. See [Versions](#versions).

## Market Source of Truth

The optional [`@openplans/plugin-msot`](../plugins/msot/README.md) adds
`POST /msot/resolve` and the read-only `msot_resolve` tool when an inline source is configured.
It resolves the operator's `custom_payment_allowed` flag from carrier, state and exchange-channel
rules, with public plan facts and actor/scope provenance. Missing decisions stay unknown.
Dual-channel plans keep separate answers. The flag describes an operator workflow; it does not
establish insurer payment acceptance or binding authority.

It ships off by default. Loading it without a source adds no route or tool. This first slice
writes no tables and leaves catalog answers unchanged. It is not configured on the shared public
instance. The additive SDK `canonicalReader` and `catalogPolicies` contracts load on API, worker
and MCP stdio hosts; the provider supports annotations only.

## Turn plugins on

Every process reads its plugin list at startup. The API, the worker and the MCP stdio server load
the same list. Each one keeps only the kinds it hosts:

| Process          | Keeps                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| API              | routes, MCP tools, catalog policies, cache stores, database providers, blob stores, sources, events          |
| Worker           | catalog policies, cache stores, database providers, blob stores, sources, worker commands, schedules, events |
| MCP stdio server | MCP tools, catalog policies, cache stores, database providers, sources                                       |

Public mode requires an approval list even when no plugins are enabled.

### `OPENPLANS_PLUGINS`

The quick way is a comma-separated list of package names:

```sh
OPENPLANS_PLUGINS=@openplans/plugin-status
```

Each plugin then gets its default options. The variable replaces the plugin list in the config
file. An empty or unset value keeps the file's list. To turn off a plugin listed there, set
`"enabled": false` on its entry. Use the config file for any plugin that needs options, such as
the webhook plugin.

### `OPENPLANS_CONFIG`

`OPENPLANS_CONFIG` is an absolute path to a JSON file. The file needs `"version": 1`. Core
sections use the names in `src/config/index.ts`; environment variables win over the file for
core settings. Plugin options go only in the file.

```json
{
  "version": 1,
  "db": {
    "provider": "pg"
  },
  "blobs": {
    "provider": "local"
  },
  "plugins": {
    "entries": [
      {
        "package": "@openplans/plugin-status"
      },
      {
        "package": "@openplans/plugin-webhook",
        "options": {
          "events": ["ingest.failed", "readiness.failed"]
        }
      },
      {
        "package": "./local-plugins/hello/dist/index.js",
        "enabled": false
      }
    ],
    "approvedList": "./plugins.approved.json",
    "lockfile": "./plugins.lock.json"
  }
}
```

Each entry under `plugins.entries` takes these fields:

| Field             | Default | Meaning                                                                                                                                                                  |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package`         | none    | A package name Node can resolve from the OpenPlans install, or a path starting with `./`, `../` or `/`. A relative path is resolved against the config file's directory. |
| `enabled`         | `true`  | `false` keeps the entry but skips it.                                                                                                                                    |
| `options`         | unset   | Checked against the plugin's own options schema. A plugin without a schema refuses any options.                                                                          |
| `optionalSecrets` | `[]`    | Declared secrets the plugin may start without.                                                                                                                           |
| `sources`         | `{}`    | Per-source cache settings, keyed by source id. See [Cache levels](#cache-levels).                                                                                        |

The first-party plugins live under `plugins/` in the OpenPlans tree and are npm workspaces, so
their names resolve after `npm ci` and in the Docker image.

### Compose

`compose.yml` passes `OPENPLANS_PLUGINS` and `OPENPLANS_CONFIG` from `.env` to the `api`,
`worker` and `scheduler` services, so all three load the same plugins. Both are empty by default. Public hosts require an approval list and lockfile even for an empty list.

Set `OPENPLANS_CONFIG` to the absolute path of the file on the Docker host. Compose mounts that
file read-only at the same path in each service, so the value works inside the containers too.
Only the file is mounted. A `package` entry with a relative path, such as
`./local-plugins/hello/dist/index.js`, also needs its directory mounted at the same place. A local
Compose override can do that, or you can install the plugin into the image.

`OPENPLANS_OPERATOR_TOKEN` goes to the API service only. Plugin secrets such as
`OPENPLANS_WEBHOOK_URL` are not in `compose.yml`. Pass them in a local Compose override, because
a variable in `.env` alone does not reach a container. See the
[configuration reference](configuration.md).

### Package approval and disk verification

API 0.2 uses a `plugins` object. Its `entries` array holds the packages and options.
`approvedList` names the operator's JSON approval file. `lockfile` defaults to
`plugins.lock.json` beside the configuration file. Relative paths use that directory.
`OPENPLANS_PLUGINS` replaces only `entries`, preserving the approval settings.

Before startup, run `worker plugin lock` against the built files. Review the lock candidate,
then write the approved list as described in [Running plugins](plugins-operations.md#the-approved-plugin-list).
`worker plugin verify --json` recomputes every digest from disk. Neither command imports plugin
code or opens a database. Locking never grants approval.

Any enabled `public.quoting`, `public.household` or `public.compat` switch requires approval.
These switches default on. `plugins.requireApproval: true` requires it in private mode too.
A configured list always enforces approval. With all public switches off and no list, the
loader emits `plugin_approval_unconfigured` and continues for local development.

Each package declares `openplansPlugin` in its `package.json`, with `apiVersion: "0.2"`,
`kinds` and optional `capabilities`. The loader compares that declaration with the runtime
manifest after approval and before setup. The webhook package also declares `networkFromEnv`
to resolve its receiver host without executing code. This field accepts only the non-secret
`OPENPLANS_WEBHOOK_HOST` setting; package metadata cannot request other environment variables.
Lock and runtime must use the same host.

The strict digest is SHA-256 of a UTF-8 JSON array sorted by path in JavaScript code-unit order.
Each directory contributes `[path, "directory", mode]`; each regular file contributes
`[path, "file", mode, byteLength, fileSha256]`. The root path is `"."`; other paths use `/`.
Modes are `stat.mode & 0o7777`. Hidden files, empty directories and `node_modules` count.
Links and special files refuse inspection. The bounds are 10,000 records and 200 MiB of file
bytes. Ownership and timestamps do not count. The implementation is `packageContentDigest` in
`src/plugins/package-hash.ts`.

The lock records package specifier, name, version, origin, strict `digest`, `legacySha256`,
API version, kinds and capabilities. Origin is `bundled`, `local` or `registry:<url>` and grants
no permission. Status and retained release receipts still use the unchanged legacy hash recipe.
Locks and approvals must live outside package roots so their bytes do not hash themselves.

### Load order and refusals

The loader checks every enabled plugin before any `setup` runs, in configuration order. Each
plugin's registrations go to a staging area, and they become active only when every plugin has
finished setup. The order, from `src/plugins/loader.ts`, is:

1. Before importing any enabled package, read `plugins.approvedList` and `plugins.lockfile`,
   resolve every package and recompute its strict content digest. Require matching names,
   versions and both hashes, including bundled packages. A missing or invalid approval refuses
   startup. Then import each checked file, check the default export, compare `apiVersion`,
   parse the manifest, then check the name and `tablePrefix` for duplicates, the declared
   secrets, the declared network hosts and the options.
2. For each plugin, in the same order: run `setup` and check every registration as it is made.
   Every host checks every registration, so the API, the worker and the MCP stdio server refuse
   the same configuration, even for kinds that host does not keep.
3. Check that all MCP tools, core and plugin, fit on one `tools/list` page.
4. Check that each configured `db.provider`, `blobs.provider` and `cache.provider` exists.
5. Check the operator's `sources` settings against what each pass-through source declares.

A failure stops the process with exit code 1 and one line on stderr:

```json
{
  "plugin": "@openplans/plugin-webhook",
  "code": "plugin_network_host_not_allowed",
  "reason": "unknown"
}
```

The codes are:

| Code                              | Cause                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `plugin_approval_refused`         | Approval is missing, invalid or differs from the locked package on disk.              |
| `plugin_import_failed`            | The package could not be imported.                                                    |
| `plugin_export_invalid`           | The default export is not a plugin, or its manifest fails the schema.                 |
| `plugin_api_version_mismatch`     | `apiVersion` is not `0.2`.                                                            |
| `plugin_name_duplicate`           | Two entries load the same manifest name.                                              |
| `plugin_table_prefix_duplicate`   | Two plugins declare the same `tablePrefix`.                                           |
| `plugin_secret_missing`           | A declared secret is unset and not listed in `optionalSecrets`.                       |
| `plugin_network_host_not_allowed` | A declared network host is not `allowed` in an admission manifest. `reason` says why. |
| `plugin_options_invalid`          | `options` fail the plugin's schema.                                                   |
| `plugin_kind_undeclared`          | Setup registered a kind the manifest does not list.                                   |
| `plugin_registration_invalid`     | A registration has a bad shape or name.                                               |
| `plugin_route_collision`          | A route repeats another route or takes a reserved path.                               |
| `plugin_mcp_tool_collision`       | An MCP tool name is already taken.                                                    |
| `plugin_registration_collision`   | A source id, worker command, schedule or subscription is already taken.               |
| `mcp_tool_page_overflow`          | The plugin's MCP tools push the tool list past one page, by count or by bytes.        |
| `plugin_provider_collision`       | A storage provider name is already taken.                                             |
| `plugin_provider_unknown`         | `db.provider`, `blobs.provider` or `cache.provider` names no provider.                |
| `plugin_setup_failed`             | `setup` threw.                                                                        |
| `passthrough_level_loosened`      | A `sources` setting is looser than the source declares.                               |

For `plugin_network_host_not_allowed`, `reason` says why:

| `reason`              | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `manifest_unreadable` | A loaded admission manifest could not be read.              |
| `observed_hold`       | The core holds the host.                                    |
| `unknown`             | No loaded manifest lists the host.                          |
| the host's `state`    | The entry is not `allowed`, for example `terms-restricted`. |
| `terms_expired`       | The terms review is missing, not yet valid or expired.      |

`@openplans/plugin-slack` has been removed. An enabled entry refuses to load with
`plugin_import_failed` and `reason: "package_removed"`. Remove the entry from your config;
use the signed webhook plugin for event delivery.

A refusal raised in `setup` wins even when the plugin catches the thrown error.

`worker migrate` checks plugin migrations separately, before it opens the database, and refuses
with `plugin_migration_scope` or `plugin_migration_invalid`. See
[Plugin migrations](#plugin-migrations).

Teardown runs in reverse load order when the process stops, with 5 seconds per plugin.

## First-party plugins

Each plugin's README has the full detail. This section says what each one does and what it needs.

### Status page

`@openplans/plugin-status` adds `GET /status`, `GET /status.json`, the operator views
`/status/operator` and `/status/operator.json`, a `get_status` MCP tool and a `health-probe`
schedule. It adds no tables and makes no network requests.

```sh
OPENPLANS_PLUGINS=@openplans/plugin-status
OPENPLANS_OPERATOR_TOKEN=<at least 32 random characters>
```

The public view shows the version, API and database health, coverage counts per status, source
ages in buckets (`<1d`, `<7d`, `<30d`, `older`), whether the response cache is on, the state of
each pass-through source and the plugin count. A value the plugin cannot read is `null`, never
zero. The public routes are cached for 30 seconds.

The operator view adds connection waits, coverage per state, year, market and issuer, exact
snapshot IDs and retrieval times, recent import failures, cache counters, pass-through budgets,
the last 20 events, the last 50 health changes, and each plugin's name, version, API version and
package SHA-256. It needs the token as a bearer token:

```sh
curl -H "Authorization: Bearer $OPENPLANS_OPERATOR_TOKEN" http://127.0.0.1:3000/status/operator.json
```

Without a configured token the operator routes answer 404; a wrong token gets 401. They are
never cached. Expose only `/status` and `/status.json` on a public edge.

After you review a plugin, copy its name, version and `sha256` from `/status/operator.json`
into status comparisons. Runtime approval also requires the strict digest from `worker plugin lock`.
The status hash covers every file under the package root except
`node_modules` and dot files; the [SDK README](../plugins/sdk/README.md#host-status) gives the
recipe.

`worker status-page health-probe` runs every minute from the scheduler. It checks the database,
whether `deliver-events` ran in the last 5 minutes, and the cache when one is configured. It
emits `health.changed` only when a component changes state. Details:
[status plugin](../plugins/status/README.md).

### Signed webhook

`@openplans/plugin-webhook` posts chosen events as JSON to an HTTPS URL you run. Each post
carries `X-OpenPlans-Signature: sha256=<hex HMAC-SHA256 of the body>` and
`X-OpenPlans-Event-Id`.

| Variable                   | Secret | Value                                |
| -------------------------- | ------ | ------------------------------------ |
| `OPENPLANS_WEBHOOK_HOST`   | no     | The receiver's host name             |
| `OPENPLANS_WEBHOOK_URL`    | yes    | The full `https://` URL on that host |
| `OPENPLANS_WEBHOOK_SECRET` | yes    | The HMAC key, 32 characters or more  |

The option `events` lists the event types to post. The host must be `allowed` in your operator
manifest. The [webhook README](../plugins/webhook/README.md) has a manifest template, a
signature test vector and a minimal receiver.

### S3-compatible blob store

`@openplans/blob-s3` registers the `s3` blob provider. It keeps the fetch cache in one bucket of
an S3-compatible object store, with SHA-256 checks on every write and read. It needs no SDK.

```json
{
  "version": 1,
  "blobs": {
    "provider": "s3"
  },
  "plugins": {
    "entries": [
      {
        "package": "@openplans/blob-s3",
        "options": {
          "prefix": "openplans"
        },
        "optionalSecrets": ["OPENPLANS_BLOB_S3_SESSION_TOKEN"]
      }
    ],
    "approvedList": "./plugins.approved.json",
    "lockfile": "./plugins.lock.json"
  }
}
```

It reads `OPENPLANS_BLOB_S3_ENDPOINT`, `OPENPLANS_BLOB_S3_REGION`, `OPENPLANS_BLOB_S3_BUCKET`,
`OPENPLANS_BLOB_S3_ACCESS_KEY_ID`, `OPENPLANS_BLOB_S3_SECRET_ACCESS_KEY` and, optionally,
`OPENPLANS_BLOB_S3_SESSION_TOKEN`. Options are `prefix`, `maxObjectBytes` (5 GiB by default),
`partBytes` (64 MiB by default) and `timeoutMs` (60 000 by default). The endpoint host needs an
`allowed` entry in the operator manifest. Details: [blob store](../plugins/blob-s3/README.md).

### CMS Marketplace API source

`@openplans/source-cms-marketplace-api` is the pass-through source `cms-marketplace-api`. It
fills provider and drug coverage answers that the loaded files leave `unknown`. The core
registers it while `OPENPLANS_CMS_FALLBACK=on`, so it needs no entry under `plugins`. Calls also
need `CMS_API_KEY`. It declares the `stored` level, a default budget of 500 calls a day with 1
second between calls, and a breaker that pauses for 15 minutes after 3 failures in 5 minutes.

Read the [fallback guide](../src/ingest/cms-api/README.md) before you switch it on. Details:
[source package](../plugins/source-cms-marketplace-api/README.md).

### RxNav drug identity source

`@openplans/source-rxnav-identity` is the pass-through source `rxnav`, of kind `drug-identity`.
When no RxNorm release is ACTIVE, it asks the public RxNorm API whether an RxCUI is a current,
unsuppressed concept. The core registers it while `OPENPLANS_RXNAV_IDENTITY=on`, so it needs no
entry under `plugins`. It declares the `memory` level (24 hours, 1 hour for anything not
confirmed, 100,000 entries), one call every 5 seconds and 5,000 calls a day. With no release
ACTIVE it also answers drug name searches (kind `drug-name-search`) with suggested concepts,
labelled `terminology_status: "passthrough"`. Details:
[source package](../plugins/source-rxnav-identity/README.md).

### NUCC taxonomy source

`@openplans/source-nucc-taxonomy` is the feed source behind `worker ingest taxonomy`. The core
loads it; listing it under `plugins` is refused. NUCC display names are off by default, and no
environment variable turns them on. Review NUCC's terms and get any licence your use needs, then
clear `www.nucc.org` in your operator manifest and opt in on the command line:

```sh
worker bootstrap --states TX --years 2026 --with-providers --with-nucc-taxonomy
worker ingest taxonomy --accept-nucc-terms
```

Details: [taxonomy guide](../plugins/source-nucc-taxonomy/README.md).

### Carrier formulary documents source

`@openplans/source-carrier-documents` is the feed source behind `worker ingest carrier-formulary`,
of kind `formulary-pdf`. It reads the formulary PDFs an issuer links from its own website, keeps
every drug row with page, line, raw text, confidence and the document's SHA-256, and matches the
plans printed on each cover to the catalog (exact name first, then the name without benefit
add-ons such as "+ Dental & Vision", attached only when one plan matches). A tier the legend
leaves out is admitted only when the document's own text states it, and that line is kept as
evidence. A document that fails its legend, tier or year checks is refused on its own; the run's other documents are still admitted. Only `high` confidence rows are served, as text evidence with the
document's own tier label; everything else stays `unknown`. With its `identityJoin` option on,
rows joined to RxCUIs also answer drug coverage in `/v1` drug answers, quotes, the
compatibility quote and MCP, below the issuer's machine-readable files and above the CMS
fallback (see feed sources below). List it under `plugins`, clear its
hosts in your admission manifest, and run it where Python and Poppler's `pdftotext` are
installed. Details: [source package](../plugins/source-carrier-documents/README.md).

The same package runs `worker ingest carrier-sbc`, of kind `sbc-pdf`, for the Summary of Benefits
and Coverage PDFs. It rebuilds each SBC's cost-sharing chart from word coordinates and refuses a
document whose printed coverage period is not the year its link names. It maps a document to plan
variants by the HIOS id in its file name (which must be in the active catalog), or else by the
printed plan name for the coverage year, and checks every row against the federal plan
attributes and benefit tables, and reports a disagreement as `conflicting` with both values. It
serves SBC values only for plans the federal tables hold no cost sharing for, labelled
`source: "sbc_document"`.

## Sources

A plugin registers a source with `ctx.sources.add(source)`. There are two kinds.

### Feed sources

A feed source downloads a publisher's files and stages rows, like a core importer. Each one
becomes a worker command at its own argv, such as `worker ingest synthetic-feed`. A run goes
through these steps:

1. `plan` returns the files to fetch. It may read discovery pages with `ctx.fetch`, which works
   only while `plan` runs.
2. The core fetches every file through one admission session and records the snapshots.
3. `stage` parses the files and writes rows inside one transaction.
4. `validate` runs the plugin's checks, then the core runs its own readiness checks: each
   touched table needs its change trigger, and each table in `requireRows` needs rows.
5. `beforeActivate` runs, and the core marks the run's snapshots `ACTIVE`. A multi-file feed can
   return `refused` from `validate` (snapshot id and reason code per file): those snapshots are
   quarantined with the code and the rest are activated. The run fails only when every file is
   refused.

Any failure quarantines this run's snapshots with a reason code. The previous active release
keeps serving. A plan file with `cache: "content"` is stored under its SHA-256 and reused
without a request; use it only for a URL that names one fixed release.

Every feed declares `dataScope` before the core calls `plan`. Use `{ kind: "current" }`
for a current-generation dataset such as taxonomy. Annual feeds declare
`{ kind: "annual", domain: "individual" | "medicare", years(args) }`; `years` returns
all plan or contract years the run will write, using the parsed command arguments.
The core checks those years with the data-window resolver before discovery, storage
or downloads. A mixed plan containing an excluded year is refused as a whole.
`runFeedSource` with `dryRun: true` returns the same dataset/year/reason skip manifest
without calling the plugin's planning hook. Feed commands also accept the host's
`--dry-run` flag. Missing scope declarations are refused.

A feed source may also answer drug coverage from its staged documents with an optional
`drugCoverage(db, { planId, planYear, rxcui })` hook. The core asks it only for an RxCUI it has
already identified, on a plan in the active catalog. The precedence is:

1. Loaded issuer machine-readable files win. Where they settle the question, the document answer
   is only checked against theirs, and `passthrough_conflict` records whether the two agree.
2. Where the files leave it `unknown` because the source set is missing, incomplete or refused,
   a `covered` document answer is served as `listed_covered` with the rows in
   `formulary_document`. The tier is the one the document prints, `tier_status: "unresolved"`.
3. Everything else stays as the files gave it, so pass-through sources such as the CMS fallback
   see the same `unknown`. A stored CMS answer for a question a document settled is only
   checked against it, in `cms_api_conflict`.

A document answer calls nothing upstream and is never named in `x-openplans-upstream`; only an
identity source called during the request is. A drug a document does not list stays `unknown`.

A feed plugin must declare `capabilities.writes` with `"staging"`. Every host in `hosts` must
also be in the plugin's `capabilities.network` and be allowed in a loaded manifest, or the run
stops before `plan`.

### Pass-through sources

A pass-through source answers questions at request time that the loaded files leave `unknown`.
Only an `unknown` answer whose reason means "not sourced yet" can open a call
(`PASSTHROUGH_OPENING_REASONS` in the SDK). Loaded files always win.

The source supplies the call shape, the response mapping and attribution. The core does the
rest: eligibility, batching, admission, the call, the budget, the per-client share, the breaker,
the evidence block and the cache level. A negative answer is served only when the source can
confirm the identity locally. Otherwise it stays `unknown`.

Each source declares a budget:

| Field                      | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `budget.dailyMax`          | Calls allowed per UTC day.                                   |
| `budget.minIntervalMs`     | Minimum time between calls.                                  |
| `budget.clientShare`       | The share of the daily allowance one inbound client may use. |
| `budget.breaker`           | `failures` within `windowMs` pause calls for `pauseMs`.      |
| `batch.maxCallsPerRequest` | Live calls one inbound request may make.                     |

When the day's allowance is spent, the API emits `passthrough.budget_exhausted` once per source
and day. When the breaker opens, it emits `passthrough.breaker_open`.

The API discloses every pass-through answer. A response with an answer from a source has the
`x-openplans-upstream` header listing the source ids, and an MCP tool result has the same list
in `_meta["openplans/upstream"]`. The host reads the id from the answer's evidence block: the
core's block names it `source_id`, and a source with its own `serve` must put `source_id` or
`sourced_by` next to `served_from`. The core also lists a source for every live call it starts,
including calls that fail or that the upstream refuses, so a lookup that left no evidence block
is still disclosed. A caller can send `passthrough=off` as a query parameter, a
body field or an MCP argument. Then the host asks no source, and eligible answers stay `unknown`
with reason `passthrough_declined`. Plugin routes get both through `ctx.sources.passThrough.apply`.
The [API README](../src/api/README.md#upstream-disclosure-and-passthroughoff) has the details.

### Cache levels

A pass-through source declares how much of an answer may be kept:

| Level     | What is kept                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `none`    | Nothing. Each eligible question makes a live call within budget.                                                           |
| `request` | The answer for the life of one inbound request, so one request does not ask twice.                                         |
| `memory`  | A shared entry in the configured cache store, with a TTL. It is lost on restart and never reaches the database or backups. |
| `stored`  | Rows in the database under a record policy, fresh within the TTL and stale within the stale window.                        |

The strictest level wins, in three places:

- You can make a source stricter in its plugin entry, but never looser. A looser setting refuses
  the load with `passthrough_level_loosened`. At `memory`, `ttl` and `negativeTtl` may only be
  shorter than declared.
- A response that mixes answers from several sources takes the strictest level among them. At
  `none` and `request` the response cache does not store it; at `memory` it stores it for the
  shorter of the route's TTL and the source's.
- Inside a `none` or `request` scope, nothing is written to disk. Blob store writes refuse with
  `storage_forbidden`, and plugin fetches keep the body in memory.

```json
{
  "version": 1,
  "plugins": {
    "entries": [
      {
        "package": "@example/source-answers",
        "sources": {
          "example-answers": {
            "cacheLevel": "memory",
            "ttl": "5 minutes"
          }
        }
      }
    ],
    "approvedList": "./plugins.approved.json",
    "lockfile": "./plugins.lock.json"
  }
}
```

For a `stored` source, the worker applies changed `ttl`, `staleWindow` and `negativeTtl` values
at start through `worker record-policy set`. Tightening a stored source to a lower level expires
its stored rows and stops new writes; the rows are not deleted. `worker backup-args` prints the
dump exclusions for stored sources' tables.

## Events and delivery

Events go through an outbox in the database. A plugin subscribes in setup:

```ts
ctx.events.on("ingest.failed", handler, {
  durable: true,
  subscriber: "my-plugin",
});
```

A durable handler runs from `worker deliver-events`. A non-durable one runs in the process that
emits the event, before the outbox row is written and outside the emitter's transaction. It gets
a copy of the event and 2 seconds. A failure or timeout is logged and never retried, so use a
non-durable handler only for work you can lose, such as a log line or a counter. Subscriber
names match `^[@a-z0-9][a-z0-9/._:-]{0,127}$`. A plugin emits from a worker command with `ctx.events.emit`, which needs
`capabilities.writes` with `"events"`. Operators and scripts can write any catalog event with:

```sh
worker emit readiness.failed --payload '{"check":"bootstrap.migrate","reasonCode":"exit_1"}'
```

The core checks every payload against the catalog. Without `--idempotency-key`, the same type
and payload give the same key, and a repeated key keeps the first row.

### Delivery

`worker deliver-events` fans new outbox rows out to each durable subscriber, then delivers them
one at a time, up to 1,000 per run. Each handler has 30 seconds. A subscriber gets only events
emitted after the worker first saw it.

- A handler gets each event at least once, so it must ignore repeats by `idempotencyKey`.
- After a failure the deliverer waits `min(2^attempts, 3600)` seconds plus up to 10% jitter, and
  gives up after 20 attempts.
- Outbox rows older than 30 days whose deliveries all succeeded are deleted.

### Schedules

`worker schedule run` runs one tick: every schedule whose cron matches the current UTC minute
runs once. `worker schedule run --loop` ticks every minute until stopped. The Compose
`scheduler` profile runs the loop:

```sh
docker compose --profile scheduler up -d scheduler
```

The core schedules `deliver-events` every minute with a 55 second limit. Plugin schedules use
five-field UTC cron expressions, may not start `schedule` itself, and stop at their `maxRunMs`.
An advisory lock keeps two schedulers from running the same schedule in the same minute.

### Event catalog

The SDK defines 15 event types in
[`plugins/sdk/src/events.ts`](../plugins/sdk/src/events.ts). Payloads hold identifiers, counts,
reason codes and timestamps only.

| Type                           | Payload fields                                       |
| ------------------------------ | ---------------------------------------------------- |
| `release.deployed`             | `version`, `imageId`, `previousVersion`              |
| `release.rolled_back`          | `version`, `imageId`, `fromVersion`                  |
| `snapshot.activated`           | `sourceId`, `snapshotId`, `rows` (null when unknown) |
| `snapshot.quarantined`         | `sourceId`, `snapshotId`, `reasonCode`               |
| `ingest.started`               | `sourceId`, `command`, `scope`                       |
| `ingest.completed`             | `sourceId`, `command`, `durationMs`, `snapshotIds`   |
| `ingest.failed`                | `sourceId`, `command`, `reasonCode`                  |
| `readiness.failed`             | `check`, `reasonCode`                                |
| `audit.failed`                 | `step`, `reasonCode`                                 |
| `passthrough.budget_exhausted` | `sourceId`, `dailyMax`                               |
| `passthrough.breaker_open`     | `sourceId`, `untilAt`                                |
| `cache.flushed`                | `reason`: `generation` or `operator`                 |
| `health.changed`               | `component`, `from`, `to`                            |
| `record_policy.changed`        | `policy`, `ttl`, `staleWindow`                       |
| `plugin.loaded`                | `plugins`: name and version of each                  |

`release.rolled_back` follows a release rollback. Release tooling sends it with `worker emit`
once the rollback has passed its checks. `version` and `imageId` name the release the pin went
back to; `fromVersion` is the version it left. The webhook plugin posts it when `events` lists it.

Each event also has `id`, `type`, `emittedAt`, `emittedBy` and `idempotencyKey`. The `sourceId`
of each `ingest *` command is listed in the
[configuration reference](configuration.md#ingest-event-source-ids).

## Plugin migrations

A plugin can ship SQL migrations as `<package>/migrations/NNN_<snake_case>.sql`, numbered from
`001`. Its manifest must then declare a `tablePrefix`: a lowercase letter followed by 1 to 15
lowercase letters or digits, unique among loaded plugins. Every object the migrations create or
change must be named `plg_<tablePrefix>_...`.

```sql
CREATE TABLE plg_synmig_note (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id text REFERENCES snapshot(snapshot_id),
  body text NOT NULL
);
```

`worker migrate` runs the core migrations, then each enabled plugin's files in configuration
order. The journal names them `plugin:<manifest name>/<file>`. The worker allows only
`CREATE TABLE`, `CREATE INDEX`, `CREATE FUNCTION`, `ALTER TABLE` and `INSERT INTO` on prefixed
objects in `public`, and refuses the whole run before it opens the database otherwise. The
refusal line carries `plugin_migration_scope` for a statement outside the prefix or for migration
files from a plugin without a `tablePrefix`, and `plugin_migration_invalid` for a file name that
breaks the rule or a directory it cannot read. The core
adds row provenance and record policy columns and the `api_data_changed` trigger to each plugin
table, so cached responses expire when the table changes.

Disabling a plugin drops nothing. The full rules are in
[migrations](migrations.md#plugin-migrations).

## Storage providers

The config file names the database and blob providers:

| Setting          | Core providers     | Default                                              |
| ---------------- | ------------------ | ---------------------------------------------------- |
| `db.provider`    | `pg`, `pglite`     | `pg`, the Postgres pool at `DATABASE_URL`            |
| `blobs.provider` | `local`            | `local`, files under `OPENPLANS_DATA_DIR`            |
| `cache.provider` | `memory`, `valkey` | `memory`; `valkey` when `OPENPLANS_CACHE_URL` is set |

A plugin adds a provider with `ctx.dbProviders.provide(name, factory)`,
`ctx.blobStores.provide(name, factory)` or `ctx.cacheStores.provide(name, factory)`. Provider
names match `^[a-z][a-z0-9-]{0,31}$` and may not repeat a core name. A plugin blob store becomes
the fetch cache's default; the cache stages downloads in `blob-spool` and keeps checked read-back
copies in `blob-read` under `OPENPLANS_DATA_DIR`. The MCP stdio server keeps no plugin blob
stores.

The core wraps every plugin blob store, so `put` and `publish` refuse with `storage_forbidden`
inside a `none` or `request` scope. A blob store must refuse an existing key with `EEXIST`, and
`publish` must move a key or prefix without leaving a half-written result. The test kit's
`checkBlobStore` and `checkCacheStore` run the shared contracts against a provider.

## Write a plugin

A plugin's default export has a `manifest`, a `setup(ctx)` function and an optional `teardown`.
Types and schemas come from `@openplans/plugin-sdk` in `plugins/sdk/`.

The manifest declares:

- `name`, `version` (semantic version) and `apiVersion: "0.2"`;
- `kinds`, every registry the plugin uses: `routes`, `mcpTools`, `cacheStores`, `dbProviders`,
  `blobStores`, `sources`, `workerCommands`, `schedules`, `events`;
- `capabilities`: `network` hosts, `secrets` it reads, `writes` (`staging`, `cache`, `blobs`,
  `events`), `operatorRoutes` and `hostStatus`;
- `tablePrefix` when it ships migrations, and `options`, a Zod schema for its options.

Every kind a plugin registers must be in `kinds`, or setup is refused with
`plugin_kind_undeclared`.

### Capabilities

A capability is a request for something the core withholds by default. Declare only what the
plugin uses; a reviewer reads this list first.

| Capability        | What it grants                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`         | The host names `ctx.fetch` and `ctx.fetch.post` may reach. Each must be `allowed`, with a current terms review, in a loaded admission manifest, or the plugin does not load. |
| `secrets`         | The environment variables `ctx.secrets.get` may read. Each must be set unless the plugin entry lists it in `optionalSecrets`.                                                |
| `writes: staging` | `db.writer` in worker commands, and feed sources. Without it a plugin only reads.                                                                                            |
| `writes: cache`   | A stored copy of each admitted GET under `raw/plugin-<name>/`. Without it the body stays in memory.                                                                          |
| `writes: events`  | `ctx.events.emit` from worker commands.                                                                                                                                      |
| `writes: blobs`   | Declared by blob store providers. The core grants nothing extra for it today.                                                                                                |
| `operatorRoutes`  | Routes with `exposure: "operator"`. They need the operator token and are never cached.                                                                                       |
| `hostStatus`      | The module's `createPlugin({ host })` factory gets the read-only status view. See the [SDK README](../plugins/sdk/README.md#host-status).                                    |

### Registration rules

`src/plugins/registries.ts` checks each registration as `setup` makes it. A bad shape is
`plugin_registration_invalid`; a taken name is one of the collision codes.

| Registration   | Rule                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Route          | `GET` or `POST`; path matches `^/[A-Za-z0-9._~/-]*$` and avoids the reserved paths; JSON or HTML; `operator` needs `operatorRoutes`.     |
| MCP tool       | Name matches `^[a-z][a-z0-9_]{2,63}$` and is not a core tool; `readOnly: true`; input and output schemas convert to JSON Schema objects. |
| Worker command | Each word matches `^[a-z][a-z0-9-]{0,31}$`; the argv may not repeat, extend or shorten a core command's argv.                            |
| Schedule       | Name matches `^[a-z][a-z0-9-]{0,63}$`; a five-field cron; a command that does not start with `schedule`; a positive `maxRunMs`.          |
| Event handler  | A catalog event type, a `durable` flag and a subscriber name; one handler per type and subscriber.                                       |
| Provider       | Name matches `^[a-z][a-z0-9-]{0,31}$` and is not a core provider.                                                                        |

An MCP tool's handler gets its input parsed by `inputSchema`. The core parses the output with
`outputSchema`, and an output with a top-level `status` must follow the core answer envelope and
its evidence rules. A failure answers with the core error envelope.

`setup` registers things; it does not do work. `ctx.db` and `ctx.fetch` reject while plugins load.
Query through `c.get("pluginDb")` in routes, the tool's `db` and `WorkerContext.db`. The test kit
hands setup a working database, so a test will not catch a setup that queries it.

### Start from the template

[`plugins/template`](../plugins/template/README.md) is a working plugin with one public route,
one MCP tool, one worker command and one non-durable event handler, plus tests that use the kit
and plant a mutant. It is a workspace package, so CI builds it and runs its tests.

From a fresh checkout, with a supported Node version:

```sh
cd openplans
npm ci
npm run build:plugins
npx vitest run plugins/template
```

The last command reports 8 passing tests. To start your own plugin, copy the folder:

```sh
cp -R plugins/template plugins/greeter
```

Then rename everything a second copy would collide on:

| File           | Change                                                                      |
| -------------- | --------------------------------------------------------------------------- |
| `package.json` | `name`, for example `@example/plugin-greeter`                               |
| `src/index.ts` | `PLUGIN_NAME` to the same name                                              |
| `src/index.ts` | `HELLO_PATH`, `HELLO_TOOL`, `HELLO_ARGV` and `SUBSCRIBER` to your own names |
| `README.md`    | what your plugin does                                                       |

Link the new workspace, then build and test it:

```sh
npm install
npm run build:plugins
npx vitest run plugins/greeter
```

The tests import the kit by a relative path three folders up, into `src/plugins/testing/`. Keep
the copy under `plugins/` while you work. A plugin package for its own repository needs that
path changed, and its own Node packages for `vitest`, `@electric-sql/pglite` and the core.

The test `loads through the worker and counts runs in plugin state` loads the plugin through the
real worker loader, so a refusal code fails it. To run the plugin in an installation, list
`@example/plugin-greeter` in `OPENPLANS_PLUGINS` as [Turn plugins on](#turn-plugins-on) shows, and
follow [Running plugins](plugins-operations.md).

### A minimal plugin

This plugin adds one public route and one durable event handler. Put it in its own workspace,
for example `plugins/hello/`.

```ts
// plugins/hello/src/index.ts
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { z } from "zod";

const options = z
  .strictObject({ greeting: z.string().min(1).max(40).default("hello") })
  .prefault({});

const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@example/plugin-hello",
    version: "0.1.0",
    apiVersion: "0.2",
    kinds: ["routes", "events"],
    options,
  },
  setup(ctx) {
    const { greeting } = ctx.options as z.infer<typeof options>;
    ctx.routes.add({
      method: "GET",
      path: "/hello",
      exposure: "public",
      contentType: "application/json",
      cache: { ttlSeconds: 60 },
      handler: (c) => c.json({ greeting }),
    });
    ctx.events.on(
      "ingest.failed",
      async (event) => {
        ctx.log({ code: "ingest_failed_seen", source: event.payload.sourceId });
      },
      { durable: true, subscriber: "hello" },
    );
  },
};

export default plugin;
```

The `.prefault({})` lets the plugin load from `OPENPLANS_PLUGINS`, which passes no options.

### Test it with the kit

The test kit lives in the core package at `src/plugins/testing/`; the SDK does not export it.
`loadForTest` runs setup against an isolated PGlite database with the core migrations, records
every registration and mounts the routes on a test app. It fails a JSON response that carries
row provenance columns. It never delivers events or fetches; inject `fetch` when setup needs it.

```ts
// plugins/hello/tests/hello.test.ts
import { expect, it } from "vitest";
import { loadForTest } from "../../../src/plugins/testing/index.js";
import plugin from "../src/index.js";

it("serves the greeting and subscribes to ingest failures", async () => {
  const loaded = await loadForTest(plugin, { options: { greeting: "hi" } });
  try {
    const response = await loaded.app.request("/hello");
    expect(await response.json()).toEqual({ greeting: "hi" });
    expect(loaded.registrations.subscriptions).toMatchObject([
      {
        type: "ingest.failed",
        options: { durable: true, subscriber: "hello" },
      },
    ]);
  } finally {
    await loaded.close();
  }
});
```

The kit also exports `checkRowProvenance`, `checkCatalogTriggers`, `checkEventPayloads`,
`checkRouteResponses`, `checkBlobStore`, `checkCacheStore`, `responseDigests` and
`plantMutant`, which writes a disposable copy of a source file with one change so a test can
prove a check fails. A plugin with a `tablePrefix` must pass `packageRoot` so the kit runs its
migrations and checks its tables.

Run `npm run build` from the OpenPlans root to build the SDK, the workspace packages and the
core, then `npm test`.

CI copies the two example files above into a scratch package, builds them against the SDK and
runs the example test (`tests/docs/plugins-example.test.ts`). A change that breaks the example
fails the build.

### Synthetic fixtures

`tests/fixtures/plugins/` holds small synthetic plugins the core tests load. None of them hold
real data or reach a real host. Useful ones to read:

| Fixture                   | Shows                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `synthetic-routes/`       | public and operator routes, rate limits, route cache, `pluginDb` |
| `synthetic-mcp-tools/`    | MCP tools                                                        |
| `synthetic-feed/`         | a feed source with `plan`, `stage`, `validate`, `beforeActivate` |
| `synthetic-passthrough/`  | a pass-through source at each cache level                        |
| `synthetic-migrations/`   | a `tablePrefix` and two migrations                               |
| `synthetic-db-provider/`  | a database provider                                              |
| `synthetic-route-writer/` | the scoped writer on a plugin route                              |

The fixtures named after a refusal, such as `synthetic-secret-missing/` and
`synthetic-route-collision/`, each trigger one loader refusal. `plugins/sdk/tests/testing-kit.test.ts`
uses the kit end to end.

## Safety rules

The core enforces these rules whatever the plugin code does.

**Declared hosts.** A plugin reaches only the hosts in `capabilities.network`. Any other host is
refused before a DNS lookup or connection. Each declared host must be `allowed` in a loaded
admission manifest with a current terms review, or the plugin does not load. See
[publisher access](self-host.md#publisher-access) for the manifest format.

**Admission, robots and terms.** A GET from a worker command or feed source takes the same path
as core collection. It reads the reviewed manifest, robots.txt and the terms review, waits its
turn on the host's pacing, and shares the run's request and byte budget. A plugin that declared
`writes` with `"cache"` gets a stored copy under `raw/plugin-<name>/`; otherwise the body stays
in memory.

**Delivery rules.** `ctx.fetch.post` delivers to your own endpoint, so it skips robots, terms
reads and pacing. It still goes only to declared, allowed hosts. It follows no redirect, makes
one attempt with a 5 second deadline, and fails on any status outside 2xx; the outbox retries.
Extra header names must start with `x-openplans-`.

**Secrets.** A plugin reads only the secrets it declares, through `ctx.secrets.get`. Its config
view has no credentials. `ctx.log` refuses keys that name a credential.

**Routes.** Plugin routes may not use `/healthz`, `/mcp`, `/v1/...` or `/compat/...`, and only
the status plugin may use `/status...`. Each route has a rate limit (default 60 a minute, 2 at
once per client, 8 at once in total), a 15 second deadline, a 64 KiB request limit and a 1 MiB
JSON response limit. A JSON response that carries row provenance columns or credential fields is
replaced with a 500. Operator routes need `capabilities.operatorRoutes` and the operator token,
and are never cached.

**Read-only database by default.** Routes and MCP tools get a read-only session bounded by the
request deadline. A worker command gets `ctx.db.writer` only when the plugin declares `writes`
with `"staging"`.

**The scoped writer.** A plugin with its own pass-through sources gets
`c.get("pluginPassThroughWriter")` on its routes, to pass to `ctx.sources.passThrough.apply`. It
is not a general writer. A statement that writes may name only the source's own storage tables,
never a core table. DDL, transaction control, session settings, several statements in one string
and functions with side effects are refused with `passthrough_write_refused`.

**Migrations.** Plugin migrations touch only `plg_<tablePrefix>_` objects and cannot create
triggers, views or `DO` blocks, or run `UPDATE`, `DELETE` or `DROP`.

**Data.** Missing evidence stays `unknown`. A pass-through source that cannot confirm a negative
answer locally never turns it into "not covered".

## Before you approve a plugin

The core enforces the rules above, but it cannot tell whether a plugin does what it says. Before
you add a plugin to your [approved list](plugins-operations.md#the-approved-plugin-list), check:

1. **The manifest.** Read `kinds`, `capabilities` and `tablePrefix`. Each capability is a grant,
   listed under [Capabilities](#capabilities). Ask why the plugin needs each one.
2. **Each network host.** Who runs it, what the plugin sends there, and whether its terms allow
   the use. Record your terms review in an `allowed` entry of your operator manifest, as
   [publisher access](self-host.md#publisher-access) describes. The plugin does not load without it.
3. **Each secret.** What it unlocks, and where you keep it. A plugin reads only the secrets it
   declares.
4. **Migrations.** What each `plg_<tablePrefix>_` table holds, and whether that belongs in your
   backups.
5. **Routes and tools.** Public routes answer anyone. Check what each one reads and that missing
   evidence stays `unknown`.
6. **Event handlers.** A durable handler must ignore repeats by `idempotencyKey`. Check where it
   posts and what the post carries.
7. **Pass-through sources.** The declared cache level, the budget and the attribution.
8. **Its tests.** Run them, including any planted mutants, against the exact build you will
   install.
9. **The identity.** Inspect the lock entry written by `worker plugin install` or
   `worker plugin lock`. Review its name, version, strict `digest` and `legacySha256`. The
   approved list records that legacy hash as `sha256`. Approval must exist before the first load.

## Versions

### The API version

The SDK exports `PLUGIN_API_VERSION`, now `0.2`. A manifest's `apiVersion` must equal it exactly.
The loader compares it before it parses the rest of the manifest and refuses any other value with
`plugin_api_version_mismatch`. The manifest schema accepts only that value too, so
`pluginManifestSchema.parse` and the test kit's `loadForTest` reject a mismatch, and a plugin's
own tests fail before an operator sees it.

While the API is `0.x` there are no version ranges. A plugin built for `0.1` loads only on a core
whose SDK says `0.1`. A breaking change raises the minor version, from `0.1` to `0.2`, and is listed
under [Changes](../plugins/sdk/README.md#changes) in the SDK README. Other changes keep the
version. The SDK package's major and minor numbers follow the API version, so
`@openplans/plugin-sdk` `0.1.x` serves API `0.1`.

### What counts as breaking

A change is breaking when a plugin that compiled, loaded and worked before could stop doing one
of those. That includes:

- removing or renaming an SDK export, a context member, a registry method or a field the core
  passes to plugin code;
- changing a type or a function so that existing plugin code no longer compiles or means
  something else;
- a manifest rule that refuses a value it accepted before, or a new required field;
- changing an event payload: removing, renaming or retyping a field, or adding one, because
  payload schemas are strict;
- a new load refusal or registration rule that refuses a plugin that used to load;
- weakening a documented guarantee, such as at-least-once delivery, the retry schedule, a
  handler's time limit or the strictest-level rule for cache levels;
- changing the package hash recipe, because every approved list would stop matching.

These are not breaking: new optional context members, kinds, capabilities or manifest fields;
new event types; new refusal codes for registrations that were already invalid; and fixes that
make the core do what this guide says.

### Plugin versions and the approved list

A plugin's `version` is its own semantic version and moves on its own schedule. Raise it with
every release you ship. A move to a new API version needs a new release of each plugin, since
`apiVersion` sits in the manifest.

The package hash covers every file under the package root except `node_modules` and dot files.
That includes `package.json` and the built `dist/`. The same files give the same hash, and any
change gives a new one, even when the version stays the same. A rebuild that changes the output
changes the hash too.

An approved-list entry pins the name, version, legacy `sha256` and strict `digest`. The strict
digest also covers directories, modes and hidden files, and refuses links. Keep one reviewed pair
of hashes per version. Changed bytes or permissions need another review. A new version needs a
new lock entry and approval.

## Package a plugin for another installation

Build and test your plugin before packing it. Add `openplans-package.json` at the package root.
The [template manifest](../plugins/template/openplans-package.json) is a starting point. Replace
its example build timestamp and zero source revision with your build's actual provenance before
publishing. The SDK ships the [JSON Schema](../plugins/sdk/openplans-package.schema.json) and the
`@openplans/plugin-sdk/dist/package-manifest.js` validator.

The descriptor uses one schema for `plugin`, `ui-addon` and `data` packages. Code packages declare
the built JavaScript entrypoint, runtime API version, kinds, capabilities, licence, attribution,
build provenance, exact host peers and bundled dependency inventory. `ui-addon` accepts only
`routes` in this version. Copy the exact `hono`, `zod` and `@openplans/plugin-sdk` versions from
the core's `package.json` into both `hostPeers` and `package.json`'s `peerDependencies`.

Bundle other pure JavaScript dependencies into `dist/`. List each bundle's dependency name,
version, licence, payload path and SHA-256 in `bundledDependencies`. Runtime `dependencies`,
optional dependencies, npm bundles, lifecycle scripts and native `.node` add-ons are refused.
Packing accepts the author's `build`, `test`, `lint`, `typecheck` and `format` scripts, then removes
all scripts and development dependencies from the emitted `package.json`.

From the core source root, after `npm run build`:

```sh
node dist/worker/cli.js plugin pack plugins/template --out /tmp/plugin-release
node dist/worker/cli.js plugin verify --local /tmp/plugin-release/openplans-plugin-template-0.2.0.tgz
OPENPLANS_PLUGIN_DIR=/tmp/local-plugins node dist/worker/cli.js plugin install /tmp/plugin-release/openplans-plugin-template-0.2.0.tgz
```

Use a fresh output directory for each build. Packing refuses to replace an existing archive.
It includes `dist/`, `migrations/`, `assets/`, `attestations/`, top-level README, licence and notice files, a runtime
`package.json` and the descriptor. Source files, tests, empty directories and `node_modules/` stay out. Hidden payload
files, links, unsafe paths, secret markers and native add-ons fail the checks. A root `.env` file
also stops packing. The code package limits are 20 MiB compressed, 100 MiB expanded and 5,000
regular files. Archive entries have sorted paths, zero timestamps and owner IDs, and mode `0644`.
The gzip compression level is fixed. Identical build bytes and descriptor produce identical archives.

Pack imports the built module and runs its setup through `loadForTest`. It compares the module's
name, version, API version, kinds and capabilities with the descriptor. This command runs code,
so use it only on a plugin you are authoring or have reviewed. It does not run the plugin's build
or install scripts.

The emitted descriptor contains a SHA-256 inventory of every payload file except itself.
`package.json.openplansPlugin` must declare the same API version, kinds and capabilities as the
descriptor and built module. API 0.2 uses SDK and workspace version 0.2.0. A separate
`<archive>.json` receipt records the archive digest, descriptor digest, strict content digest and
legacy status hash. Keeping this receipt outside the archive avoids a hash that would have to include itself.
Local verification checks the internal inventory. An unsigned local archive and its receipt do
not establish a publisher's identity.

`plugin verify --local <directory|file.tgz>` and `plugin install <directory|file.tgz>` never import
the payload or run setup. They do not load configured plugins. Directory input must already contain
the packed descriptor and its file inventory. Private verification and install copies use mode
`0755` for directories and `0644` for files; the returned strict digest describes those bytes and
modes. Install verifies a private copy, then places the
package under `<pluginDir>/<namespace>/<name>/<version>/`. Set `OPENPLANS_PLUGIN_DIR`, or set
`OPENPLANS_DATA_DIR` to use its `plugins/` subdirectory. Otherwise install uses the configured
data directory, which defaults to `~/.local/share/openplans`. Existing versions are never replaced.
Install binds the core's three exact host peers under `<pluginDir>/node_modules/`, outside the
immutable package. Run install in the core runtime that will load the package. It refuses
conflicting bindings or parent directories that shadow those peers.

Installation grants no approval and loads nothing. It atomically adds or updates the local
package's entry in `plugins.lockfile`, using the core inspector and lockfile writer. Other package
entries stay in the lockfile. The default lockfile is `plugins.lock.json` beside the config file,
or in the working directory when no config file is set. The output includes both the strict
content digest and the legacy status hash, plus a disabled config entry.

Install never changes `plugins.approvedList`. An installed package absent from that list is
refused before import. Review the exact installed bytes and record the name, version, `sha256`
and `digest` in the approved list before enabling the config entry. The lockfile and approved list
must be different files. There is no install or approval HTTP endpoint.

### Original-file data descriptors

Data packages contain original public-file bytes as content-addressed `chunks/<sha256>` files,
plus the source evidence named in the descriptor. Each original file declares its upstream HTTPS
URL, whole-file SHA-256, retrieval timestamp, admission receipt and redistribution evidence with
hashed evidence files. Chunks are 64 MiB, except the last chunk of each file. The descriptor orders
them so verification can hash the reassembled original without writing another copy. A release
has at most 4,096 chunks, 20 GiB of original compressed bytes and 100 GiB of declared expanded
bytes. The importer must still enforce its actual expansion and parsing limits.

An absent upstream hash keeps verification at `unknown` and returns exit code 1. Missing
redistribution evidence is refused. A successful local byte check does not validate a publisher's
rights claim or grant source admission. Data activation still needs the existing admission,
provenance and importer checks. `plugin pack` and `plugin install` accept code packages only;
local directory verification also checks original-file data packages. They never activate data.

## Install from a signed registry

Registry search and install use `tuf-js` 6.0.2. Use Node 22.22.2 or later in the 22 series,
Node 24.15.0 or later in the 24 series, or Node 26 or later. The Docker image already meets
this requirement.

Obtain the registry's initial TUF root through a channel you trust. Review its key IDs and
threshold before adding it to your installation. The client never downloads its initial trust
root from a registry or reads trust from a plugin lockfile.

Create `<dataDir>/registries/trust.json`, where `<dataDir>` is the configured data directory.
Paths in this file are relative to its directory. Absolute root paths also work.

```json
{
  "version": 1,
  "registries": [
    {
      "url": "file:///srv/openplans-catalog/",
      "root": "./reviewed-root.json"
    }
  ]
}
```

`OPENPLANS_REGISTRY_TRUST` selects a different trust file. Registry URLs have no credentials,
query string or fragment. HTTPS uses the existing fetch admission rules, including publisher
terms, robots checks and pacing. Add the host to the operator access manifest before using it.
Plain HTTP is accepted only for an explicitly trusted `127.0.0.1` fixture server.

After building the core:

```sh
node dist/worker/cli.js plugin search taxonomy
node dist/worker/cli.js plugin search taxonomy --registry file:///srv/openplans-catalog/
node dist/worker/cli.js plugin install @openplans/source-nucc-taxonomy@0.2.0 --registry file:///srv/openplans-catalog/
```

These commands require a catalog containing the requested package. Search without `--registry`
searches every declared registry in order. Failure in any registry fails the command. Install
requires an exact name and version. With `--registry`, it uses only that trusted registry or
mirror. Without the flag, a new name uses the first registry with the exact version; an
installed name stays bound to its recorded origin. It never resolves a version range.

The static layout is `metadata/` and `targets/`. Metadata uses TUF root, timestamp, snapshot and
targets roles, with numbered roots such as `2.root.json`. Consistent snapshots use numbered
snapshot and targets metadata, plus hash-prefixed target filenames. Each top-level target has a
signed `custom.openplans` object containing `name`, `version` and `summary`. These fields identify
the archive, and installation checks its manifest against them. The client currently refuses
delegations. Catalog limits are 1 MiB for a root or timestamp, 4 MiB for snapshot or targets
metadata, 1,000 targets and 32 root rotations per refresh. Code archives have the same 20 MiB
compressed limit as local installation.

The timestamp includes a signed ISO `issued_at` field and expires exactly two days later. Search
and install refresh metadata before accepting a result. Expired timestamps, timestamps issued
more than a minute in the future and local clocks more than a minute behind the previous check
are refused. Installation and update check freshness again after downloading. An expired
catalog blocks new installs, updates and bundle exports. `plugin list` still reports installed
packages with a warning, using cached notices when a refresh fails.

Verified metadata and clock state live in `<dataDir>/registries/<sha256-of-registry-url>/`.
Accepted root, timestamp and snapshot versions survive a failed download and a process restart.
Keep this state when backing up the installation. Deleting it discards rollback protection.
Root rotation follows every intermediate root and verifies both the previous and new root's
signature thresholds. Replacing the configured initial root after first use is refused.

The client downloads into a private quarantine, checks the target's length and hashes, then
uses the local package installer. The lock records `registry:<normalized-url>` as the origin.
Installation never imports the payload, changes the approved list or enables a config entry.
Configure `plugins.approvedList` and `plugins.requireApproval: true`, review the installed bytes,
and record their hashes before enabling the package. An unapproved package then fails before
import, even when its catalog signatures pass.

A running deployment reads its installed package and local approval. It does not refresh a
registry at startup or during requests, so a stale or unreachable catalog does not stop it.
A `file://` repository uses the same checks with networking disabled. `plugin bundle` copies
the requested archive, signed metadata and intermediate roots for a disconnected install. Its
timestamp must still be fresh. No signing keys or publisher service ship with the client.

Each registry permits one writer to its trust state at a time. If a process crashes and leaves
its `lock/` directory behind, confirm that process has stopped before removing that directory.
Keep `metadata/` and `state.json` intact. A corrupted trust state needs operator review; the client
has no skip-verification or automatic trust-reset option.

### Registry ownership and mirrors

You can put the ordered registry list in `plugins.registries` in your config file. Each entry
has `url` and `root`, as in the trust file above. Paths to roots in the config file resolve
against that file's directory. `OPENPLANS_REGISTRY_TRUST`, when set, selects the trust file
instead of the config list. With neither, the default trust file still applies.

An entry may add `namespaces`, such as `["@example"]`, to restrict which names it can supply.
Two entries cannot claim the same namespace. URLs and mirror aliases must also be unique.
Registries without a namespace restriction are searched in list order for a new name.
After installation, the lock pins the name to its origin. Installing the same name from
another registry, or replacing a registry package with a local package, is refused. Remove it
first if you intend to change its origin.

Use `mirrors` on a registry entry for copies of the same signed catalog. Every mirror uses
that entry's independently reviewed root, trust state and origin. A mirror cannot reset the
accepted metadata versions. There is no automatic fallback after a failed verification.
See [offline installs](plugins-operations.md#offline-installs) for the bundle workflow.

### Inspect, update and remove

```sh
node dist/worker/cli.js plugin list
node dist/worker/cli.js plugin list --json
node dist/worker/cli.js plugin update @example/plugin --to 2.0.0
node dist/worker/cli.js plugin update @example/plugin
node dist/worker/cli.js plugin remove @example/plugin
```

`list` reads the candidate lock and checks its bytes against local approvals. It shows each
package's origin, digest, approval, integrity, catalog freshness and upstream yank, revocation
or removal notices. When present, verified publishing provenance appears as a source repository,
commit and workflow; `--json` includes the full statement. A failed refresh prints a warning and uses the last fully verified catalog
if one is cached. Cached notices can be out of date. Listing never loads plugin code.

`update` uses the installed package's registry only. Add `--registry <mirror-URL>` to read a
configured mirror of that origin. Without `--to`, it selects the highest
stable, non-yanked version from that catalog. With `--to`, it resolves that exact version,
including a prerelease. Yanked, revoked and removed versions are refused. Both paths quarantine
and verify the archive before installation. An already installed version is refused.

The new version goes beside the old one. The candidate lock changes; config and approvals do
not. Review the new bytes, record their exact name, version and hashes in `plugins.approvedList`,
and change the config entry to the returned entrypoint before restarting. A config entry for
the new version fails before import until its approval matches. A running process keeps its
loaded version; restarting against the old config after changing the lock fails the lock check.

`remove` refuses any enabled config entry pointing at that package, including an old installed
version or an alias. Disable those entries first. It removes all versions of the named package
from the managed plugin store and removes its lock entry. Other packages, approvals, database
migrations already applied and ingested data stay in place. Unmanaged packages are refused.
