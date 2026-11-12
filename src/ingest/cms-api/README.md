# CMS Marketplace API coverage fallback

Off by default. An operator turns it on with `OPENPLANS_CMS_FALLBACK=on` and a key in
`CMS_API_KEY`. Without both, nothing changes: answers stay `unknown`.

The source is the first-party package
[`@openplans/source-cms-marketplace-api`](../../../plugins/source-cms-marketplace-api/README.md),
run by the pass-through core. `fallback.ts` here builds the per-request scope for routes and
services.

Some issuers' drug and provider files cannot be collected, so OpenPlans answers `unknown` for
their plans. With `OPENPLANS_CMS_FALLBACK=on` and `CMS_API_KEY` set, the drug and provider
coverage endpoints ask the CMS Marketplace API (`drugs/covered`, `providers/covered`) about
those pairs and store the answer, so the same question is answered locally next time.

Set `OPENPLANS_CMS_FALLBACK_QUOTES=on` to include `/v1/quotes` and coverage fields in
`/compat/v1/plans/medical/search`. This separate switch defaults to off and requires
`OPENPLANS_CMS_FALLBACK=on` and `CMS_API_KEY`. Leaving it off preserves quote and
compatibility responses. Turning it on spends the shared daily budget faster.
All plans, providers and drugs in one request share the existing two-call cap.
Loaded file answers still win, and drugs still require an exact local RxNorm match.
Native quote cells keep their source in `cms_api.sourced_by` and add
`cms_api.freshness`, one of `fresh`, `stale` or `refetched`.
Compatibility source labels go in `x-openplans-gaps`, without new body keys.
See [compatibility coverage inputs](../../compat/v1/README.md#optional-quote-coverage).

When it calls:

- Only after the answer from loaded files, and only when that answer is `unknown` for
  `source_set_not_available`, `source_access_denied`, `source_set_not_validated` or
  `source_set_not_active`. Any other answer, including `not_listed`, is returned as it is.
- From the native coverage endpoints (`/plans/:id/drugs/:rxcui`, `/drug-coverage`,
  `/plans/:id/providers/:npi`, `/provider-participation`). Quotes and compatibility medical
  searches also use it when `OPENPLANS_CMS_FALLBACK_QUOTES=on`. MCP tools serve rows stored earlier
  but never call. No job, worker or import calls the API.
- At most 2 calls per inbound request, each for up to 10 plans and 10 codes. Every process on
  the database shares one allowance in `cms_api_budget`: 1 call per second and 500 per UTC day.
  A 401, 403 or 429 stops calls for an hour. Each operator can change the row with one `UPDATE`.
- One client may use at most a tenth of the daily allowance. The API rate limiter's client
  name, which depends on `OPENPLANS_TRUST_PROXY`, tells clients apart. Counts live in memory
  for the UTC day and are never stored. Past the share, that client still gets answers stored earlier.
- Three server errors, timeouts or unreadable bodies within five minutes stop calls for
  fifteen. Then one trial call goes out. If it works, calls resume. If not, the pause repeats.
- For plan years 2025 to 2027.
- Not for a plan whose active catalog came from a state-based exchange bundle. The API answers
  only for plans sold through HealthCare.gov, so that question is never sent.

When it cannot call, the answer stays `unknown` and the reason says why:
`cms_api_not_configured`, `cms_api_budget_exhausted`, `cms_api_request_cap`,
`cms_api_unavailable`, `cms_api_year_not_served` or `cms_api_state_not_served`. A client past
its share gets `cms_api_request_cap`; the log row says `cms_api_client_share`.

What it stores:

- `cms_api_drug_coverage` and `cms_api_provider_coverage`, one row per plan and code. The initial
  policies keep answers fresh for 7 days, or 1 day for `DataNotProvided`, with a 30-day stale
  window. Operators control these intervals in `record_policy`. Freshness uses `expired_at`;
  `expires_at` is a deprecated alias. An expired row can be served as `absorbed_stale` within
  its policy window when no refresh succeeds.
- Each row carries `sourced_by = 'cms-marketplace-api'`, `sourced_at` = the receipt's retrieval
  time and `sourced_slug` = the receipt's snapshot id. A foreign key to the receipt makes the
  database refuse a row whose labels disagree with it.
- `cms_api_attempt` logs each call or refusal with counts, status and latency. It never stores
  plan ids, drug codes or NPIs. The receipt URL keeps parameter names with redacted values.
  An attempt that got no response has no receipt, so its row says `sourced_by = 'openplans'`
  and `sourced_slug = 'cache:cms-api-attempt'`.
- `cms_api_conflict` records, without changing either side, how a stored API answer compares
  with the answer from issuer files once those files are loaded.

Backups leave these rows out. The `pg_dump` and `tar` commands in `docs/self-host.md` exclude
the tables listed in `export.ts` and the raw response bodies. A test fails if a table holding
API-sourced rows is missing from that list or from the guide.

With the fallback on, each `/v1/data-availability` entry gains
`cms_api: { configured, absorbed_rows, last_absorbed_at }` for that issuer, state and year.
It holds counts and a time, never plan ids, codes or the key.

Issuer and PUF tables are never written. Loaded files always win because the fallback runs only
on their `unknown` answers.

How it labels answers: a served answer gets a `cms_api` object with the source,
`sourced_by`, `sourced_at`, the snapshot id, `served_from` (`live`, `absorbed` or
`absorbed_stale`) and its limits. CMS publishes a coverage flag only. Tier, prior authorization,
step therapy, quantity limits and cost stay `null`. `DataNotProvided` stays `unknown` with
reason `cms_api_data_not_provided`. `NotCovered` stays `unknown` with reason
`cms_api_reports_not_covered` unless the NPI exists in local NPPES or the RxCUI resolves
to an unsuppressed concept in the active local RxNorm release. Only known identities
can receive `covered: false`; positive flags receive `covered: true`. The identity check
runs when serving stored answers too. The original CMS statement stays in `cms_api.coverage`.

The key reaches the API only through fetch admission (`accessMode: "api-key"`, see
`src/fetch/README.md`). Admission refuses the host when the key is unset. A response that
contains the key is discarded.

## Choose expiry before switching on

Run `worker migrate`, then `worker record-policy list`. Set the two coverage policies before
turning on the fallback, for example:

```sh
docker compose run --rm worker record-policy set cms_api_fallback --ttl '7 days' --stale '30 days'
docker compose run --rm worker record-policy set cms_api_fallback_no_data --ttl '1 day' --stale '30 days'
```

Use `worker record-policy expire cms_api_fallback` to make the next eligible question refresh
stored answers without deleting them. See [record expiry policies](../../../docs/record-policy.md)
for cutoff timestamps, batch behavior and checks after an interrupted command.
