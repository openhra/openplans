# Status page

`@openplans/plugin-status` adds a status page to the API, a `get_status` MCP tool and a
`health-probe` schedule for the worker. It reads data the service already keeps. It adds no
tables and makes no network requests.

## Enable it

List the package in `OPENPLANS_PLUGINS` (or under `plugins` in the `OPENPLANS_CONFIG` file)
for the API and the worker:

```sh
OPENPLANS_PLUGINS=@openplans/plugin-status
```

The routes and the tool load on the API. The probe command and its schedule load on the
worker. The probe runs only when the scheduler runs (`worker schedule run --loop`, or the
Compose `scheduler` profile).

## Routes

| Route                       | Who                 | Cache            |
| --------------------------- | ------------------- | ---------------- |
| `GET /status`               | anyone (HTML)       | 30 s             |
| `GET /status.json`          | anyone (JSON)       | 30 s             |
| `GET /status/operator`      | operator token only | never (no-store) |
| `GET /status/operator.json` | operator token only | never (no-store) |

The public routes use the default route limits: 60 requests a minute per client, 2 at once
per client, 8 at once in total.

## What the public summary shows

- `version`: the core application version, or `unknown`.
- `api` and `db`: `ok` or `down`. The database check is the same one `/healthz` runs.
- `data`: the number of states with coverage, counting DC as one, the plan years, and how
  many coverage rows have each status
  (catalog, premiums, providers, formulary). These are the statuses `/v1/data-availability`
  serves. The host's availability service supplies them. Without a host they read `null`.
  With the response cache on, the core host keeps the computed statuses in memory for the
  current data generation, the same key the response cache uses. The first read after an
  import commits computes them again. With the cache off, every read computes them.
- `sources`: each source with an active snapshot.
  - `freshness`: how long ago OpenPlans retrieved its latest copy: `<1d`, `<7d`, `<30d` or
    `older`. It says when we downloaded the file. It does not say whether the publisher has
    released anything newer since.
  - `published_at`: the publisher's own date for that copy, as `YYYY-MM-DD`, or `null` when the
    import recorded none.
  - `published_from`: where that date came from. `release_date` is the release, version or data
    date the import stored with the snapshot. Examples are the RxNorm release, the NPPES file
    date and a Medicare file's release month. `last_modified` is the `Last-Modified` header the
    publisher's server sent with the file, read as a UTC date. A stored release date wins over
    the header. A Medicare release whose stored date is only the day we retrieved it reads
    `null`. `latest_of_files` is for a snapshot that groups other files and has no date of its
    own, such as one state's PUF import. Its date is the latest date of the file snapshots the
    import recorded under it in `puf_import_file` or `state_community_rate`. The plugin gives
    it only when every one of those files has a date. If any file has none, the row reads
    `null`. A snapshot's own date always wins. `null` when `published_at` is `null`.
  - `published_files`: how many files a `latest_of_files` date was taken from. Only those rows
    have this field.
- `worker.last_ingest`: for each source, how long ago its last successful import finished, in
  the same buckets, or `unknown` when none is recorded.
- `cache.enabled`: whether the response cache is on.
- `passthrough`: each pass-through source, whether it is on, whether today's request budget is
  `ok` or `exhausted`, and its cache level.
- `plugins`: how many plugins this process loaded.
- `health_transitions.last_change`: how long ago the probe last saw a component change state.

A part the plugin cannot read is `null`, and the page says so. The page never shows it as zero.

The HTML page shows the same fields in less space. It reads the state codes behind
`data.states` and names DC apart from the states, as in "48 states and DC". It groups sources
by the part of the ID before the first colon, so `cms-exchange-puf:2026:TX:rate` falls under
`cms-exchange-puf`. Each group gets one line with its snapshot count and ages, and its
snapshots sit inside a `<details>` element. Each snapshot row shows Retrieved and Published side by
side, the summary line gives the family's range of publisher dates, and one sentence above the
groups explains the difference. A `latest_of_files` date reads "2026-10-30, latest of 6 files".
The page stays short however many snapshots are active, and it has no scripts. A link at the top goes to plans.openhra.com.

## What the operator view adds

- the number of clients waiting for a database connection;
- one coverage row per state, plan year, market and issuer;
- the exact retrieval time, publisher date and snapshot ID of each source;
- recent import failure codes and durations;
- cache backend, hits, misses, bypasses and bytes;
- pass-through request counts, daily limits, pause times and cache hit rate;
- each loaded plugin's name, version, API version, package SHA-256 and enabled state;
- the last 20 events, with their payloads;
- the last 50 health changes.

Some values only the host process knows: the core version, connection waits, cache counters,
the cache probe, plugin hashes, whether a loaded plugin serves a pass-through source, the
pass-through hit rate, and coverage statuses from the core's availability service. The
manifest declares `capabilities.hostStatus`, so the core loader calls `createPlugin({ host })`
with a read-only view of them instead of using the default export. A value the host cannot tell reads `null`, never zero. Connection waits and cache
counters need the API database, which the API passes to `loadPlugins` as `statusHost.database`.
The hit rate is the share of eligible pass-through questions this process answered from the
source's cache level without a live call, counted since the process started.

The package SHA-256 covers every file under the plugin's package root (the nearest
`package.json` above its entry file), except `node_modules` and names starting with a dot.
The SDK README gives the exact recipe. Copy the name, version and `sha256` from
`/status/operator.json` into the release's approved plugin list after you review a plugin.

Neither view contains hostnames, file paths, connection strings, keys, tokens or request data.
The plugin replaces strings in event payloads that look like a path, a URL or an email address
with `<redacted>`.

## The operator token

Set `OPENPLANS_OPERATOR_TOKEN` in the API's environment and send it as a bearer token:

```sh
curl -H "Authorization: Bearer $OPENPLANS_OPERATOR_TOKEN" http://127.0.0.1:3000/status/operator.json
```

Without a configured token the operator routes answer 404. A missing or wrong token gets 401. Keep the operator routes off the public edge: expose only `/status` and `/status.json`
there, and read operator detail from the host itself.

## `get_status`

The default call, `{}`, returns a compact summary. It includes the service version and database
state, coverage counts by status, source freshness counts, last-import age counts, cache state,
pass-through totals and exhausted budgets, plugin count and last health-change age. A `null`
summary means the read failed or no evidence was available. Zero means a successful empty read.

Request details with `section`, `offset` and `limit`:

```json
{ "section": "sources", "offset": 0, "limit": 50 }
```

`section` accepts `summary`, `sources`, `worker` or `passthrough`. `limit` defaults to 50 and
accepts 1 through 100. `offset` defaults to zero. The answer includes the summary plus `details`
and `page`. Follow `page.next_offset` until it is `null`. Pages use the current read's ordering,
so a new import between calls can change their contents. Summary calls have no detail page.

Every answer stays below 64 KiB, counting both MCP copies of the JSON and reserving 4 KiB for
framing. The summary shows at most 20 plan years and 128 version characters. If a detail row
would exceed the byte budget, the tool omits it and increments `page.omitted`. `truncated: true`
marks omitted rows, years or version characters. Paging still advances past omitted rows.
`page.total` counts all rows in the requested section, or is `null` when the read failed.
A normal page with more rows has `page.next_offset` and `truncated: false`.

The MCP source details carry IDs and retrieval-age buckets. Publisher dates and complete public
lists remain at `/status.json`. REST routes keep their existing fields and limits.

## `health-probe`

`worker status-page health-probe` runs every minute through the scheduler. It checks:

- `db`: `SELECT 1` on the database;
- `worker`: whether `deliver-events` ran in the last 5 minutes;
- `cache`: a round trip on a sentinel key, only when the host supplies one.

It stores the result in `plugin_state` under this plugin's name with the key `health`, and
emits `health.changed` only when a component changes state. The first run records a baseline
and emits nothing. A retry after a failed write repeats the same event key, so the outbox keeps
one row per change.

The probe stores its state in the database. When the database is down, the probe cannot record
that, and the run exits 1 instead.
