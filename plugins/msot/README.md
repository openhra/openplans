# Market Source of Truth

`@openplans/plugin-msot` resolves an operator's `custom_payment_allowed` flag beside public
plan facts. The flag describes the operator's workflow. It does not establish insurer payment
acceptance or binding authority.

The plugin is off by default: no installation config enables it. With neither
`options.source` nor `options.readableSources`, loading the package registers no route, tool or provider. Worker commands
remain available when the plugin is loaded. To try it on a separate installation, add
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
changing any instruction requires a new version. Inline sources do not read persisted versions.

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

## Versioned files

Enabled installations can publish local files with `worker msot`. JSON supplies the same schema
as an inline source. The importer requires `--actor` to match every JSON `set_by`; it records
`shell_asserted` authorship, not verified individual identity. CSV authorship comes from the
command. JSON preserves instruction timestamps; the audit records each operation's time separately.

Optional `--csv rules.csv` adds assignments to the JSON rules. Its exact columns are:

```csv
id,issuer_id,state,market_segment,field,value_state,value,valid_from,valid_until,reason_code
```

Only `true` and `false` are known boolean values. An empty value requires `value_state=unknown`.
Empty scope cells are unrestricted. IDs stay strings. JSON defines the field before CSV can
assign it. Files are bounded to 8 MiB each, rules to 10,000 and CSV records to 64 KiB. Original
UTF-8 file contents, SHA-256 hashes and JSON pointers or CSV line numbers stay in the database
for inspection and backups.

Run these commands on a separate installation with the plugin enabled. `input.json` is a resolve
request with up to 100 plan IDs, a year and an optional date. Preview reports apply to those
selected IDs; they are not a whole-catalog impact count.

```sh
worker msot validate --file source.json --actor operator-id
worker msot import --file source.json --actor operator-id --reason policy_update --idempotency-key import-1
worker msot preview --draft DRAFT_ID --input input.json --actor operator-id --reason review --idempotency-key preview-1
worker msot publish --preview PREVIEW_ID --expected-version none --expected-activation 0 --actor operator-id --reason approved --idempotency-key publish-1
worker msot activate --source agency-market --version 1 --expected-version none --expected-activation 0 --actor operator-id --reason approved --idempotency-key activate-1
worker msot inspect --source agency-market --version 1
worker msot export --source agency-market --version 1
```

Commands write JSON to stdout and fixed refusal codes to the worker log. Validation checks types,
dates and overlaps. Import stores a draft. Preview also checks issuer/state pairs against the
loaded public catalog for the requested year and product families. Preview pins its hash, catalog generation, UTC date and
activation sequence, compares public and effective values, and records counts by state, issuer,
channel and field. It writes a preview receipt and audit entry, with no activation or change event.
Publish rechecks the pins and stores the next consecutive version. Publish leaves activation to
`activate`. Successful publication and activation commit their audit and outbox event in the same
transaction. A failed outbox write refuses the operation. Rejections after a transaction starts
have separate audit entries when the database is available.

Use the current version number for `--expected-version` and the current activation sequence for
`--expected-activation`; `none` and `0` describe a source that has never been activated. Inspection
returns both. Stale expectations refuse without moving the pointer. New versions start at 1.
Use a fresh idempotency key per operation; a reused key refuses instead of replaying a command.

Rollback uses `activate --rollback true` with a retained version and current expectations. It
adds an activation and audit entry, preserving newer versions. `retire` takes the same flags as
`activate` and retires the active version, clearing the pointer. Retired versions remain inspectable
but cannot be activated again. Neither operation changes the public catalog.

## Protected inspection

`options.readableSources` lists persisted source IDs the plugin may read. On a separately
configured installation, it enables `GET /msot/versions`, `GET /msot/inspect` and `GET /msot/audit`
with `source_id` as a query parameter. Inspection accepts an optional `version`. These routes
require the existing operator bearer token and use the existing request and output limits.
`POST /msot/preview` accepts `{ "source": DOCUMENT, "input": RESOLVE_REQUEST }` under the same
protection. It performs a dry run without any writes. Local filesystem paths are worker-only.

The explicit `/msot/resolve` endpoint and `msot_resolve` tool can read the active version of a
configured readable source. Missing or retired active state refuses. Inline sources still work
without policy-table reads. Existing catalog endpoints and tools keep their current behavior.

Back up the plugin tables with the normal database backup. They use application-state provenance,
carry no automatic expiry, and are retained when the plugin is disabled. Restore public snapshots
as well to reproduce historical public facts. The worker export is a canonical source document;
it does not replace the full backup of artifacts, audit and activation history.

Catalog selection, other custom fields, display overrides, write APIs and authoring UI remain
outside this package's current workflow.
