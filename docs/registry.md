# Data package inputs

Install original public files with:

```sh
worker plugin install --data /absolute/path/to/package
worker plugin install --data @publisher/files@1.0.0 --registry file:///absolute/path/to/registry/
```

The result names an installed directory under `OPENPLANS_DATA_DIR/data-packages/`
and reports `activation: "not_requested"`. Installation verifies the descriptor,
chunk inventory and reassembled hashes. It writes an installation receipt beside
the directory. It does not open a database, approve a plugin or activate snapshots.
Local directories use the descriptor's 64 MiB chunks and 20 GiB payload cap.
Registry archives still have the client's 20 MiB compressed archive limit. Bulk
registry transfer and publishing data packages are not enabled by this workflow.

## Review the upstream evidence

Keep a local review file outside the package. Record the upstream acquisition
independently of the package publisher. Do not copy an upstream hash from the
package into a review without checking the acquisition evidence.

The review is a JSON object with these fields:

| Field            | Value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `schemaVersion`  | `1`                                                                                         |
| `manifestSha256` | Hash of the installed `openplans-package.json` bytes                                        |
| `source`         | ID of an enabled, approved feed source with staging permission                              |
| `sourceArgs`     | Exact source command arguments, as an array of strings                                      |
| `scope`          | `annual` for declared plan years, or `snapshot` for an explicitly reviewed nonannual source |
| `domain`         | `individual` or `medicare`                                                                  |
| `planYears`      | The descriptor's exact sorted years, empty only for snapshot scope                          |
| `reviewedAt`     | UTC review timestamp                                                                        |
| `files`          | One acquisition and redistribution review per original file                                 |

Each `files` entry has `url`, `upstreamSha256`, `retrievedAt`,
`admissionSha256`, `response` and `redistribution`. The first four values must
match the original file and its recorded admission evidence. The admission file
must contain a collection receipt with an allowed upstream host, terms hash and
robots observation. A relay host's approval does not admit the upstream host.

`response` preserves the acquisition's `status`, `finalUrl`, `redirectChain`,
`contentType`, `etag` and `lastModified`. Use null for missing optional headers.
`redistribution` has `status`, `termsUrl` and `evidenceSha256`. Activation requires
an explicit local `allowed` review and the matching permission evidence file.
Missing evidence stays `unknown` and blocks ingestion.

## Activate through a feed source

```sh
worker ingest package SOURCE_ID /absolute/installed/directory \
  --review /absolute/local-review.json -- SOURCE_ARGUMENTS
```

Use `puf` as `SOURCE_ID` for the shipped exchange PUF importer. It requires
exactly one original named `<kind>.csv` or `<kind>.zip` for each of
`plan-attributes`, `service-area`, `network`, `business-rules`, `rate` and
`benefits-and-cost-sharing`. Use `source: "cms-exchange-puf-package"` in its
local review and source arguments `--year YYYY --state ST`. Each package holds
one state import year. The ordinary PUF parser and reconciliation checks run
inside the feed transaction, including publication of the catalog pointer.
The PUF snapshots link to their parent feed snapshots through
`data_package_feed_parent` audit entries.

Other source IDs come from loaded feed sources with staging permission. The package
cannot select executable code, SQL or transforms. The source's own plan must name
exactly the packaged originals. A missing shard, changed URL or conflicting hash
refuses the run.

The core reassembles the files into an isolated content cache. The normal fetch
path rechecks current upstream admission, robots and terms before handing files
to the source's stage hook. Policy checks may need network access even though the
data bytes are local. Source discovery may also make its usual admitted requests.
The source's validation, readiness checks, provenance triggers and activation
transaction remain in control. Failed staging or validation quarantines the run
and preserves the prior active rows.

Annual packages use the shared serving policy before reassembly and again before
activation. The default window includes the prior and current calendar years,
plus the next year only after its separate annual admission. Installing a package
does not admit a year. Snapshot scope requires an explicit local review and an
empty year list.

Each planned snapshot gets a `data_package_input` audit entry in `quality_issue`
before staging, so quarantined runs retain their input evidence.
It records the package identity, descriptor hash, review hash, complete local
review and original file evidence. Snapshot URLs, file hashes and retrieval times
continue to identify the upstream acquisition. The fetch cache keeps the original
admission receipt beside the payload.

The offline tests use labelled synthetic files, including all six PUF file kinds.
NPPES is not an enabled package importer. It needs a source adapter and an
importer-specific validation proof before use.
