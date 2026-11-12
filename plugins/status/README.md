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

| Route                       | Who                 | Cache           |
| --------------------------- | ------------------- | --------------- |
| `GET /status`               | anyone (HTML)       | 30 s            |
| `GET /status.json`          | anyone (JSON)       | 30 s            |
| `GET /status/operator`      | operator token only | never (no-store) |
| `GET /status/operator.json` | operator token only | never (no-store) |

The public routes use the default route limits: 60 requests a minute per client, 2 at once
per client, 8 at once in total.

## What the public summary shows

- `version`: the core application version, or `unknown`.
- `api` and `db`: `ok` or `down`. The database check is the same one `/healthz` runs.
- `data`: the number of states, the plan years, and how many coverage rows have each status
  (catalog, premiums, providers, formulary). These are the statuses `/v1/data-availability`
  serves. The host's availability service supplies them. Without a host they read `null`.
  With the response cache on, the core host keeps the computed statuses in memory for the
  current data generation, the same key the response cache uses. The first read after an
  import commits computes them again. With the cache off, every read computes them.
- `sources`: each source with an active snapshot and how old its latest copy is: `<1d`, `<7d`,
  `<30d` or `older`.
- `worker.last_ingest`: for each source, how long ago its last successful import finished, in
  the same buckets, or `unknown` when none is recorded.
- `cache.enabled`: whether the response cache is on.
- `passthrough`: each pass-through source, whether it is on, whether today's request budget is
  `ok` or `exhausted`, and its cache level.
- `plugins`: how many plugins this process loaded.
- `health_transitions.last_change`: how long ago the probe last saw a component change state.

A part the plugin cannot read is `null`, and the page says so. The page never shows it as zero.

## What the operator view adds

- the number of clients waiting for a database connection;
- one coverage row per state, plan year, market and issuer;
- the exact retrieval time and snapshot ID of each source;
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

Without a configured token the operator routes answer 404. A missing or wrong token gets
401. Keep the operator routes off the public edge: expose only `/status` and `/status.json`
there, and read operator detail from the host itself.

## `get_status`

The MCP tool takes no input and returns the same JSON as `/status.json`.

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
