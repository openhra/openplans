# Safe public-source acquisition

Import `AdmissionSession`, `fetchToCache`, `inspectZip` and `FetchError` from `./index.js`.

```ts
const admission = new AdmissionSession('/external-data/access/publishers.json');
const result = await fetchToCache(publisherUrl, {
  admission, // Reuse this session for every request in the collection job.
  source: 'cms-puf',
  allowHosts: ['www.cms.gov', 'data.healthcare.gov'], // Reviewed exact hosts, including delegates.
  expectedContent: 'zip',
  maxBytes: 1024 ** 3,               // HTTP transfer bytes
  maxDecompressedBytes: 2 * 1024 ** 3, // Decoded payload bytes
  zipLimits: { maxMembers: 100, maxUncompressedBytes: 8 * 1024 ** 3, maxExpansionRatio: 200 },
});
```

Every native network request runs under an admission session. A session comes from, in order:

1. `FetchOptions.admission`, a session the caller passes in;
2. `OPENPLANS_ACCESS_MANIFEST`, an absolute path to an operator's reviewed JSON manifest, layered
   over the shipped manifests;
3. the shipped manifests alone, used only for a network cache miss.

OpenPlans ships reviewed manifests for the federal public-domain hosts a new installation needs
([`data/access/`](../../data/access/README.md)), so `worker bootstrap` works on an empty cache with no
setup. A later manifest's entry replaces an earlier entry for the same host. An operator manifest
can therefore add insurer hosts, or re-review a shipped host. `OPENPLANS_SHIPPED_ACCESS=off`
withdraws the shipped manifests. With none of the three, a cache miss fails with
`admission_required`. Existing offline imports can reopen hash-pinned cached bytes without a
session; this verifies content and gives no new access clearance. Observed host holds still apply.

The environment and shipped sessions are created per fetch call. Such a session may transfer the
call's own `maxBytes` plus its policy reads (at least 50 MiB), and each host's `jobCaps` still bind
it. Multi-file jobs must pass one shared session to enforce their whole-job budget. Trusted test
transports run offline without admission. Do not use transport injection to collect live data.

Refusals name their cause: a host missing from every manifest, a host the manifest holds (for
example `robots-disallowed`), a missing or expired terms review, or a path outside
`permittedPaths`.

`admissionManifestSchema` validates version 1 manifests. Each publisher entry records
`host`, `state`, observed HTTP evidence, product/state/year `scope`, `discoveryUrls`,
`permittedPaths`, `delegates`, `attribution`, `updatePolicy`, `delayMs` and `jobCaps`.
An API entry can also record `apiVersion`. The six access states are `allowed`,
`robots-disallowed`, `terms-restricted`, `bot-protected`, `geo-restricted` and `unknown`.
Every state except `allowed` holds collection. Unknown hosts also stay on hold.

An allowed entry requires `terms` with its URL, reviewed `disposition: allowed`, SHA-256,
`reviewedAt` and `expiresAt`, plus `robots` with its URL, HTTP status, SHA-256 and
`checkedAt`. `terms` can also record its `reviewer` and the quoted publisher text it rests on
(`basis`); shipped manifests always do. A robots 404 or 410 uses a null hash and must also record `country`, the
egress country it was seen from. Review the terms for the intended operation before marking
an entry allowed. Reachability and robots permission do not establish permission to reuse a
publisher's data. Robots is always read from the data host. Terms may sit on another host,
such as the publisher's main site. The session then reads that host's robots file first, and
reads the terms only if it permits the terms path or answers a direct 404 or 410. The terms
host gets no data clearance. Receipts record the terms URL and that host's robots status and
hash.

The session fetches robots before terms or data, verifies the current terms hash and
rechecks both at least daily. A 404 or 410 at `/robots.txt`, answered directly with no
redirect, means the host publishes no robots rules (RFC 9309 section 2.3.1.3). It counts only
when the manifest also recorded that absence, with the country it was observed from. The
session's egress country (`egressCountry`, else `OPENPLANS_EGRESS_COUNTRY`, else
`access.egressCountry` in the config file) goes into every
receipt, or `null` when unset. It does not restrict collection, because self-hosters collect
from many countries. Terms still need review. Every other unsuccessful robots
response holds collection: 401, 403, 429, 451, 5xx, timeouts and any 404 reached through a
redirect. A robots file served as HTML holds too, because it is not directives. If a file appears at
the daily recheck, the session parses and obeys it. Receipts record the egress country and whether
robots was absent.

### Keyed APIs

Some publishers serve data only through an API that needs a key, and such a host answers every
request without the key with 401, `/robots.txt` included. A 401 at robots normally holds
collection. An entry with `accessMode: "api-key"` changes that for one host:

- `robots` records the observed 401 with a null hash and a `notApplicable` reason. A live 401 then
  counts as "robots not applicable". A robots file served with 200 is still parsed and obeyed, and
  any other status still holds.
- Admission rests on the published API documentation, which goes in `terms` (URL, reviewed
  disposition, SHA-256). The session checks that hash before the first keyed request and daily
  after that, like any terms document.
- `apiKey: { env, queryParam }` names the environment variable that holds the key and the query
  parameter the publisher documents for it. Without the key the session refuses the host before
  any request. `AdmissionOptions.apiKeys` can pass the key for one host instead.
- The fetcher adds the key only to the URL it hands the transport for a data request. Robots and terms
  reads never carry it. Evidence, metadata, receipts and errors use the URL without the key, and
  query values are redacted anyway. Receipts record `accessMode: "api-key"`, the parameter name
  and `robots.notApplicable: true`, never the key.
- `delayMs` may go down to 1000 ms for a keyed entry; every other entry stays at 5000 ms or more.
  The host lease uses the same 1 s floor plus up to 1 s of jitter.

`data/access/cms-marketplace-api.json` is such an entry for the CMS Marketplace API. The fetcher
loads it with the shipped manifests only when `OPENPLANS_CMS_FALLBACK=on`. By default the host
has no reviewed entry and every request to it is refused.

### Egress records

A collection wrapper that routes a job through a chosen country can hand the job an egress
record: `OPENPLANS_EGRESS_FILE` (absolute path to a schema 1 JSON record) and
`OPENPLANS_EGRESS_SHA256` (the hash of its bytes). The session reads the record once when it is
built and refuses to start unless:

- the bytes match the hash, and the record matches schema 1;
- the wrapper checked the exit before the window started, and that check placed it in the record's country;
- the window is still open (`maxEndAt` in the future, at most 24 hours long) and no
  `<windowId>.result.json` sits next to the record;
- `OPENPLANS_EGRESS_COUNTRY` and a bulk spec's `egressCountry`, when set, name the same country.

The record's country then wins over `OPENPLANS_EGRESS_COUNTRY`. Before each admission the session
hashes the record again and checks the window, and it stops on any change. Every host receipt
gets an `egress` block with the record hash, window, kind, provider, country, server, check method and time,
and the exit address only as a SHA-256 salted with the window id. The session never copies the raw
address. Without the variable, `egress` is `null` and nothing else changes.

A publisher entry can set `requiredEgressCountry` (for example `"US"`) when the host serves its
files to one country only. The session refuses such a host unless it holds a valid record for
that country. A declared country alone is not enough. The egress changes where a request comes
from, never what it may fetch: robots, terms and the stop rules still apply.

Robots matching uses the `openplans` product token, merged matching groups, wildcard
fallback, longest path matches, allow precedence for equal matches, percent normalization
and end anchors. Parsing follows section 2.3.1.5: unparseable lines are skipped and the
parseable rules apply. The parser adds a missing leading slash to a path. A Crawl-delay or
Disallow before any user-agent line applies to every agent; an Allow there is ignored. A
group is chosen by its product token, so `OpenPlans/1.0` counts as `openplans` and `Example
Spider 2.0` as `example`. A wildcard agent pattern that matches `openplans` adds its Disallow
lines. A Disallow written without its colon, or spelled `Dissallow`, still counts. See
[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html).

A source directory can hold a `QUARANTINE.json` marker listing snapshots fetched before
admission existed. The cache never reuses a listed snapshot, offline or online, unless
`<snapshot>.readmitted.json` names its exact hash and size and a stored admission receipt,
by path and hash, that admits its host. Downloading identical bytes under a current
admission writes that readmission. If the publisher now serves different bytes, the download
becomes a new admitted snapshot and the listed one stays refused; a readmission names one
snapshot and never covers another. `assertSnapshotAdmissible(dataDir, metadata)` applies the
same rule for readers that open cached snapshots directly, such as the bootstrap's cached release
pages.

Within an admitted session, every data URL, redirect and cached snapshot destination needs current clearance.
`permittedPaths` match a path or its descendants, so `/feed` does not admit `/feed-other`.
Cross-host redirects also require the originating host's explicit `delegates` entry
and the delegate's own terms and robots clearance. The manifest stays pinned by hash
through publication; a change stops the session and removes staging. Reused snapshots
keep their original metadata and return a fresh `result.admission` receipt. New snapshots
also store that receipt as `metadata.access_policy`.

Collection defaults are 200 requests and 50 MiB transferred per session, including policy
requests, retries and redirects. Each host's `jobCaps` can impose lower limits. Policy
documents have a 512 KiB transfer and decoded-byte cap. Explicit session limits support
separately reviewed larger jobs. Byte-limit failures, access denials and challenge pages
stop the session. They never publish a replacement snapshot. The fetcher does not
activate database records; ingestion must still prove source-set completeness.

All admitted sessions sharing a data directory use `access/hosts/` leases. A host has
one request in flight, at least five seconds between starts and up to one second of
additional jitter. A longer manifest or robots crawl delay takes precedence. The lease
lasts until the body is consumed or destroyed. An unavailable lease fails after 60
seconds. Abandoned locks require operator review; the fetcher never deletes another
process's lock. Jobs must share the same data directory to share these limits.

A host with an observed geographic restriction or bot protection stays on hold until a
separate access decision. The hold blocks requests and cache reuse. `observedHostHolds`
keeps the reported country and status evidence. This module does not change network
routes, solve challenges or import browser sessions.

The fetcher selects its data directory from `dataDir`, then `OPENPLANS_DATA_DIR`, then `access.dataDir` in the config file, then `$HOME/.local/share/openplans`. Tests always provide a temporary directory. The fetcher does not write to the database.

Results use `outcome: downloaded | reused | not_modified`. Downloads default to a SHA-256 snapshot ID; optional `snapshotId` identifiers cannot overwrite existing content. A source-scoped hash match reuses its original snapshot and provenance. Pass `expectedSha256` to skip the request when that content is already cached; otherwise the hash is known only after streaming. Pre-request cache hits verify the stored hash and reapply the caller's current content and size limits. Pass `conditional: { etag, lastModified }` from a previous result to send validators. A 304 writes nothing. The fetcher withholds validators when a redirect changes origin.

Raw bytes live in `raw/<source>/<snapshot_id>/payload`, with the required `<snapshot_id>.meta.json` sidecar beside the directory. An internal `meta.json` permits atomic directory publication and sidecar recovery. Transfers use a temporary directory containing `payload.part`; errors remove it. For HTTP compression, `payload`, `sha256` and `bytes` describe the decoded content; `content_encoding` and `transferred_bytes` retain the wire encoding and size. `expectedSha256` always pins the decoded payload. Pre-request cache hits reapply both limits (older identity snapshots use `bytes` for both). Metadata is immutable when content is reused. The fetcher redacts all query values in provenance because unknown query keys may carry credentials. The redirect chain contains each destination in order, including the final destination.

The cache reads and writes all of these files through a blob store in `src/fetch/blob/`, chosen by `config.blobs.provider`. The default `local` store uses each key as a path under the data directory, so the tree above is unchanged byte for byte. Its `publish` is a rename. A failed `put` leaves no key behind. A caller can pass its own store as `blobStore`. A store that cannot name a local path for each key, such as `blob-s3`, runs behind `RemoteFetchStore` in `blob/remote.ts`. The download goes to a private spool file under `blob-spool` in the data directory, and the size, hash and ZIP checks run on that file. Then `put` uploads the payload and `meta.json` under a temporary key and `publish` moves them, `meta.json` last. A reader finds the snapshot only after its payload is in place. Results name a copy under `blob-read` that the store's own `get` read back and checked against the recorded hash. When a publish fails, the cache deletes the `.pending-` objects it wrote with the store's `delete`. It never deletes a published key, and `RemoteFetchStore.delete` refuses one. A crash between `put` and `publish` can still leave a `.pending-` object; readers skip those keys. Ingest steps that read cached snapshots outside `fetchToCache` use `src/fetch/snapshots.ts`, which resolves sidecars and payloads through the same store. A listing reads sidecars only. The reader copies a payload down when it opens one. PUF `manifest-*.json` files and the Census request index under `raw/census-geocoder-requests` record what was acquired, so they go where the snapshots they name go. With a remote store the cache writes them to it, and any host that shares the store can import from them. When a `snapshot.raw_path` row names a file another host wrote, the reader finds the payload through the store by the path's `raw/<source>/<snapshot>/payload` tail. With the `local` store each key is the file under `raw/` it always was. Host leases, `QUARANTINE.json` and readmission records stay plain files. Inside a `none` or `request` cache scope the local store refuses every write, even when called directly.

`requestBody: { contentType, body }` sends the data request as a POST, for publisher APIs that take
an upload such as the Census batch geocoder. It needs `maxRedirects: 0`, so a body is never resent
to another location. Robots and terms reads stay GET. The response is cached by content hash like any
other snapshot, and callers keep their own request index for reuse (the geocoder keys it by the
uploaded rows). Such a snapshot cannot be re-admitted by downloading it again; a quarantined POST
response stays refused. `onRequest` is called before each data request, not before policy reads.

Defaults: three attempts, five redirect hops, 10-second DNS/connect timeout, 30-second response/read inactivity timeout, 1 GiB transfer limit and 60-second maximum retry delay. Transient connection failures, truncation, 408/429 and 500/502/503/504 may retry with jitter. Retry-After accepts seconds and HTTP dates; a value beyond the delay budget stops retries rather than retrying too soon. 401/403 and policy/content/cache rejections never retry. Requests still ask for identity encoding. If the publisher sends HTTP `Content-Encoding: gzip`, `deflate` (zlib-wrapped) or `br`, a streaming decoder enforces `maxDecompressedBytes` on actual emitted bytes before writing them. This cap defaults to `maxBytes`, so existing callers also bound decoded output. `maxBytes` independently bounds transfer bytes, and Content-Length is checked against that transfer count. Unsupported or stacked encodings fail with `unsupported_encoding`; invalid/incomplete compressed streams fail with `truncated`. Crossing either byte cap fails with `too_large`, destroys the streams and removes the staging directory and `payload.part` without publishing a snapshot. Stream backpressure bounds decoder buffering. The fetcher never writes the first chunk that crosses the cap.

JSON requests send `Accept: application/json, */*;q=0.1` (some publishers answer 406 to a strict JSON-only Accept, e.g. issuer 66252 serves its index as text/plain). The client identifies itself as
`openplans/0.4.3 (public health-plan source discovery; +<project URL>)`. Configure the public
contact page with `OPENPLANS_PROJECT_URL` (or `FetchOptions.projectUrl`); the default is
`https://plans.openhra.com/`, which contains the captcha-protected contact form. A self-hoster may point it at their own contact page. Credentials, contact-email literals, query
values and fragments are rejected in this identity URL. It does not identify itself as a browser.

Request failures retain `FetchError.evidence`: redacted requested/final URLs and redirect
chain, validated destination address, attempt count, connection deadline and selected
response headers. Cookies and arbitrary response headers are excluded. QHP discovery
persists this evidence for failed indexes, mapping HTTP 403 to `access_denied` without retry.

HTTPS certificate verification remains enabled. DNS answers must all be public, and the selected address is pinned to the connection while TLS checks the original publisher name. Exact host allowlists include every redirect delegate. The fetcher blocks special-use and IPv6 transition/translation ranges as a precaution. `lookup` and `transport` are trusted injection points for tests; untrusted registry input must never control them.

ZIP inspection supports single-disk ZIP and ZIP64, reading bounded end records and each central-directory member without extraction. Default limits are 10,000 members, 1 GiB archive bytes, 8 GiB declared uncompressed bytes, and a 200:1 per-member and aggregate expansion ratio. Absolute/traversal paths, symlinks, encrypted/multidisk archives and inconsistent local names are rejected. Inspection does not decompress members or validate CRCs. Subsequent streaming archive readers must independently cap actual emitted bytes. JSON nesting, string/record byte limits ([defaults and measured TX maxima](../ingest/json/README.md)), CSV record length, parsing, batching and publication completeness belong to ingestion; this module does not parse records or publish DB snapshots.

All rejection errors have a stable `FetchError.code`; HTTP failures also carry `status`. Error messages exclude response bodies, URLs and underlying driver errors. Offline tests use injected DNS, loopback-only servers and generated synthetic archive fixtures. Native TLS tests generate an ephemeral certificate with the system `openssl`; no private key is retained.

## Bounded collection jobs

`node dist/fetch/bulk.js run /absolute/collection.json` collects an explicit list of
reviewed public files. Stage the compiled code, dependencies, admission manifest and
spec in the supervisor's durable working directory before submission. Each job uses
one admission session and the shared host limiter. Requests have one attempt. The
spec rejects budgets above 20 GiB or 24 hours; a wall deadline also stops transfers
through the admission byte counter.

The spec contains `id`, `dataDir`, `admissionManifest`, `reportPath`, `allowHosts`,
`targets`, `maxTransferBytes`, `maxFileBytes`, `maxRequests` and `wallSeconds`.
Each target declares `url`, `source` and `expectedContent`, with optional
`expectedSha256` for cache reuse and `jsonArray` for streaming large JSON arrays.
All three filesystem paths must be absolute. Target URLs use HTTPS and cannot
contain credentials, query strings or fragments. Use the same external data directory
as other collection jobs. A host review is required even when bytes are cached.

The report records source URLs, original retrieval times, hashes, byte counts and
fresh admission receipts. JSON arrays and CSV records must reach EOF. ZIP members
are streamed to check decoded sizes and CRCs without extracting files. CSV column
count differences are counted without changing source bytes. Syntax errors mark
that raw artifact `quarantined` and collection continues; acquisition, admission,
hash and budget failures stop the job. A completed collection can contain
quarantined artifacts and does not establish ingestion readiness or complete plan
coverage. The collector never writes to a serving database.

Use `node dist/fetch/bulk.js probe /absolute/collection.json` as the supervisor's
short read-only completion probe. It checks the completed target set, metadata,
receipt manifest hash and file sizes. `verify` instead rehashes every payload and
repeats parsing, including the recorded quarantine outcomes. Run that full check
for subsequent dataset review; large files can exceed a supervisor's probe timeout.

## Transient requests

`fetchTransient(url, options)` returns `{ body: Buffer, sha256, admission, status, headers, finalUrl, redirectChain }`.
The two URL fields drop query values, as the evidence does.
Use it for requests whose responses must stay in memory, including delivery endpoints.
It accepts any successful 2xx status. It creates no payload files, policy-document files,
metadata sidecars or database snapshot rows. The required shared host lease still updates
pacing state under `access/hosts/`.

Pass `allowHosts` and an `AdmissionSession`, or use the shipped and operator manifests.
Admission is required even with an injected transport. Robots and terms reads use the same
session and byte budget, but their bodies stay in memory too. Every redirect needs URL,
DNS and admission clearance. The session checks its manifest, terms and egress again
before returning the body. Keys go only on the data request URL; evidence redacts query values.
The request identity matches `fetchToCache`.

`maxBytes` defaults to 2 MiB and bounds transferred bytes. `maxDecompressedBytes` defaults
to that limit and bounds decoded bytes. `expectedContent` defaults to `binary`; use `json`
or `csv` to reject HTML error pages. Access challenges stop every content mode.
Only the selected evidence headers are returned; cookies and arbitrary headers are excluded.
Retries follow the cache fetcher's status, jitter and Retry-After rules.

`deadlineMs` defaults to 30 seconds for the whole call, including policy reads, host pacing,
redirects and retries. Expiry fails with `read_timeout`, destroys response streams and stops
the session. A lease still pending at expiry is released when acquired, without sending a
request. `requestBody: { contentType, body }` sends a POST and requires `maxRedirects: 0`.
Policy reads remain GET, and the upload is never sent to a redirect target.
`requestHeaders` adds headers to the upload only. Names must be lower-case `x-openplans-*`.

`purpose: "delivery"` marks one POST to an operator-declared endpoint, such as a plugin's
event receiver. A delivery is not data collection, so it skips the robots and terms reads and
takes no host lease, so it is not paced. The host must still be in `allowHosts` and `allowed`
in the manifest with current terms. The call must send `requestBody` with `maxRedirects: 0`,
`maxAttempts: 1` and a `deadlineMs` of 5000 or less; anything else fails with
`invalid_options`. Every other call is `collection` and keeps the rules above. Plugins reach
this only through `ctx.fetch.post` in the worker (`src/plugins/fetch.ts`).

A transport may honour `context.signal`; `httpsTransport` closes the connection when it aborts
and fails with `aborted`. Plugin worker commands wrap their transport with
`abortableTransport` (`src/plugins/fetch.ts`), so `ctx.signal` stops a request even when the
transport ignores the signal.
