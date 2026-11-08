# Safe public-source acquisition

Import `fetchToCache`, `inspectZip` and `FetchError` from `./index.js`.

```ts
const result = await fetchToCache(publisherUrl, {
  source: 'cms-puf',
  allowHosts: ['www.cms.gov', 'data.healthcare.gov'], // Reviewed exact hosts, including delegates.
  expectedContent: 'zip',
  maxBytes: 1024 ** 3,               // HTTP transfer bytes
  maxDecompressedBytes: 2 * 1024 ** 3, // Decoded payload bytes
  zipLimits: { maxMembers: 100, maxUncompressedBytes: 8 * 1024 ** 3, maxExpansionRatio: 200 },
});
```

The fetcher selects its data directory from `dataDir`, then `OPENPLANS_DATA_DIR`, then `$HOME/.local/share/openplans`. Tests always provide a temporary directory. The fetcher does not write to the database.

Results use `outcome: downloaded | reused | not_modified`. Downloads default to a SHA-256 snapshot ID; optional `snapshotId` identifiers cannot overwrite existing content. A source-scoped hash match reuses its original snapshot and provenance. Pass `expectedSha256` to skip the request when that content is already cached; otherwise the hash is known only after streaming. Pre-request cache hits verify the stored hash and reapply the caller's current content and size limits. Pass `conditional: { etag, lastModified }` from a previous result to send validators. A 304 writes nothing. The fetcher withholds validators when a redirect changes origin.

Raw bytes live in `raw/<source>/<snapshot_id>/payload`, with the required `<snapshot_id>.meta.json` sidecar beside the directory. An internal `meta.json` permits atomic directory publication and sidecar recovery. Transfers use a temporary directory containing `payload.part`; errors remove it. For HTTP compression, `payload`, `sha256` and `bytes` describe the decoded content; `content_encoding` and `transferred_bytes` retain the wire encoding and size. `expectedSha256` always pins the decoded payload. Pre-request cache hits reapply both limits (older identity snapshots use `bytes` for both). Metadata is immutable when content is reused. The fetcher redacts all query values in provenance because unknown query keys may carry credentials. The redirect chain contains each destination in order, including the final destination.

Defaults: three attempts, five redirect hops, 10-second DNS/connect timeout, 30-second response/read inactivity timeout, 1 GiB transfer limit and 60-second maximum retry delay. Transient connection failures, truncation, 408/429 and 500/502/503/504 may retry with jitter. Retry-After accepts seconds and HTTP dates; a value beyond the delay budget stops retries rather than retrying too soon. 401/403 and policy/content/cache rejections never retry. Requests still ask for identity encoding. If the publisher sends HTTP `Content-Encoding: gzip`, `deflate` (zlib-wrapped) or `br`, a streaming decoder enforces `maxDecompressedBytes` on actual emitted bytes before writing them. This cap defaults to `maxBytes`, so existing callers also bound decoded output. `maxBytes` independently bounds transfer bytes, and Content-Length is checked against that transfer count. Unsupported or stacked encodings fail with `unsupported_encoding`; invalid/incomplete compressed streams fail with `truncated`. Crossing either byte cap fails with `too_large`, destroys the streams and removes the staging directory and `payload.part` without publishing a snapshot. Stream backpressure bounds decoder buffering. The fetcher never writes the first chunk that crosses the cap.

JSON requests send `Accept: application/json, */*;q=0.1` (some publishers answer 406 to a strict JSON-only Accept, e.g. issuer 66252 serves its index as text/plain). The client identifies itself as
`openplans/0.1 (public health-plan source discovery; +<project URL>)`. Configure the public
homepage with `OPENPLANS_PROJECT_URL` (or `FetchOptions.projectUrl`); the default is the
project homepage `https://plans.openhra.com/`. A self-hoster may point it at their own page. Credentials, query
values and fragments are rejected in this identity URL. It does not identify itself as a browser.

Request failures retain `FetchError.evidence`: redacted requested/final URLs and redirect
chain, validated destination address, attempt count, connection deadline and selected
response headers. Cookies and arbitrary response headers are excluded. QHP discovery
persists this evidence for failed indexes, mapping HTTP 403 to `access_denied` without retry.

HTTPS certificate verification remains enabled. DNS answers must all be public, and the selected address is pinned to the connection while TLS checks the original publisher name. Exact host allowlists include every redirect delegate. The fetcher blocks special-use and IPv6 transition/translation ranges as a precaution. `lookup` and `transport` are trusted injection points for tests; untrusted registry input must never control them.

ZIP inspection supports single-disk ZIP and ZIP64, reading bounded end records and each central-directory member without extraction. Default limits are 10,000 members, 1 GiB archive bytes, 8 GiB declared uncompressed bytes, and a 200:1 per-member and aggregate expansion ratio. Absolute/traversal paths, symlinks, encrypted/multidisk archives and inconsistent local names are rejected. Inspection does not decompress members or validate CRCs. Subsequent streaming archive readers must independently cap actual emitted bytes. JSON nesting, string/record byte limits ([defaults and measured TX maxima](../ingest/json/README.md)), CSV record length, parsing, batching and publication completeness belong to ingestion; this module does not parse records or publish DB snapshots.

All rejection errors have a stable `FetchError.code`; HTTP failures also carry `status`. Error messages exclude response bodies, URLs and underlying driver errors. Offline tests use injected DNS, loopback-only servers and generated synthetic archive fixtures. Native TLS tests generate an ephemeral certificate with the system `openssl`; no private key is retained.
