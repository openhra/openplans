# Plugin SDK

`@openplans/plugin-sdk` exports plugin, context, registry and source contracts,
plus `pluginManifestSchema` and the 14 schemas in `eventPayloadSchemas`.
The experimental plugin API version is `0.1`.

The manifest schema validates package names, semantic versions, the exact API
version, registration kinds and optional capabilities. A manifest can supply a
Zod schema in `options` to validate its configuration. Database and SQL session
interfaces are structural, so the SDK has no dependency on core source files.
`CACHE_LEVEL_ORDER` lists cache levels from strictest to least strict.

`readCsv` and `readRecords` are the CSV reader the core importers use, so a source plugin
parses quoting, byte-order marks and record-length limits the same way. They stream records,
and bad input throws a `CsvError` that carries a code and the row number.

A feed source's hosts must be among its plugin's `capabilities.network` hosts, and each must be
allowed in a loaded access manifest. Otherwise the run stops before `plan`. For a plan file with
`cache: "content"`, the core stores the download under its SHA-256 instead of the run's snapshot
id, and reuses an earlier copy of the same URL without a request. Use it only for a URL that
names one fixed release.

Plugins get a database as `PluginDatabase`, `{ reader, writer? }`, both in
setup (`ctx.db`) and in worker commands (`WorkerContext.db`). `reader` runs
read-only. `writer` is there only when the plugin declares
`capabilities.writes` with `"staging"` and the host grants it. Today only
worker commands grant it.

Route handlers take `Context<PluginRouteEnv>`. The host sets two variables on
each request:

- `c.get("pluginDb")` is a read-only `SqlSession` that stops at the request
  deadline.
- `c.get("pluginSignal")` is an `AbortSignal` that fires when the deadline
  passes.

```ts
ctx.routes.add({
  method: "GET",
  path: "/example",
  exposure: "public",
  contentType: "application/json",
  handler: async (c) => {
    const { rows } = await c.get("pluginDb").query("SELECT 1 AS one");
    return c.json({ rows });
  },
});
```

A worker command's `run(args, ctx)` also gets:

- `ctx.events.emit(event)`, which writes the outbox row and calls in-process
  handlers. It needs `capabilities.writes` with `"events"`. Register handlers in
  setup. `ctx.events.on` throws inside a command.
- `ctx.state`, durable JSON values under the plugin's name (`get`, `set`,
  `delete`). Keys starting with `core:` belong to the host.
- `ctx.signal`, which aborts when the run's time limit passes. The limit is the
  command's `timeoutMs` or the schedule's `maxRunMs`, whichever is smaller. The
  run then exits 1.

- `ctx.fetch(url, { expectedContent, maxBytes, expectedSha256? })`, a GET on
  the hosts the plugin lists in `capabilities.network`. Any other host is
  refused before a request is sent. Each GET reads the reviewed admission
  manifest, robots.txt and terms, waits its turn on the host's pacing and
  shares one byte budget with the run's other GETs. A plugin that declared
  `capabilities.writes` with `"cache"` gets a stored file under
  `raw/plugin-<name>/` (`path` is set). Otherwise, and inside a `none` or
  `request` scope, the body stays in memory. `body` holds it and `path` is
  empty. `ctx.signal` stops a request in flight, which then fails with
  `aborted`. `ctx.fetch.post` follows the delivery rules: declared hosts, no
  robots or terms read, no redirect, one attempt and a 5 s deadline.

Durable handlers run from `worker deliver-events`, which the core schedules
every minute. A handler gets each event at least once, so it must be
idempotent on `idempotencyKey`. After a failure the deliverer waits
`min(2^attempts, 3600)` seconds plus jitter and tries again, up to 20 attempts. A subscriber
only gets events emitted after the worker first saw it.

The test kit lives in the core package at `src/plugins/testing/`. It records
setup registrations in an isolated PGlite fixture and checks response columns,
row provenance, catalog triggers and event schemas. `checkCacheStore` and
`checkBlobStore` run the shared store contracts against a provider. It also creates disposable
source mutants and hashes response bytes. The fixture requires tests to inject
fetch calls. It does not exercise production admission or event delivery.
The SDK package does not export the kit.

`npm ci` builds the SDK through its prepare script. Other workspace packages have no
`prepare` script, because npm may run it before the SDK is built. Run `npm run build`
from the OpenPlans root to build the SDK, then the other workspace packages, then core. `npm test` includes
this package's tests. The SDK builds to `dist/`.

## Host status

A plugin that declares `capabilities.hostStatus: true` must also export a factory,
`createPlugin({ host })`. The core loader calls it and uses the returned plugin instead of the
default export. The returned manifest must match the default export's name, version, kinds and
capabilities. `host` is a frozen, read-only `StatusHost`: the core version, database pool
waits, response cache counters, a cache probe (only when the cache is on), the loaded plugins
(`HostPluginEntry`), whether a loaded plugin serves a pass-through source, that source's
hit rate, and coverage per scope (`HostAvailabilityEntry`) with the statuses
`/v1/data-availability` serves. Members return `undefined` when the process cannot tell.

`HostPluginEntry.sha256` is the package hash. Take every regular file and symbolic link under
the package root, the nearest directory above the entry file that holds a `package.json`. Skip
`node_modules` and every name that starts with a dot. Sort the entries by relative path, with
`/` separators, in code-unit order. Each file adds the line `<path>\0<hex SHA-256 of its
bytes>\n`, and each link adds `<path>\0link:<target>\n`. The hash is the hex SHA-256 of
those lines joined together. It is `null` for a tree over 10,000 files or 200 MiB, or one that
cannot be read.

