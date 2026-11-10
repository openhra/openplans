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

## Default limits and how to measure your cache

The reader defaults to a depth limit of 64, 8 MiB per record and 64 KiB per string token.
These are per-record guards, separate from whole-download limits, and a reviewed feed that
needs more can override them. The 20-million-record limit is unchanged. Depth counts
containers from the root. Record sizes exclude separators and surrounding whitespace;
string sizes include quotes and escapes. The scanner below reads cached payloads without
changing them and prints the observed maxima, so you can check the defaults against the
feeds you load. It never repairs or activates a snapshot.

Run it from the standalone `openplans/` directory, with an absolute external cache path:

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
