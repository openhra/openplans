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

Native network requests require an admission session or `OPENPLANS_ACCESS_MANIFEST`, an
absolute path to a reviewed external JSON manifest. A missing manifest fails with
`admission_required` before a network cache miss. Existing offline imports can reopen
hash-pinned cached bytes without a session; this verifies content and gives no new
access clearance. Observed host holds still apply. The environment setting creates a session for each fetch call;
multi-file jobs must pass one shared session to enforce their whole-job budget. Trusted
test transports can run offline without admission. Do not use transport injection to
collect live data.

`admissionManifestSchema` validates version 1 manifests. Each publisher entry records
`host`, `state`, observed HTTP evidence, product/state/year `scope`, `discoveryUrls`,
`permittedPaths`, `delegates`, `attribution`, `updatePolicy`, `delayMs` and `jobCaps`.
An API entry can also record `apiVersion`. The six access states are `allowed`,
`robots-disallowed`, `terms-restricted`, `bot-protected`, `geo-restricted` and `unknown`.
Every state except `allowed` holds collection. Unknown hosts also stay on hold.

An allowed entry requires `terms` with its URL, reviewed `disposition: allowed`, SHA-256,
`reviewedAt` and `expiresAt`, plus `robots` with its URL, HTTP status, SHA-256 and
`checkedAt`. A robots 404 uses a null hash. Review the terms for the intended operation
before marking an entry allowed. Reachability and robots permission do not establish
permission to reuse a publisher's data. Terms and robots verification currently require
same-host policy URLs; a policy hosted elsewhere needs a separate review.

The session fetches robots before terms or data, verifies the current terms hash and
rechecks both at least daily. A robots 404 records absent policy and still requires
reviewed terms. Other unsuccessful robots responses hold collection. Robots matching
uses the `openplans` product token, merged matching groups, wildcard fallback, longest
path matches, allow precedence for equal matches, percent normalization and end anchors.
Malformed rules hold collection. See [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html).

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

Observed geographic restrictions for `www.molinahealthcare.com` and
`nystateofhealth.ny.gov` remain on hold for an explicit owner decision. The observed
bot-protection hold for `dmhc.ca.gov` and `www.dmhc.ca.gov` also blocks requests and cache
reuse. `observedHostHolds` retains the reported country/status evidence. This module
does not change network routes, solve challenges or import browser sessions.

The fetcher selects its data directory from `dataDir`, then `OPENPLANS_DATA_DIR`, then `$HOME/.local/share/openplans`. Tests always provide a temporary directory. The fetcher does not write to the database.

Results use `outcome: downloaded | reused | not_modified`. Downloads default to a SHA-256 snapshot ID; optional `snapshotId` identifiers cannot overwrite existing content. A source-scoped hash match reuses its original snapshot and provenance. Pass `expectedSha256` to skip the request when that content is already cached; otherwise the hash is known only after streaming. Pre-request cache hits verify the stored hash and reapply the caller's current content and size limits. Pass `conditional: { etag, lastModified }` from a previous result to send validators. A 304 writes nothing. The fetcher withholds validators when a redirect changes origin.

Raw bytes live in `raw/<source>/<snapshot_id>/payload`, with the required `<snapshot_id>.meta.json` sidecar beside the directory. An internal `meta.json` permits atomic directory publication and sidecar recovery. Transfers use a temporary directory containing `payload.part`; errors remove it. For HTTP compression, `payload`, `sha256` and `bytes` describe the decoded content; `content_encoding` and `transferred_bytes` retain the wire encoding and size. `expectedSha256` always pins the decoded payload. Pre-request cache hits reapply both limits (older identity snapshots use `bytes` for both). Metadata is immutable when content is reused. The fetcher redacts all query values in provenance because unknown query keys may carry credentials. The redirect chain contains each destination in order, including the final destination.

Defaults: three attempts, five redirect hops, 10-second DNS/connect timeout, 30-second response/read inactivity timeout, 1 GiB transfer limit and 60-second maximum retry delay. Transient connection failures, truncation, 408/429 and 500/502/503/504 may retry with jitter. Retry-After accepts seconds and HTTP dates; a value beyond the delay budget stops retries rather than retrying too soon. 401/403 and policy/content/cache rejections never retry. Requests still ask for identity encoding. If the publisher sends HTTP `Content-Encoding: gzip`, `deflate` (zlib-wrapped) or `br`, a streaming decoder enforces `maxDecompressedBytes` on actual emitted bytes before writing them. This cap defaults to `maxBytes`, so existing callers also bound decoded output. `maxBytes` independently bounds transfer bytes, and Content-Length is checked against that transfer count. Unsupported or stacked encodings fail with `unsupported_encoding`; invalid/incomplete compressed streams fail with `truncated`. Crossing either byte cap fails with `too_large`, destroys the streams and removes the staging directory and `payload.part` without publishing a snapshot. Stream backpressure bounds decoder buffering. The fetcher never writes the first chunk that crosses the cap.

JSON requests send `Accept: application/json, */*;q=0.1` (some publishers answer 406 to a strict JSON-only Accept, e.g. issuer 66252 serves its index as text/plain). The client identifies itself as
`openplans/0.1 (public health-plan source discovery; +<project URL>)`. Configure the public
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
