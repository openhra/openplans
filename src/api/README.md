# Native v1 API

The native API serves a read-only catalog, gross monthly premium quotes and conditional
subsidy estimates from ACTIVE imported CMS and Census snapshots. Quotes do not establish eligibility
or guarantee enrollment. The [quoting guide](../../docs/quoting.md) describes both quote tiers.

```text
GET  /v1/zip-counties?zip=77002
GET  /v1/plans?zip=77002&year=2026&market=individual&metal=silver&page=1
GET  /v1/plans?county=48201&year=2026
GET  /v1/plans/87226TX0100013?year=2026
POST /v1/quotes                (public, on unless OPENPLANS_PUBLIC_QUOTING=off)
POST /v1/premium-quotes        (household, on unless OPENPLANS_PUBLIC_HOUSEHOLD=off)
GET  /v1/benchmark?zip=77002&year=2026&ages=40
POST /v1/ichra/affordability  (household)
GET  /v1/carriers?state=TX[&year=2026]
GET  /v1/networks?state=TX[&year=2026]
GET  /v1/drugs?q=metformin[&limit=50]
GET  /v1/drugs?ndc=00071-0155-23
GET  /v1/drugs/860975
GET  /v1/plans/76589TX0010015/drugs/860975?year=2026
POST /v1/drug-coverage
GET  /v1/data-availability[?state=TX&year=2026]
GET  /v1/medicare/plans?county_fips=48201&year=2026[&type=ma|ma_pd|pdp|snp|cost&snp_type=&page=]
GET  /v1/medicare/plans/H0028-042-0?year=2026
GET  /v1/medicare/plans/H0028-042-0/benefits?year=2026[&table=pbp_section_d]
GET  /v1/medicare/plans/H0028-042-0/service-area?year=2026
GET  /v1/medicare/plans/H0028-042-0/lineage?year=2026
GET  /v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=860975     (off by default)
GET  /v1/medicare/plans/H0028-042-0/pharmacies?year=2026&zip=77002   (off by default)
GET  /v1/medicare/data-availability
```

Medicare routes are described in the [Medicare guide](../../docs/medicare.md).

Plan search and detail require an explicit year. Premium coverage_start supplies
the year. Carriers/networks can list all imported years, with plan_year on each row.
Search is individual medical only, sorted by base ID, 50 plans per page. Plans
retain base and variant IDs, issuer/network records, exchange flags and the
source snapshot IDs. Detail retains each benefit's published variant ID and raw
and parsed cost-sharing text. A base-ID request selects the standard on-exchange variant (`-01`) for cost sharing.
It never substitutes another variant when that evidence is missing.

ZIPs use Census ZCTAs, not postal delivery boundaries. Unknown/PO-box ZIPs return
unknown, no guessed county. A ZIP spanning counties requires an explicit county;
until then search/premiums return ambiguous. A supplied county must occur in the
ZIP's imported relationship rows. County-only searches exclude ZIP-restricted
plans because availability cannot be established without a ZIP. Searches with no
active state/year catalog return unknown.

## Rating rules and authentication

Run `worker ingest rating-rules` after migration. The default committed source is
data/rating-rules/2026.json; `--file path` selects another document. Importing a
replacement selects the whole year's rule set atomically, including empty sets.
Only TX/2026/individual is currently supported. NY/VT per-member rules are rejected.
The API looks up the cited method for each plan's state, year and market, independently
of PUF catalog snapshots. Unsupported methods never return total_cents.

Household requests (`/v1/premium-quotes`, `/v1/benchmark` and
`/v1/ichra/affordability`) are open by default. They share one per-source bucket of
30 requests per minute with 2 in flight, and the response cache skips them. With
OPENPLANS_API_TOKEN set they require `Authorization: Bearer <configured token>`, and
missing/incorrect credentials return 401. With no token, OPENPLANS_PUBLIC_HOUSEHOLD=off
returns 503. The API adds Cache-Control: no-store and does not install access/body logging.
Configure any reverse proxy to exclude household requests and authorization headers
from logs (spec section 14).

Public quotes (`POST /v1/quotes`) need no token. They accept ages and a ZIP or
county, an optional tobacco flag, up to 10 plans, 5 NPIs and 5 RxCUIs, and refuse
income, dates of birth and any unlisted key. **They are on by default**; set
OPENPLANS_PUBLIC_QUOTING=off to return 503 `QUOTING_DISABLED`. Each source may send
30 per minute with 2 in flight (OPENPLANS_TRUST_PROXY names proxies whose last
X-Forwarded-For hop is used). The [quoting guide](../../docs/quoting.md) has the
contract and error codes.

```json
{
  "plan_ids": ["87226TX0100013"],
  "zip": "77002",
  "coverage_start": "2026-01-01",
  "members": [{ "age": 35, "tobacco": false, "relationship": "subscriber" }]
}
```

Supply age OR dob (YYYY-MM-DD), explicit boolean tobacco, and relationship
(subscriber/spouse/child/other) per covered member. Age means completed years at
coverage_start. Coverage date selects the applicable filed interval. Response:
quotes[] with status, total_cents only when rated, member rows, rate_rows_used,
and rule/rate/geography provenance. Typed failures: missing, ambiguous, unknown,
unsupported_rating_method. Invalid input returns 400 with error.code/error.field;
unknown base/variant IDs return 404. Requests are bounded at 50 plan IDs, 100
members and 64 KiB. Only the three oldest covered children under 21 are charged.

Data availability starts with the imported manifest. Unverified capabilities are
unknown; medical premium status is available only with active rate evidence and a
supported state rule. It includes rate snapshot/count and rating-rule snapshot.
No entries are fabricated for unimported states/years. Dental remains unsupported.

## Subsidies and benchmark

Add `household_income_annual` (annual MAGI dollars, nonnegative, at most two decimal
places), `household_size` (tax family size, 1–100), and `tax_filing` to a premium
request. Income and size are required together. Filing values are `single`,
`married_filing_jointly`, `head_of_household`, `qualifying_surviving_spouse`,
`married_filing_separately`, `not_filing`. Omitted filing, separate filing and
non-filing require review and leave credit/net null; exceptions need an eligibility
adapter. Covered `members` may be fewer than the tax family size. A coverage family
larger than the tax family also requires review.

Gross-only requests retain their existing shape. With subsidy inputs, each plan adds:

- `slcsp_monthly_cents`: household benchmark, rated without tobacco.
- `estimated_monthly_tax_credit_cents`: credit applied to this plan, capped at its enrollment EHB premium (never above gross).
- `estimated_net_monthly_cents`: gross minus the applied credit.
- `subsidy_status`, plus `subsidy.status`, `reason`, contribution/FPL trace and benchmark evidence.
- `quote_method: "puf_calculation"`, `bindable_quote: false`.
- `csr_eligibility_status: "not_evaluated"` (variant selection is an explicit caller input).

The existing gross `status` and `total_cents` retain their meanings. The nested
`subsidy.estimated_monthly_tax_credit_cents` is the household credit before the
per-plan cap. Unresolved credit/net stay null, never zero. The domain's
`above_income_cliff` is mapped to API `over_income_limit`; a confirmed above-limit
household with a calculated benchmark receives zero credit. Other states include
`parameters_unconfirmed`, `requires_state_rules`, `requires_tax_filing_review`,
`incomplete_benchmark`, `unsupported_rating_method`, `requires_premium_adjustments`, and
`requires_benchmark_adjustments`. If a request gives a county but no ZIP, and a
silver plan there serves only some of the county's ZIP codes, the status is
`location_requires_zip` with reason `zip_limited_service_area`. The benchmark, credit
and net stay null until the request includes a ZIP. Gross premiums do not change. A requested plan that cannot be rated has no
applied credit/net. Off-exchange and catastrophic plans receive no estimated
credit (`plan_ineligible_for_tax_credit`). CSR variant eligibility is not inferred.

`GET /v1/benchmark?zip=77002&year=2026&ages=40` also accepts `county=48201`
instead of ZIP, or county plus ZIP to disambiguate. It follows the same
access rule as premiums and returns `Cache-Control: no-store`. Do not log its
query string. Ages are comma-separated completed ages (0–120, up to 100 members),
with the first member as subscriber and subsequent under-21 members as children.
This convenience route rates January 1; use premium-quotes for an explicit date,
DOB and relationship. All members are requesting one policy at the supplied location.
The response lists `lowest_silver_plans` (up to two distinct base plans) with gross,
EHB monthly cents, `pediatric_dental_adjustment_cents`, `benchmark_monthly_cents`
(EHB plus dental), the published EHB fraction, and source provenance. If there is only one eligible
silver plan, its premium is the benchmark, following P5a. Tied distinct offers count separately.

Benchmark selection scans the complete loaded on-exchange silver offer set for
the county/ZIP, independently of requested plan IDs. A missing, ambiguous or
unsupported rate for any silver offer blocks the benchmark rather than dropping
the offer. No NY/VT fallback to TX or federal per-member math occurs. The API uses
the filed `EHBPercentTotalPremium` to allocate each household total (exact
fraction, half-up monthly cents) before calling P5a's SLCSP selector. Unknown or
conflicting EHB evidence blocks the result. The allocation uses the CMS
[Plan Attributes dictionary, page 11](https://www.cms.gov/files/document/planattributes-datadictionary-py27.pdf),
consistent with [26 CFR 1.36B-3(j)](https://www.ecfr.gov/current/title-26/section-1.36B-3).
The same allocation excludes non-EHB benefits from the enrollment cap: a $100 gross
premium with 90% EHB can absorb at most $90 credit. The remaining $10 stays in net.
Missing enrollment allocation gives `requires_premium_adjustments` with null applied
credit/net and the unchanged gross quote. `subsidy.enrollment_ehb_monthly_cents` shows the cap.

When a coverage-family member is under 19, the adapter checks the medical Benefits PUF
`IsEHB`/`IsCovered` pediatric dental rows. Silver options without those benefits each
receive the second-lowest applicable stand-alone dental **pediatric EHB** premium before
silver ranking, under §1.36B-3(f)(3), (9) Example 3. Dental child rates come from the
Rate PUF; allocations come from `EHBPediatricDentalApportionmentQuantity` in Plan Attributes.
`pediatric_dental` in the benchmark reports the allocation, selected plan IDs and source
rows. Unknown or conflicting coverage/allocation/rate evidence retains
`requires_benchmark_adjustments`, naming the missing field. No pediatric amount is
added for ages 19 and 20. The single-location/policy path assumes other coverage-family
eligibility, MEC and immigration questions have been resolved separately; it remains
conditional arithmetic.

The contribution trace identifies
`rounding_policy: "form_8962_lines_8a_8b_whole_dollars"`. The
[IRS Form 8962 instructions, lines 8a–8b](https://www.irs.gov/instructions/i8962) round
annual income × applicable percentage to whole dollars, then divide that rounded
annual contribution by 12 and round monthly to whole dollars. At $31,300 and 6.60%,
that is $2,065.80 → $2,066 → $172. A real-catalog benchmark of $591.76 therefore
gives $419.76 before the plan cap. The $419.61 hand calculation skips the declared
contribution rounding. This Form-based estimate does not assert agreement with
Marketplace advance-payment precision or reproduce an entire tax return. The
[full source-row trace](../../data/subsidy/README.md#p5c-audit-zip-77002-py2026-single-age-40-annual-income-31300)
records the FPL year, percentage endpoint, EHB allocation and rounding audit.

Offline worked example: the committed Harris fixture's two lowest adult silver
EHB premiums at age 40 are $591.76 (`87226TX0140004`: $614.43 × .9631) and $592.05
(`87226TX0100011`: $592.05 × 1). Annual income $31,300 / $15,650 = 200% FPL;
6.60% gives $2,065.80 → $2,066 annual → $172 monthly contribution. Credit is
$592.05 − $172 = $420.05. Gold `87226TX0100013` has $553.54 gross and $133.49 net.
These are synthetic household inputs over real, regenerable CMS fixture cuts,
not a live CMS eligibility comparison. A full imported catalog may have a lower
benchmark than this intentionally small fixture.

Run the opt-in real HTTP check against a private prepared PGlite database in the
external data cache (no downloads):

```sh
npm run build
OPENPLANS_PGLITE_DIR=/absolute/private/prepared/pglite node tests/api/subsidy-realdata.mjs
```

It binds only to 127.0.0.1, uses an unlogged in-memory token, checks the benchmark
and three income-bearing plan estimates for both a single adult and a two-adult/one-child
family in 77002, closes its listener/database, and writes `reports/p5c-subsidy-http.json` under `OPENPLANS_DATA_DIR` (or the database's parent).

## ICHRA affordability

`POST /v1/ichra/affordability` estimates whether an individual coverage HRA is affordable for one
employee under 26 CFR 1.36B-2(c)(5) and, for employer measures, the safe harbors of 26 CFR
54.4980H-5(e)(2) as applied by proposed 54.4980H-5(f). It takes the lowest cost silver plan
from the same silver ranking as the benchmark, picking the first plan instead of the second. The
gross premium is the default, and the EHB-portion figure is returned next to it. Missing evidence
returns a status and no verdict.
The [ICHRA guide](../../docs/ichra.md) gives the request, response, statuses and sources.

## Local PGlite verification

Requires dev dependencies. Use a private copy of the P1d database in the shared
data cache, never a database inside the repository. Set OPENPLANS_PGLITE_DIR to
that absolute path, then:

```sh
npm run build
npm run api:pglite -- ingest rating-rules
npm run api:pglite -- ingest geo --state TX
npm run api:pglite
```

The runner uses PORT (default 3001), binds only 127.0.0.1, and omits PostGIS from a
temporary migration copy. Geo acquisition reuses cached snapshots. Production
continues to use the Postgres server and full migrations.

Deployment integration outside this lane's lease: the Docker image must include
data/rating-rules (or mount a document and use --file), and the API service must
receive OPENPLANS_API_TOKEN. The existing Dockerfile/compose do not yet do so.

## Drugs

Name search returns `candidates` (RxCUI, name, TTY and terminology provenance) with
`exact_concept_required: true`. Select an exact concept before coverage lookup;
search ranking is never coverage evidence. Detail returns all concept atoms,
ingredients, published brand/generic relationship links, NDCs and the release
snapshot. Suppressed concepts are labelled; coverage requires a nonsuppressed atom.

NDC lookup returns every associated RxCUI. Bare NDCs must be exactly 11 digits;
hyphenated 5-4-2, 4-4-2, 5-3-2 and 5-4-1 forms normalize to 5-4-2. A bare 10-digit
code is ambiguous and rejected. Leading zeros are retained, never guessed after loss.

Batch body: `{"plan_ids":["76589TX0010015"],"rxcuis":["860975"],"year":2026}`.
It returns `results` in plan-major order, one per pair. Limits: 50 unique plan IDs,
100 unique RxCUIs, 1,000 pairs, 64 KiB. Year must be explicit and IDs must be strings.
Drug lookups contain no household data and use the public catalog routes' access
policy. Personalized premium requests retain the authentication requirements above.

Coverage returns the five evidence states, original tier label, `tier_status`
(`resolved`, `unresolved`, or null without an unambiguous edge), nullable PA/ST/QL,
and source/raw/shard/source-set provenance in `evidence`. `cost_sharing` and
`patient_price` are null; tier labels do not supply patient prices. An unresolved
tier permits positive evidence and a warning, without invented synonyms. Only a
complete current manifest can turn absence into `not_listed`. A newer incomplete
discovery blocks that inference; access-denied sources return `unknown` even if an
older positive snapshot remains stored.

Data availability adds `drug_status` and `drug_coverage` per issuer/state/year, from
the validated formulary manifest and latest QHP discovery (including P2e statuses).
The vocabulary is `complete`, `partial`, `failed`, `access_denied`, `unknown`.
Downloaded but unvalidated sources remain `unknown`. The legacy `formulary_status`
field stays available/unknown for compatibility; `drug_status` is the detailed state.

## Provider searches and participation

`GET /v1/providers?plan_id=76589TX0010015&year=2026&zip=77030&radius_miles=5&taxonomy=207Q00000X`
returns issuer **records**, ordered by their nearest returned address. A plan requires an explicit
year (2014–2100); variants are validated and normalized to base-plan membership. A ZIP supplies
a published ZCTA internal-point origin; `lat` and `lon` can supply an origin instead. Radius is
optional, in statute miles, bounded to 500. Radius results exclude addresses without a point;
`meta.unlocated` counts point-less addresses among all filtered candidates before the radius cut.
Missing ZIP-centroid evidence returns `unknown`. Pages contain up to 50 records; total and
next_page refer to records, so one NPI may appear in several issuer records.

Search resolves the requested plan and current source shards to indexed record keys before
building response evidence. Participation and all ordinary/radius filters run before paging;
the API builds evidence, full address objects and identity enrichment only for the returned page.
`total` is an exact record count, including on empty or out-of-range pages; no estimate is used.
Migrations 580–582 add a shard-scoped GIN index over literal name trigrams using PostgreSQL's
built-in array operators (no extension), positive membership keys and covering identity keys.
This index selects candidates. The original case-insensitive substring
predicate still decides matches, including those across issuer and NPPES name fields. Terms
shorter than four characters and wildcard patterns retain the ordinary record-key path. Grouped evidence still
honors per-record overrides and suppressed ordinals, preserving duplicate publisher associations.

With PostGIS and a radius, identity search starts with a materialized `ST_DWithin` scan
of `address_point.point`, restricted to NPPES points by migration 640's partial GiST
index. Current practice addresses must match both the complete source key and source
snapshot through the indexed address expression. Identity filters then select record
keys, followed by exact grouping/counting and pagination; full identities are fetched
for the page. Issuer radius search intersects spatial hits with current participating
record keys before indexed address validation. Record IDs may contain colons; the
last source-key component is the address ordinal, and the API rechecks the full key.

`total` and `meta.unlocated` remain exact, including empty and out-of-range pages.
The unlocated count is an independent anti join over **all** identity/plan-filtered
candidate practice/issuer addresses, before the radius cut; it is not restricted to
spatial hits, and address-less identities do not add an unlocated address. There is
no cached count or estimate. A point from an older address snapshot does not locate a
current address. Without PostGIS the existing spherical-distance filter still runs
before pagination. Ten-mile statewide TX checks for Dallas, Austin and El Paso, and
the Harris County provider check, were measured on the retained external PostgreSQL volume;
these are quiet-database measurements, not a concurrent-load guarantee.

Filters: exact NPPES `taxonomy`, or issuer `specialty` text (either source spelling); `name` text;
and `type=INDIVIDUAL|FACILITY|GROUP`. With no plan, this route searches NPPES identity/taxonomy
only, returning `participation: not_evaluated`; specialty then searches the published taxonomy
code because NPPES imports contain codes, not taxonomy descriptions. NPPES organization type
is returned as GROUP; NPPES alone does not distinguish a facility from another organization.

Plan search addresses come only from the matching issuer record, labelled
`source=qhp_provider_address`. Their association scope is `provider_record`, and the address's
own `participation` is `not_evaluated`: record membership is never a claim about a particular
location. NPPES addresses cannot inherit participation. Points retain method, match status,
quality, source/geocode snapshots, centroid snapshot and distance; `precision` is `exact`,
`non_exact`, `approximate` (ZCTA), or null. Census Exact means the publisher's match class,
not surveyed rooftop accuracy. Provider rows include source date, retrieval date, raw snapshot,
source-set snapshot and source URL. Undeclared tier labels remain verbatim, with
`tier_status=unresolved` and a warning; their published plan association is positive evidence.

`GET /v1/providers/{npi}[?year=2026]` separates NPPES identity and locations from issuer records
and their plan associations. Optional year filters issuer evidence; identity has its own date.
`GET /v1/plans/{id}/providers/{npi}?year=2026` evaluates the five participation states.
`POST /v1/provider-participation` accepts `{ "plan_ids": ["76589TX0010015"], "npis": ["1000000000"], "year": 2026 }`
(the NPI here is a **synthetic example**), with up to 50 plans, 100 NPIs and 1,000 pairs, no duplicates.
No source creates `not_listed` until its complete current source set is ACTIVE. A denied source
returns unknown; a failed refresh preserves previously validated positive evidence and flags
`SOURCE_INCOMPLETE`. `/v1/data-availability` adds `provider_coverage` per issuer/year with
completeness, reason, discovery, active/latest snapshots and expected/completed shard counts.

Offline tests include distance-unit, address-scope and filter-after-page mutants, plus grouped
evidence, overrides, suppression, conflicting participation and exact pagination checks.
The identity-radius suite places 55 far identities ahead of 60 near identities and
executes a page-before-radius SQL mutant; it must lose the near page and fail. It
also checks multiple addresses, stale snapshots, mailing-only/out-of-scope identities,
filtered unlocated counts and empty pages.
To exercise the same HTTP suite
against an **empty disposable PostGIS database**, set `P3D_POSTGIS_URL` and run
`npx vitest run tests/api/providers.test.ts`. The suite asserts that geography is present.
For `tests/api/providers-radius.test.ts`, use `P3I_POSTGIS_URL` pointing to a second
empty disposable database; it also asserts that the indexed PostGIS path is active.
The external-cache real runner is `node dist/api/provider-realdata.js prepare`, then `geocode`,
then `check`; prepare requires completed P3b/P3c caches and creates its own `provider-pglite-p3d`
copy. Check starts a temporary localhost HTTP listener, records a family-medicine provider query
and nearest five in `OPENPLANS_DATA_DIR/reports/p3d-provider-http.json`, then closes the listener.

## Explicit cost-sharing variants

`GET /v1/plans`, `GET /v1/plans/:id`, `POST /v1/quotes` and `POST /v1/premium-quotes`
accept optional `csr_variant`. Use a literal CMS suffix (`"00"` through `"06"`)
or an alias: `off_exchange` → `00`, `standard` → `01`, `zero` → `02`,
`limited` → `03`, `csr73` → `04`, `csr87` → `05`, `csr94` → `06`.
For example, `GET /v1/plans/11718TX0140019?year=2026&csr_variant=csr94`
or add `"csr_variant": "06"` to a premium request. A suffixed HIOS request
already selects that exact variant. A conflicting `csr_variant` returns 400
`CONFLICTING_VARIANT`. The literal `03` means limited cost sharing, not CSR 94.

Without an explicit selection, `cost_sharing.selected_variant_id` is the base ID
plus `-01`, labelled `standard_on_exchange_default`. `variant_ids` and `variants`
list the variants actually published in the ACTIVE Plan Attributes snapshot.
Each variant retains its published classification, deductible and MOOP fields,
raw coinsurance and source row. Detail also includes every variant's Benefits and
Cost Sharing PUF rows. Top-level `benefits` and `cost_sharing.benefits` contain only
the selected variant. Search and premium quotes include selected benefit rows,
while their variant lists include accumulator summaries.

Deductible/MOOP entries are keyed by the original Plan Attributes column and contain
`raw`, `cents`, and `status`. Exact dollar amounts (including explicitly labelled
per-person/per-group accumulators) are parsed; conditional or non-dollar text keeps
its raw value, null cents and `unknown`. Medical/drug integration flags remain
explicit; blank component accumulators are never filled from another variant.
A missing selected variant yields `cost_sharing.status: "unknown"`, empty
accumulators/benefits and `benefits_status: "unknown"`; a recorded variant without
benefit rows retains its own accumulators and unknown benefits. A nonexistent full
HIOS path still returns 404; selecting a missing suffix through `csr_variant`
returns the existing base plan with unknown variant evidence.

`premium_basis: "base_plan_rate_puf"`, `premium_varies_by_csr: false`, and
`premium_note` explicitly state that Rate PUF rows are filed at base-plan level:
selecting a variant changes cost sharing and leaves the gross premium unchanged.
A gross quote can be rated even when the requested variant's cost sharing is
unknown. State-filed catalogs without PUF variants return unknown variant evidence
and null `premium_varies_by_csr`.

Choose the variant before making the request. Income, subsidy results,
tribal status, network and formulary evidence never select a CSR variant.
`csr_eligibility_status` remains `not_evaluated`. The standard default is a display
choice, not a finding that a household has no CSR eligibility.

The compatibility facade accepts the same explicit input on medical search and
detail, maps only existing benefit/deductible/MOOP fields, and records unavailable
variant evidence in `x-openplans-gaps`. Combined medical/drug accumulators and
network tiers and per-person/per-group scopes are labelled in the existing text fields. It adds no wire
fields for CSR. Its no-selection behavior also defaults to `-01`.

The cached TX PY2026 oracle runs with `node scripts/oracle/csr.mjs` after build,
or through `scripts/realdata.sh --year 2026`. An independent Python csv/Decimal
parser checks every silver base's `-04/-05/-06` attribute and benefit evidence
against native HTTP responses, confirms the Rate PUF base-ID granularity, and
rejects income-selection and missing-evidence fallback mutants. Results:
`OPENPLANS_DATA_DIR/reports/p5f-csr.md` and `.json`. Regenerate the committed real
seven-variant fixture with `python3 tests/fixtures/puf/regenerate-csr.py` using the
same already-acquired cache archives. No eligibility calculation is performed.

Sources: [CMS PY2026 Plan Attributes dictionary](https://www.cms.gov/files/document/planattributes-datadictionary-py26.pdf)
and the immutable CMS archive URLs/hashes recorded in the fixture provenance and
real-data report.

### Optional CMS coverage in quotes

`OPENPLANS_CMS_FALLBACK_QUOTES=on` lets `/v1/quotes` fill eligible unknown provider
and drug cells through the [CMS coverage fallback](../ingest/cms-api/README.md).
It defaults to off and also requires `OPENPLANS_CMS_FALLBACK=on` and `CMS_API_KEY`.
It spends the shared daily budget faster. All plans and both coverage kinds share
the existing two-call request cap. Pairs beyond it stay unknown with
`cms_api_request_cap`. File evidence wins, and drug checks require local RxNorm.

Each cell filled by the fallback carries the existing `cms_api` provenance object.
Its `sourced_by` is `cms-marketplace-api`. Quote cells also include `freshness`,
which is `fresh` for a stored unexpired answer, `stale` for a stored expired answer
served within its policy window, or `refetched` for an answer retrieved during the
request. `DataNotProvided` stays unknown. `NotCovered` stays unknown with
`cms_api_reports_not_covered` unless local NPPES or active RxNorm identifies the
provider or drug. The original CMS statement remains in `cms_api.coverage`. CMS coverage flags do not supply tiers,
restrictions or patient prices.
