# CMS Marketplace API coverage source

`@openplans/source-cms-marketplace-api` is the pass-through source behind the CMS Marketplace
API coverage fallback. The core plugin registers it while `OPENPLANS_CMS_FALLBACK=on` and
leaves it out otherwise, so it needs no entry under `plugins`. What the fallback does, when it
calls and what it stores is in the [fallback guide](../../src/ingest/cms-api/README.md).

The package holds what is specific to this API:

- the call shape: `drugs/covered` and `providers/covered`, up to 10 plans and 10 codes per
  call, two calls per inbound request, plan years 2025 to 2027;
- the response check and mapping. `NotCovered` counts as a negative, so it is served only for
  an NPI in local NPPES or an RxCUI in the active local RxNorm release. `DataNotProvided`
  stays `unknown`;
- storage over the `cms_api_*` tables, the shared `cms_api_budget` row and the record
  policies `cms_api_fallback` and `cms_api_fallback_no_data`;
- the `cms_api` evidence block, the reason codes and the `/v1/data-availability` counts.

The pass-through core (`ctx.sources.passThrough`) does everything else: eligibility, batching,
admission, the call, the per-client share, the breaker and the read-only rule.

Listed under `plugins` instead, the package registers the same source without the host's
RxNorm check, so every drug `NotCovered` stays `unknown`.
