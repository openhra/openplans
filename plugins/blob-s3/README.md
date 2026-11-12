# S3-compatible blob store

`@openplans/blob-s3` registers the `s3` blob provider. It keeps blobs in one bucket of any
S3-compatible object store under the keys the local store uses, such as
`raw/<source>/<snapshot>/payload` and `meta.json`. It needs no SDK. The store signs each request with
Signature Version 4 using Node's `crypto` and sends it with `node:http` or `node:https`.

## What it does

- **`put`** uploads a body with its SHA-256 in `x-amz-meta-sha256`. A body up to `partBytes`
  (64 MiB by default) goes up in one request. A larger one goes up as a multipart upload in
  parts of `partBytes`, so at most two parts are in memory at once. A multipart put needs the
  expected SHA-256 in `meta.sha256`, because S3 takes an object's metadata when the upload
  starts. Each part is signed with its own SHA-256, which the server checks. The whole body's
  SHA-256 must match before the upload is completed, and the finished object must have the
  size sent and the recorded hash. Any failure aborts the upload; a finished object that fails
  the last check is deleted. `put` refuses bodies over `maxObjectBytes` (5 GiB by default). A
  key that already exists is refused with `EEXIST`, by a `HEAD` check and by
  `If-None-Match: *`. A failed or mismatched put leaves no object.
- **`delete(key)`** removes one object. A missing key is not an error.
- **`get`** checks the body against the recorded SHA-256 while it streams. A mismatch, or an
  object with no recorded hash, throws before the stream ends. Treat a stream that throws as
  a failed read.
- **`list(prefix)`** returns the direct children of `prefix`, the way the local store does:
  `prefix/name` for an object and `prefix/name/` for a deeper prefix. It follows
  continuation tokens until the listing ends.
- **`publish(temporary, final)`** moves one key, or every key under a prefix. First it checks
  that `final` does not exist as a key or as a prefix; if it does, it refuses with `EEXIST`,
  as a rename onto a non-empty directory does. Then it copies each object, checks each copy's
  size and SHA-256 against its source, and deletes the sources only when every copy matches.
  If a copy fails, the copies already made are removed and the sources are kept. After a
  successful publish no temporary key is left.
- **Cache levels.** The core wraps every plugin blob store it hands out, so in a `none` or
  `request` cache scope `put` and `publish` refuse with `storage_forbidden` and the store is
  never called. The store also takes its own `forbidsStorage` check, which does the same before
  sending any request. Reads still work.

The fetch cache runs on this store. It downloads to a private spool file under the data
directory and checks size and SHA-256 there. Then it uploads the payload and `meta.json` with
`put` and moves them with `publish`, payload first, so a reader never finds half a snapshot.
Fetch results name a local copy that `get` read back and checked. If a publish fails, the
cache deletes the temporary `.pending-` objects it wrote; it never deletes a published key.
Large payloads, such as the national NPPES file, go up as multipart uploads. The 5 GiB
default for `maxObjectBytes` follows from `publish`, which moves an object with a single copy
request, and S3 limits a single copy to 5 GiB.

Ingest steps that look up an earlier snapshot or open one acquired before (geography, SBE,
RxNorm, NPPES, PUF, QHP discovery and feed sources) read through the same store, so they find
snapshots kept here.

## Settings

Endpoint, region, bucket and credentials are secrets the plugin declares. It reads them from
the environment.

| Variable                              | Meaning                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `OPENPLANS_BLOB_S3_ENDPOINT`          | `https://host[:port]`, no path. Plain `http:` only for a loopback host.  |
| `OPENPLANS_BLOB_S3_REGION`            | Signing region, such as `us-east-1`.                                     |
| `OPENPLANS_BLOB_S3_BUCKET`            | Bucket name. Requests use path-style addressing (`/<bucket>/<key>`).     |
| `OPENPLANS_BLOB_S3_ACCESS_KEY_ID`     | Access key ID.                                                           |
| `OPENPLANS_BLOB_S3_SECRET_ACCESS_KEY` | Secret access key.                                                       |
| `OPENPLANS_BLOB_S3_SESSION_TOKEN`     | Optional session token. List it under `optionalSecrets` when you omit it. |

The plugin never logs these values. Errors give the operation, the HTTP status and the
server's error code only, because S3 error bodies can echo signed request details.

The plugin options are all optional. They are `prefix` (a key prefix inside the bucket), `maxObjectBytes`,
`partBytes` (5 MiB to 5 GiB) and `timeoutMs` (per request, 60 000 by default).

```json
{
  "version": 1,
  "blobs": { "provider": "s3" },
  "plugins": [
    {
      "package": "@openplans/blob-s3",
      "options": { "prefix": "openplans" },
      "optionalSecrets": ["OPENPLANS_BLOB_S3_SESSION_TOKEN"]
    }
  ]
}
```

## Admitting the endpoint host

The endpoint host needs an `allowed` entry in the operator access manifest
(`OPENPLANS_ACCESS_MANIFEST`), with a current terms review. Setup refuses to start without
one. The core reads the same file for every fetch, so the entry must pass the full manifest
schema. Here is an entry for a bucket at `objects.example.net`. Replace the host, URLs, dates
and terms hash with your own review.

```json
{
  "version": 1,
  "publishers": [
    {
      "host": "objects.example.net",
      "state": "allowed",
      "evidence": [
        {
          "url": "https://objects.example.net/",
          "observedAt": "2026-11-11T00:00:00.000Z",
          "status": 403
        }
      ],
      "scope": {
        "products": ["OpenPlans blob store bucket"],
        "states": ["US"],
        "years": [2026]
      },
      "discoveryUrls": ["https://objects.example.net/"],
      "permittedPaths": ["/"],
      "delegates": [],
      "attribution": "Operator-owned object storage",
      "updatePolicy": "Operator review when the storage contract changes",
      "delayMs": 5000,
      "jobCaps": { "maxRequests": 1, "maxTransferBytes": 1 },
      "robots": {
        "url": "https://objects.example.net/robots.txt",
        "status": 404,
        "sha256": null,
        "checkedAt": "2026-11-11T00:00:00.000Z",
        "country": "US"
      },
      "terms": {
        "url": "https://objects.example.net/terms",
        "disposition": "allowed",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "reviewedAt": "2026-11-11T00:00:00.000Z",
        "expiresAt": "2027-11-11T00:00:00.000Z"
      }
    }
  ]
}
```

The `delayMs` and `jobCaps` fields apply to fetch admission, not to blob store requests.

## Tests

`tests/` runs offline against an in-process fake S3 server on `127.0.0.1` that checks every
request's signature. They cover the Signature Version 4 test vectors, the blob store contract
from the core test kit, multipart uploads, and planted mutants: a wrong signing region, a
skipped hash check, a publish without the existence check, a single-page list, a missing
cache-level guard, a multipart upload completed with the wrong SHA-256, an upload that lost a
part, and a failed publish that leaves `.pending-` objects behind.

The vectors in `tests/fixtures/sigv4-vectors.json` are an unverified copy. Someone typed them in
rather than copying them from the published suite, which the fixture's comment names. The label
stays until someone checks the values against that suite.
