# Printable stipend range

`@openplans/plugin-handy` 0.1.4 calculates four illustrative household profiles from the loaded public plan catalog. It stays off until a deployment loads it. Public quoting must also be enabled.

For a public installation, opt into preset-only registration:

```json
{
  "version": 1,
  "plugins": [
    {
      "package": "@openplans/plugin-handy",
      "enabled": true,
      "options": { "publicOnly": true }
    }
  ]
}
```

This registers three routes and one MCP tool:

| Request                         | Result                                       |
| ------------------------------- | -------------------------------------------- |
| `POST /handy/allowance`         | Calculation summary and first evidence page  |
| `GET /handy/allowance/print`    | Printable HTML, Letter or A4                 |
| `GET /handy/allowance/manifest` | Source manifest JSON                         |
| MCP `get_allowance_range`       | Compact result with print and manifest links |

All inputs require ZIP, year and `preset: "family-40-40-10-8-v1"`. Supply county for a ZIP that spans counties. POST and MCP accept JSON. The GET routes accept those fields as query parameters, plus optional `paper=letter` or `paper=A4` and `data_generation`.

For example, on an installation with the matching geography and plan year loaded, open:

```text
/handy/allowance/print?zip=77002&county=48201&year=2026&preset=family-40-40-10-8-v1&paper=letter
```

For calculation JSON, POST:

```json
{
  "zip": "77002",
  "county": "48201",
  "year": 2026,
  "preset": "family-40-40-10-8-v1"
}
```

The profiles are employee only, employee plus spouse, employee plus spouse and one child, and employee plus spouse and two children. Adults are 40; children are 10 and 8. All are non-tobacco. These are product examples, not employee records. Amounts are gross monthly premiums for on-exchange individual medical plans, starting January 1. The sheet shows lowest Bronze, lowest Silver, median Gold and a separate expanded Bronze minimum. Adjusted second-lowest-cost Silver is context, distinct from the lowest Silver funding target.

The target is the largest of the four lowest Silver premiums. If a required profile is missing, duplicated or unpriced, the target is unknown. Missing rates and incomplete sources remain unknown. The result makes no tax, eligibility, affordability, benefits or provider-participation determination. Check `/v1/data-availability` for loaded geography and years. Unsupported scopes receive evidence gaps instead of estimated amounts.

The core household calculation returns the four distributions and their adjusted benchmarks in one worker job. It shares the gross Silver ratings and request reads, then applies EHB and pediatric dental adjustments before benchmark ranking. The calculation uses a read-only request database and cancellation signal. Mixed generations refuse the calculation. A printed sheet links to a generation-pinned manifest with profile counts, points, candidate evidence references and benchmark evidence. If the catalog changes before download, the manifest refuses with HTTP 409. Start a new sheet.

The current host returns two evidence records per page. Follow `evidence_pagination.next_href` until it is null to retrieve the complete manifest. Later pages require both `evidence_page` and the original `data_generation`. Evidence indices are absolute across those pages. Each point retains its selected plan's first evidence index and the total tied-evidence count; the candidate pages contain all tied plans. Benchmark `evidence_range` values identify their source records in the same index. Source coordinates replace raw publisher rows, and the snapshot list supplies their content hashes. Allowance JSON responses are limited to 64 KiB.

Use browser Print to PDF for Letter or A4. Each profile prints its ages, premiums and counts; source notes and unknown warnings stay visible. MCP returns a summary and the same generation-pinned links. Offer rows remain in the manifest. Oversized MCP summaries refuse rather than silently dropping amounts; the serialized success or error stays below 64 KiB.

Public REST routes use host admission limits of 30 requests per minute, two active per source and four active total per route. MCP uses its transport's shared source limits and four-call concurrency limit. Responses are not cached or stored.

`publicOnly: true` does not register `/handy/allowance/scenario`, even when operator credentials exist. Public inputs reject custom members, allowance amounts and extra fields. Omitting `publicOnly` preserves the private installation's operator route; use the explicit public setting for public deployments. Turning public quoting off removes all this plugin's routes and tools. Removing or disabling the plugin restores the unloaded state.

The [comparator calculation checks](../compare/README.md#host-limits-and-checks) also cover the shared household enumerator. Stipend release checks add the four-profile funding target, adjusted benchmark evidence and print/manifest agreement. Route admission and private-route denials remain separate checks for each plugin.
