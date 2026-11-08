# Bounded streaming JSON

`readJsonArray(input, limits)` yields one record at a time from a root array, or a direct
root-object property selected with `arrayKey`. `readJsonValue(input, limits)` reads a bounded
small document using the same scanner. Inputs are async byte or text streams; UTF-8 and
UTF-16 surrogate pairs may cross chunk boundaries. The scanner is iterative and checks limits
before accumulating record fragments or calling `JSON.parse`.

| Option | Default | Meaning |
|---|---:|---|
| `maxDepth` | 64 | Container nesting, including the root array/object envelope |
| `maxElementBytes` | 8 MiB (8,388,608) | Raw UTF-8 bytes of one record/value, including internal whitespace |
| `maxStringBytes` | 64 KiB (65,536) | Raw UTF-8 bytes of one quoted string token, including keys, quotes and escapes |
| `maxElements` | 20,000,000 | Yielded array records; also bounds envelope key count |

Limits must be positive safe integers. Inputs exactly at a limit are accepted. A decoded string written as
`"\u0041"` occupies eight source bytes for these guards, even though its decoded value is one
character. A string limit is independent of the aggregate record limit. Envelope keys and
ancillary values also use these guards. `readJsonValue` accepts the first three limits; its
record bound applies to the entire document. Discovery explicitly uses depth 32 and 4 MiB
for index documents.

Depth failures throw `JsonStreamError` with `code: 'json_depth_exceeded'`; oversized strings
or records use `code: 'json_record_too_large'`. These replace the previous generic JSON
`too_deep`/`too_large` codes. Other codes (`truncated`, `invalid_json`, `too_many_elements`,
`array_not_found`) retain their meaning. The provider/formulary ingesters already catch this
error class and retain its code in shard reasons/quality issues; failures prevent complete
publication and take their existing partial/quarantine path. Exhaust the iterator before
publishing. The reader may yield complete records before a later failure. Failure or early cancellation closes
the input iterator. No JSON record content is included in error messages.

## Measured TX cache and default headroom

Read-only scan on 2026-11-07 of all cached TX provider/formulary child namespaces, including
legacy `qhp-76589-2026-*` and `qhp-child-*-<URL hash>` snapshots. Deduplicated by kind and
payload SHA-256, across issuer/year runs; no downloads or cache writes. All 463 payloads
were root arrays, so none were skipped.

| Child kind | Distinct payloads | Payload bytes scanned | Complete records observed | Max depth | Max record bytes | Max string token bytes |
|---|---:|---:|---:|---:|---:|---:|
| Provider | 413 | 79,157,796,612 | 9,732,017 | 5 | 2,744,224 | 241 |
| Formulary | 50 | 3,312,163,739 | 294,317 | 5 | 202,595 | 2,406 |

Depth counts containers from the root, matching the reader. Record sizes exclude separators
and surrounding whitespace; string sizes include quotes/escapes, matching the reader's byte
limits. This scan measures structure. Ingestion must still validate JSON syntax and records. Two provider payloads ended with incomplete tails; their complete preceding
records and observed depths/complete strings contribute to the table, while unfinished
records/strings do not contribute length maxima. No formulary tail was incomplete. The
scan never repairs or activates these snapshots.

The retained depth-64 and 8 MiB record defaults provide 12.8× and about 3.06× headroom over
the observed maxima. The new 64 KiB string default provides about 27.2× headroom over the
largest observed string. These are finite per-record guards independent of whole-download
limits; larger reviewed feeds can override them explicitly. The existing 20-million-record
limit is unchanged.

The table lists the largest-record payload fingerprints. The scanner prints source namespaces
and SHA-256s for all three maxima, without URLs or record contents:

| Kind | Payload SHA-256 |
|---|---|
| Provider | `bc3f294aa4e673c347c704871ac3137d317ae0c47262e77dbee48ca985b97323` |
| Formulary | `03050b57b334494f92f065ee5ef88bd1f7b8cbad5026a867359284cfb208b790` |

Reproduce from the standalone `openplans/` directory, using an absolute external cache path:

```sh
node tests/ingest/json/measure-cache.mjs "$OPENPLANS_DATA_DIR"
```

Omit the path to use `OPENPLANS_DATA_DIR` or the fetcher's shared-cache default. The script
uses bounded buffers, scans every matching immutable payload read-only and emits a JSON
summary plus progress on stderr. It is not part of offline CI; its two synthetic accuracy
controls are. Offline reader tests include a 10,000-level nesting attack (named depth error,
no recursive descent/stack overflow), independent record/string bounds, split Unicode,
truncated tails and early source closure. HTTP decompression limits belong to the
[fetcher](../../fetch/README.md).
