# Private census affordability batches

`POST /v1/ichra/affordability/batch` calculates 1-25 employees using the existing
ICHRA affordability service. It is off by default and has no MCP tool. Keep it
disabled on public installations.

Enable it only on a private installation with one trusted operator. Set
`OPENPLANS_TPA=on`, `OPENPLANS_TPA_PRIVATE_INGRESS=on` and a configured
`OPENPLANS_API_TOKEN`. The equivalent version 1 config fields are `tpa.enabled`,
`tpa.privateIngress` and `tokens.api`. Every request requires the API bearer
credential, even when ordinary household calculations allow anonymous access.
The private-ingress switch is an operator attestation, not a network detector.
Missing access controls refuse the request. A disabled route returns 404.

Before enabling it, restrict ingress to the private network and deny the route
family at public ingress. Disable ingress body capture, query/header logging,
disk request buffering, tracing payloads and core/heap dumps. Configure host swap,
backups and diagnostics under your own data policy. Do not send census inputs to
the shared public installation. This feature does not change public hosting.

Submit JSON with consecutive, batch-local row ordinals starting at 1. Each
`input` is an unchanged request body for
[`POST /v1/ichra/affordability`](ichra.md). An optional `class_ref` accepts an opaque
code of 1-32 lowercase letters, digits, underscores or hyphens, starting with a
letter or digit. It cannot select plans or change the calculation. Do not use
personnel descriptions or identifiers as class codes.

This example uses a synthetic employee and employer contribution. It asserts no
premium or affordability outcome.

```json
{
  "rows": [
    {
      "row": 1,
      "class_ref": "class-a",
      "input": {
        "plan_start": "2026-01-01",
        "employee": { "date_of_birth": "1985-10-01" },
        "residence": { "zip": "77002", "county": "48201" },
        "hra": { "self_only_annual_cents": 300000 },
        "income": [{ "measure": "fpl" }]
      }
    }
  ]
}
```

Each output row has its ordinal, `class_basis: "operator"` and a processing
`status`. A valid row contains `result`, the exact individual-service result
object, including its evidence, cents, ratios, rule versions, citations and
unknown reasons. A calculated row can still contain an unresolved income
verdict. An invalid row contains only an error code and field path. Unknown
field names are suppressed because a caller can put personal data in a key.
Names, SSNs, contacts, employee IDs and all other extra fields are rejected.
Row errors leave sibling rows intact. Batch envelope errors reject the request.

The envelope reports `status: "complete"`, `selection_universe: "public"`,
`counts` for submitted/calculated/unknown/invalid rows, `provenance.generation`,
`provenance.input_basis: "operator"` and `retention: "request_memory_only"`.
Complete means processing finished. It does not mean every row has a verdict.
The public plan universe supplies every answer; operator offering restrictions
are rejected. Geography uses loaded public evidence and never calls a live
optional source.

Postgres uses one read-only repeatable-read session for the whole batch.
Providers without request transactions compare the public generation before and
after all reads, retry the entire batch once and refuse `GENERATION_CHANGED` if
it changes again. Fatal reads and the 15-second deadline return a batch error,
without a partial result. Results over 1 MiB are refused; split the batch.
Requests are capped at 64 KiB. The installation admits at most 30 employee rows
per minute, two active requests for its operator and four active requests per
process. A refused admission returns 429 with `Retry-After`.

All responses, including errors, use `Cache-Control: no-store`. The application
keeps no census table, body hash, file, queue entry, shared cache entry or trace
payload. Public lookup maps exist only during the request. No intentional
persistence does not promise immediate erasure from JavaScript memory or host
swap. Keep any explicitly downloaded response under your own records policy.
There is no stored batch ID, receipt lookup, CSV upload, browser UI or durable job
for this endpoint.

Run the focused offline checks with
`npx vitest run tests/api/ichra-batch.test.ts` after building. The optional cached
public-data check is `scripts/realdata.sh --census-only`. It needs a disposable
Postgres database URL supplied as `DATABASE_URL`; it refuses
a database whose name does not start with `openplans_tpa1_`. Source databases are
copied from the external data cache and never opened in place. No source download
is required.
