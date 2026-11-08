# Runtime response cache

The API defaults to one local LRU per process, capped at 64 MiB of UTF-8 keys and
serialized values (`OPENPLANS_API_CACHE_MB`). JavaScript object/Map overhead is
additional. Expiration is checked on reads and before writes/stat sampling. Set
`OPENPLANS_API_CACHE=off` to bypass all caching. It does not disable authentication.

For a shared cache, enable the Compose `cache` profile and set
`OPENPLANS_CACHE_URL=redis://cache:6379`. The URL is deliberately credential-free
and supports a single server/database. The service has no host port, uses a tmpfs,
disables snapshots and AOF, and evicts with `allkeys-lru` at
`OPENPLANS_CACHE_MEMORY` (default `256mb`). A fresh service starts empty.

Valkey 8.1 is used because its [BSD-3-Clause distribution](https://github.com/valkey-io/valkey/blob/8.1/COPYING)
and [RESP protocol](https://valkey.io/topics/protocol/) support a small GET/SET EX
client without adding dependencies. Compared with another caching daemon this
keeps a familiar operational interface (`valkey-cli`) and server-side TTL/eviction.
Each command opens a bounded TCP connection with a 150 ms total deadline; replies
and stored responses are limited to 2 MiB. There is no reconnect queue. Read or
write failures return the application response with `X-Cache: bypass`, and never
switch to a potentially stale secondary cache. There is no API dependency on the
service being healthy at startup. For LRU mode, leave the URL unset even if the
profile is enabled for inspection.

Only these request-dependent searches opt in:

| Endpoint | TTL seconds |
| --- | ---: |
| GET `/v1/plans`, `/v1/providers`, `/v1/drugs`, `/compat/v1/drugs` | 60 |
| GET `/v1/zip-counties`, `/compat/v1/zip_counties` | 300 |
| GET `/v1/benchmark`, POST `/v1/premium-estimates` | 30 |
| POST `/compat/v1/plans/medical/search`, `/compat/v1/plans/dental/search` | 30 |
| POST `/compat/v1/providers/search` | 60 |

Successful JSON responses only are stored. Health, errors, other routes/methods,
cookies, credential-named body/query fields, and unexpected credential headers
bypass. Accepted auth headers are checked on every request before lookup, excluded
from the key, and never stored. Personalized and compatibility responses retain
`Cache-Control: no-store` for HTTP clients/proxies; this is a separate private
application cache. Only selected content/CORS/evidence headers are stored. Do not
add request/body access logging, including at a reverse proxy.

The key is SHA-256 over method, endpoint, sorted query parameters, canonical JSON
body, and the current data generation. Object key order is ignored; array order
and repeated query value order are retained. API keys do not partition entries.

Migration 920 installs `api_data_changed` statement triggers on every current
public import/publication table (except the migration ledger and PostGIS reference
table). The trigger updates a per-table counter once per writer transaction;
commit publishes the data and counters atomically, and rollback publishes neither.
`COPY`, INSERT, UPDATE, DELETE, and TRUNCATE all invalidate. Independent tables have
separate generation locks. Concurrent writers of the same table serialize as they
already can on publication rows; bulk importers should keep their transactions
bounded. The ledger includes a database-specific seed to isolate separate catalogs
sharing a cache. Each lookup reads and hashes the complete small ledger, without
a generation TTL. An unavailable/missing ledger bypasses caching.

**New import tables must register the same trigger in their migration.** The
registration test fails if a current public table is omitted. Restoring data with
triggers disabled requires stopping the API and clearing the cache, or changing
the ledger seed/revision before restarting. Normal imports need no cache flush.
A ZIP request that invokes optional live geography resolution can write new evidence;
that transaction invalidates the earlier generation and the next request misses.

Every response has `X-Cache: hit|miss|bypass`. `/v1/cache-stats` includes process-local
`hits`, `misses`, `bypasses`, `bytes`, `backend`, and `bytes_scope`. Misses count
successful cacheable lookups/writes; errors count as bypasses. LRU bytes count
resident keys/values; external bytes count cumulative successfully transferred
payload bytes, not Valkey resident memory. Inspect shared memory/evictions with
`docker compose --profile cache exec cache valkey-cli INFO memory` and `INFO stats`.
Counters reset when the API restarts; they never include requests or credentials.
