# Quoting guide

OpenPlans answers two kinds of quote request, and both are on by default. Both return gross monthly
premiums from imported CMS rate tables. Neither is a bindable quote, so every answer carries
`bindable_quote: false`. Enrollment, carrier acceptance and final eligibility
belong to the marketplace or the issuer.

| Tier            | Route                     | Access                                                                                     | Accepts                                                                                           |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Public quote    | `POST /v1/quotes`         | Anonymous. **On by default.**                                                              | Ages, ZIP and/or county, optional tobacco flag, plans, NPIs, RxCUIs                               |
| Household quote | `POST /v1/premium-quotes` | Anonymous. **On by default.** A set `OPENPLANS_API_TOKEN` requires `Authorization: Bearer` | Everything above plus dates of birth, income, household size and tax filing for subsidy estimates |

> **Public quoting is on for every install unless you turn it off.** A server
> started without `OPENPLANS_PUBLIC_QUOTING` answers anonymous `POST /v1/quotes`
> requests. Set `OPENPLANS_PUBLIC_QUOTING=off` to disable it; the route then
> returns 503 `QUOTING_DISABLED`. Any value other than `on`, `off` or empty
> stops the API at startup.

## Public quotes: `POST /v1/quotes`

Send `Content-Type: application/json`, at most 64 KiB. The body is a strict
allow-list: any other key is refused, including inside a member.

```json
{
  "year": 2026,
  "zip": "77002",
  "county": "48201",
  "members": [
    { "age": 40 },
    { "age": 38, "relationship": "spouse" },
    { "age": 10 }
  ],
  "plan_ids": ["87226TX0100013"],
  "npis": ["1234567893"],
  "rxcuis": ["860975"]
}
```

| Field                    | Rule                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `year`                   | Integer from 2014 to 2100. Required. Coverage starts on January 1 of that year.                                                                                          |
| `zip`, `county`          | Five-digit ZIP and/or county FIPS code. At least one is required. A ZIP in several counties needs `county`.                                                              |
| `members`                | 1 to 10 objects. `age` is an integer from 0 to 120.                                                                                                                      |
| `members[].relationship` | Optional: `subscriber`, `spouse`, `child` or `other`. The first member defaults to `subscriber`, later members under 21 to `child`, the rest to `other`.                 |
| `members[].tobacco`      | Optional boolean, default `false`. A `true` member is rated at the plan's tobacco rate. The flag is never logged.                                                        |
| `plan_ids`               | Optional, 1 to 10 HIOS base or variant IDs, or state plan keys, without duplicates. Without it, the location's catalog is quoted 10 plans per `page`, sorted by base ID. |
| `coverage`               | `medical` (default) or `dental`. Filters the catalog when `plan_ids` is absent.                                                                                          |
| `metal`                  | Optional catalog filter: `bronze`, `expanded bronze`, `silver`, `gold`, `platinum` or `catastrophic`.                                                                    |
| `csr_variant`            | Optional cost-sharing variant to display. It is never derived from income.                                                                                               |
| `page`                   | Positive integer, default 1. Only used when `plan_ids` is absent.                                                                                                        |
| `npis`                   | Optional, up to 5 distinct NPIs. Each plan reports provider participation for each NPI.                                                                                  |
| `rxcuis`                 | Optional, up to 5 distinct RxCUIs. Each plan reports drug coverage for each RxCUI.                                                                                       |

A request may check at most 100 plan and provider-or-drug pairs.

### Response

```json
{
  "schema_version": "1",
  "tier": "public_quote",
  "bindable_quote": false,
  "year": 2026,
  "coverage_start": "2026-01-01",
  "coverage": "medical",
  "location": { "status": "available", "zip": "77002", "county": "48201" },
  "members": [
    {
      "member_id": "0",
      "age": 35,
      "relationship": "subscriber",
      "tobacco": false
    }
  ],
  "tobacco_rating": "requested_flags",
  "subsidy": { "status": "not_evaluated", "reason": "PUBLIC_QUOTE_TIER" },
  "csr_eligibility_status": "not_evaluated",
  "data_availability": {
    "catalog": "available",
    "providers": "unknown",
    "drugs": "unknown"
  },
  "quotes": [
    {
      "plan_id": "87226TX0100013",
      "status": "rated",
      "total_cents": 52928,
      "rating_area_id": "Rating Area 10",
      "members": [
        { "member_id": "0", "age": 35, "charged": true, "premium_cents": 52928 }
      ],
      "rate_rows_used": [],
      "providers": [],
      "drugs": []
    }
  ],
  "page": 1,
  "page_size": 1,
  "total": 1,
  "next_page": null
}
```

Each `quotes[]` entry is the same object the household route returns for that
plan (status, member rows, rate rows, cost sharing, provenance), plus
`providers[]` and `drugs[]`. A provider item is the object returned by
`GET /v1/plans/:id/providers/:npi`, so the NPI is in its `identity` field. A
drug item is the object returned by `GET /v1/plans/:id/drugs/:rxcui`.

`data_availability` summarizes the imported coverage manifest for the quoted
issuers in that state and year: `available` when every issuer has the evidence,
`partial` when some do, `unknown` when none do. An unresolved or ambiguous
location returns `quotes: []` with `location.status`. Responses carry
`Cache-Control: no-store` and `X-Quote-Tier: public`.

### Unknown is not "not covered"

By default, provider and drug status comes from published issuer evidence. The
optional [CMS coverage fallback](../src/ingest/cms-api/README.md) can fill unknown
answers when both fallback switches and a key are set. When the
issuer's provider or formulary files are not loaded, the status is `unknown`
with a reason such as `source_set_not_available` or `rxcui_not_in_rxnorm`. It
never means the provider is out of network or the drug is not covered. Bootstrap
with `--with-providers` and `--with-drugs` to load that evidence.

### Errors

Errors are `{ "error": { "code": "...", "field": "..." } }`. The field names the
refused key; values are never echoed.

| HTTP | Code                                                                                                                                                         | When                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 400  | `INVALID_JSON`, `REQUEST_TOO_LARGE`                                                                                                                          | Body is not JSON or exceeds 64 KiB                                                |
| 400  | `UNKNOWN_FIELD`                                                                                                                                              | Any key outside the allow-list, such as `name`, `email` or `members.0.first_name` |
| 400  | `INCOME_NOT_ACCEPTED`                                                                                                                                        | `household_income_annual`, `household_size` or `tax_filing`                       |
| 400  | `DOB_NOT_ACCEPTED`                                                                                                                                           | A member `dob`                                                                    |
| 400  | `TOO_MANY_MEMBERS`, `TOO_MANY_PLANS`, `TOO_MANY_PROVIDERS`, `TOO_MANY_DRUGS`, `TOO_MANY_PAIRS`                                                               | A cap above                                                                       |
| 400  | `INVALID_INPUT`, `YEAR_REQUIRED`, `LOCATION_REQUIRED`, `DUPLICATE_PLAN_ID`, `DUPLICATE_NPI`, `DUPLICATE_RXCUI`, `CONFLICTING_VARIANT`, `ZIP_COUNTY_MISMATCH` | Malformed or conflicting values                                                   |
| 404  | `PLAN_NOT_FOUND`                                                                                                                                             | A requested plan or variant is not in the active catalog                          |
| 429  | `RATE_LIMITED`                                                                                                                                               | Limit reached; `Retry-After` gives seconds                                        |
| 503  | `QUOTING_DISABLED`                                                                                                                                           | `OPENPLANS_PUBLIC_QUOTING=off`                                                    |
| 504  | `REQUEST_DEADLINE`                                                                                                                                           | The quote took longer than 15 seconds                                             |

### Limits and privacy

Each source address may send 30 quote requests per minute, with at most 2 in
flight; the process runs at most 4 at once. Behind a reverse proxy, list the
proxy's address in `OPENPLANS_TRUST_PROXY` so the last `X-Forwarded-For` hop is
used. Cached answers count against the same limits. Successful answers may be
kept for 30 seconds in the process's response cache, keyed by a hash of the body
and the data generation; no address, header or token is part of the key.

The API writes no access log and never logs request bodies, ages, ZIP codes,
tobacco flags or client addresses. A reverse proxy in front of it should log
method, status, size and timing, and nothing else.

### Example

```sh
curl -s http://127.0.0.1:3000/v1/quotes \
  -H 'content-type: application/json' \
  -d '{"year":2026,"zip":"77002","county":"48201","members":[{"age":35}],"plan_ids":["87226TX0100013"]}'
```

With the cached Texas 2026 catalog loaded, `quotes[0].total_cents` is 52928.
Adding `"household_income_annual": 40000` returns 400 `INCOME_NOT_ACCEPTED`.

## MCP tools

The MCP endpoint offers the same two tiers.

- `quote_plans` is public. It takes `year`, `location` (`zip` and/or `county`),
  `members` (age, optional relationship and tobacco), optional `plan_refs`,
  `coverage`, `metal`, `csr_variant`, `npis` and `rxcuis`, with the caps above.
  Household, income and date-of-birth keys fail with `INVALID_INPUT`. Each quote
  carries the estimate fields plus `providers` and `drugs` in the same form as
  `check_provider_network` and `check_drug_coverage`. A catalog quote pages with
  `next_cursor`. With `OPENPLANS_PUBLIC_QUOTING=off` the tool is not listed and a
  call returns `QUOTING_DISABLED`.
- `quote_premiums` is the household quote and answers under `quotes`. It is open
  by default. A set `OPENPLANS_MCP_TOKEN` restricts it to Bearer callers over HTTP,
  `OPENPLANS_MCP_ALLOW_PERSONALIZED=0` withholds it over stdio, and
  `OPENPLANS_PUBLIC_HOUSEHOLD=off` withholds anonymous HTTP access. An authorized
  HTTP bearer caller can still use it. Over stdio, `OPENPLANS_MCP_ALLOW_PERSONALIZED=1`
  grants access explicitly; `0` withholds it. When unset, stdio follows the public
  household switch and withholds household tools if an MCP token is configured.

`get_data_status` reports `public_quoting: "enabled"` or `"disabled"`. No quoting
tool result is cached.

```json
{
  "name": "quote_plans",
  "arguments": {
    "year": 2026,
    "location": { "zip": "77002" },
    "members": [{ "age": 35 }],
    "plan_refs": ["87226TX0100013"]
  }
}
```

## Household quotes: `POST /v1/premium-quotes`

This route takes the full household request described in the
[native API guide](../src/api/README.md): age or date of birth, an explicit
tobacco flag and relationship per member, a coverage start date, and optional
income, household size and tax filing for subsidy estimates. It answers
`{ "quotes": [...] }`. Anyone may call it. Each source may send 30 household
requests per minute, 2 at a time, shared with `/v1/benchmark` and
`/v1/ichra/affordability`. Responses are never cached, and income, ages and ZIP codes
never reach a log. If you set `OPENPLANS_API_TOKEN`, a missing or wrong bearer token
returns 401 `UNAUTHORIZED`. With no token, `OPENPLANS_PUBLIC_HOUSEHOLD=off` returns 503
`AUTH_NOT_CONFIGURED`. Subsidy figures are checked against source for Texas 2026 so far.

```sh
curl -s http://127.0.0.1:3000/v1/premium-quotes \
  -H 'content-type: application/json' \
  -d '{"plan_ids":["87226TX0100013"],"zip":"77002","coverage_start":"2026-01-01","members":[{"age":35,"tobacco":false,"relationship":"subscriber"}]}'
```

## Removed names

Earlier 0.1 releases answered household quotes at `POST /v1/premium-estimates` and through
the MCP tool `estimate_premiums`. Both are gone. The route now returns the same 404
as any unknown route, and the tool is no longer listed; calling it returns the MCP
unknown-tool error. Use `POST /v1/premium-quotes` and `quote_premiums`, and read
the results from the `quotes` key instead of `estimates`.
