# Market Source of Truth

`@openplans/plugin-msot` resolves an operator's `custom_payment_allowed` flag beside public
plan facts. The flag describes the operator's workflow. It does not establish insurer payment
acceptance or binding authority.

The plugin is off by default: no installation config enables it. Loading the package without
`options.source` registers no route, tool or provider. To try it on a separate installation, add
an enabled plugin entry with a reviewed inline source. Do not enable it on the shared public instance.

## Inline source

`options.source` contains `source_id`, a positive integer `version`, one `fields` definition and
up to 10,000 `rules`. Definitions use `name: "custom_payment_allowed"`, `entity: "plan"`,
`definition_version: 1`, `type: "boolean"`, `allowed_values: [true, false]` and
`default: { "state": "unknown", "value": null }`. Supply a description, `set_by`, `set_at`,
`filterable: false` and `visibility: { "audience": "answer", "rest": true, "compat": false,
"mcp": true }`. Only the resolve endpoint and tool expose the field in this slice.

Each rule supplies `id`, `field`, `scope`, `valid_from`, nullable `valid_until`, a tagged `value`,
`set_by`, `set_at` and `reason_code`. Scope accepts string `issuer_id`, uppercase two-letter
`state` and `market_segment` (`on_exchange` or `off_exchange`). Omitted dimensions and `"*"`
are unrestricted. Empty strings and null are invalid. Issuer IDs retain leading zeros. Use public
issuer identities, not display names. Product families default to medical and dental; the business
market is individual. Unsupported products and markets are refused.

More explicit dimensions take precedence. Equal-rank overlapping scopes and dates are rejected,
even when their values agree. Dates use `valid_from <= as_of < valid_until`. Validation refuses
inputs beyond its comparison budget. The parsed source is frozen and assigned a canonical SHA-256;
changing any instruction requires a new version. There are no tables, activation pointers or writes.

## Resolve

Send `POST /msot/resolve` or call the read-only MCP tool `msot_resolve` with:

```json
{
  "source_id": "agency-market",
  "plan_ids": ["00123TX0010001"],
  "year": 2026,
  "as_of": "2026-11-15"
}
```

The ID above is synthetic. Use published HIOS IDs, published variants or opaque state plan keys
from your own catalog. Requests accept at most 100 IDs and 64 KiB. `year` is required; `as_of`
defaults once to the current UTC date. An optional `market_segment` selects a channel.

Answers contain the source/version/hash, date, catalog generation, evaluator version, public facts
and actor/scope provenance. MCP puts this payload in its public evidence envelope under `data`;
operator provenance stays separate from public snapshot references. Each plan has `msot.by_market_segment`: dual-channel plans keep
separate results. Missing evidence stays unknown; a confirmed false public channel is inapplicable.
Channel evidence is labelled `base_plan`, including when resolving a variant. Responses are not
stored beyond the request. Existing catalog routes and tools keep their current answers.

Publication, persisted sources, catalog selection, other custom fields and display overrides are
outside this slice.
