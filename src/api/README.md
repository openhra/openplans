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
POST /v1/ichra/affordability/batch  (private, off by default)
GET  /v1/carriers?state=TX[&year=2026]
GET  /v1/networks?state=TX[&year=2026]
GET  /v1/drugs?q=metformin[&limit=50]
GET  /v1/drugs?ndc=00071-0155-23
GET  /v1/drugs/860975
GET  /v1/plans/76589TX0010015/drugs/860975?year=2026
POST /v1/drug-coverage
GET  /v1/providers?zip=77030&radius_miles=5[&plan_id=76589TX0010015&year=2026&taxonomy=207Q00000X]
GET  /v1/providers/1000000000[?year=2026]
GET  /v1/plans/76589TX0010015/providers/1000000000?year=2026
POST /v1/provider-participation
GET  /v1/data-policy
GET  /v1/data-availability[?state=TX&year=2026]
GET  /v1/cache-stats
GET  /v1/medicare/plans?county_fips=48201&year=2026[&type=ma|ma_pd|pdp|snp|cost&snp_type=&page=]
GET  /v1/medicare/plans/H0028-042-0?year=2026
GET  /v1/medicare/plans/H0028-042-0/benefits?year=2026[&table=pbp_section_d]
GET  /v1/medicare/plans/H0028-042-0/service-area?year=2026
GET  /v1/medicare/plans/H0028-042-0/lineage?year=2026
GET  /v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=860975     (off by default)
GET  /v1/medicare/plans/H0028-042-0/pharmacies?year=2026&zip=77002   (off by default)
GET  /v1/medicare/data-availability
POST /v1/medicare/plans/H0028-042-0/drug-cost-estimates?year=2026   (off by default, bearer token)
GET  /healthz
GET  /readyz
```

Medicare routes are described in the [Medicare guide](../../docs/medicare.md). NPI
`1000000000` in these examples is synthetic. `/healthz` is the liveness check and `/readyz`
the readiness check; [migrations](../../docs/migrations.md) says what each answers while a
migration is pending. `/v1/cache-stats` reports response cache counters, as the
[cache contract](cache/README.md) describes. The MCP endpoint is `/mcp`; see the
[self-hosting guide](../../docs/self-host.md#mcp-endpoint).

With a CMS API key configured, the API prepares ZIP fallback policy in the background.
Readiness checks only the database and schema. An early live ZIP lookup shares the
policy attempt but waits at most 250 ms for it. Past that it answers from ZCTA and
stored fallback rows, or `status: "unknown"`, and that answer is not cached. The
attempt continues for later requests and gives up after six seconds. Failed
attempts retry with backoff from one second to one minute. A policy denial blocks fallback use until a later
check succeeds. Availability rows describe configured sources throughout preparation,
failure and recovery. Logs contain controlled reason codes, without publisher error details.

Plan search and detail require an explicit year. Premium coverage_start supplies
the year. Carriers/networks can list all imported years, with plan_year on each row.
Search is individual medical only, sorted by base ID, 50 plans per page. Plans
retain base and variant IDs, issuer/network records, exchange flags and the
source snapshot IDs. Detail retains each benefit's published variant ID and raw
and parsed cost-sharing text. A base-ID request selects the standard on-exchange variant (`-01`) for cost sharing.
It never substitutes another variant when that evidence is missing.

Plan views and premium estimates include `catalog_metadata` for the selected variant.
Its `attributes` object uses normalized CMS column names and published values for plan type,
HSA eligibility, dates, document links, design, EHB premium share and actuarial values.
Blank cells are null. `AVCalculatorOutputNumber` retains its published fraction, while
`IssuerActuarialValue` retains its published percentage. `provenance` identifies the
snapshot and source row. If the selected row is absent or its year, state or plan ID
differs, the status is `unknown` and attributes and provenance are null. The metadata
uses the plan's annual serving window.

ZIPs use Census ZCTAs, not postal delivery boundaries. Unknown/PO-box ZIPs return
unknown, no guessed county. A ZIP spanning counties requires an explicit county;
until then search/premiums return ambiguous. A supplied county must occur in the
ZIP's imported relationship rows. County-only searches exclude ZIP-restricted
plans because availability cannot be established without a ZIP. Searches with no
active state/year catalog return unknown.

Plan search and public quotes add `issues`, a list of reason codes that say why the
plan list may be short or empty. It is empty when no plan is known to be missing.

| Code                               | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `zip_limited_service_area`         | County only, and some plans serve only part of the county. Send a ZIP      |
| `zip_not_in_loaded_geography`      | The ZIP is not in the loaded geography                                     |
| `state_catalog_not_loaded`         | No active catalog for the county's state and year, including NY/VT filings |
| `template_saved_before_submission` | A refused New York rate template leaves that issuer's plans out            |

Other refusal codes from the New York template check (see the state ingest README) can
appear the same way. The MCP tools `search_plans` and `quote_plans` return the same list as
`location_issues`. The compatibility API adds each code to `x-openplans-gaps`; see its README.

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
OPENPLANS_PUBLIC_QUOTING=off to return 503 `quoting_disabled`. Each source may send
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
`location_requires_zip` with reason `zip_limited_service_area`. A stand-alone dental
plan that serves only some of the county's ZIP codes gives the same answer when a
child under 19 needs the pediatric dental adjustment. The benchmark, credit
and net stay null until the request includes a ZIP. Gross premiums do not change.
A ZIP outside the loaded geography gives status `unknown` with reason
`zip_not_in_loaded_geography`. A New York or Vermont county without its filed state catalog
gives `unsupported_rating_method` with reason `state_catalog_not_loaded`. Both codes also
appear in `benchmark.issues`. A requested plan that cannot be rated has no
applied credit/net. Off-exchange and catastrophic plans receive no estimated
credit (`plan_ineligible_for_tax_credit`). CSR variant eligibility is not inferred.

Two more benchmark answers carry a reason in `issues`. A ZIP outside the loaded geography gives
`unknown` with `zip_not_in_loaded_geography`. Request routes read the database read-only, so the
optional CMS ZIP lookup uses only its cached rows there and never calls out. New York and Vermont
rate by filed family tier. When no state catalog is loaded for the year, they give
`unsupported_rating_method` with `state_catalog_not_loaded`. With one loaded, the household
benchmark is `requires_state_rules`. On premium quotes these appear as `subsidy.status`, with
the reason code in `subsidy.benchmark.issues`.

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

Name and NDC searches also return `terminology_status`. It is `available` when an RxNorm
release is ACTIVE, and then an empty list means nothing matched. Otherwise it is `unknown`
with `reason: "rxnorm_terminology_unavailable"`, and the empty list says nothing about the drug.

With no release ACTIVE and the RxNav source switched on (`OPENPLANS_RXNAV_IDENTITY=on`), a name
search asks RxNav's `/REST/drugs.json?name=` instead. Its current, unsuppressed concepts come back
with `terminology_status: "passthrough"` and `terminology_evidence`, RxNav's evidence block with
NLM's acknowledgement statement and the terms URL. They are suggestions for picking an exact
RxCUI. `exact_concept_required` stays `true`, they are never coverage answers, and a search never
confirms an RxCUI. A name RxNav does not know comes back the same way with an empty list. When
RxNav cannot be asked (budget, pacing, outage, `passthrough=off`), the answer stays `unknown`.
`rxnav` is named in `x-openplans-upstream` whenever RxNav was asked. NDC searches never ask RxNav.
The MCP `search_drugs` tool serves only suggestions a REST search already fetched, with each
candidate as `kind: "drug_suggestion"`.

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
for the page. A name with a literal word of three or more characters works the other way
round. The trigram index on NPPES names (migration 740) finds the matching identities first.
With up to 1,000 matches, the search reads only their practice addresses and checks each
point's distance from the covering index added by migration 1006, so it reads full point rows
only inside the radius. With more matches, such as a common surname across every loaded
state, it scans the radius once and keeps only points of matching NPIs.
An exact taxonomy code resolves its identities through the code index the same way before
counting unlocated addresses. These paths return the same records, totals and counts as the
radius scan; the case-insensitive substring match still decides every name.

On a database with many states, both directions read rows spread over every loaded state.
Search keys avoid that (migration 1007, `provider-search-keys.ts`). `worker backfill
provider-search` writes one row per located practice point of each identity, with its scope,
type, `concat_ws` name and taxonomy codes, ordered by a 0.1-degree grid cell. Practice addresses
without a current point become rows without a cell. A radius search then reads the cells around
its origin as one compact run of rows and applies the same filters and `ST_DWithin` test. That
gives every matching identity with its nearest distance, the total and the page. Only the 50
page identities are then probed for their full point and address rows. The unlocated count is
the number of cell-less rows that pass the filters, read in the same search. A search uses the keys
only while the revisions of `address_point`, `npi_address`, `npi_provider` and `npi_taxonomy`
equal the ones they were built from, checked again inside the search's own snapshot. After any
import or geocode run they are stale until the next build, and searches take the paths above.
Compatibility location pages with a name, taxonomy, specialty or type filter use the same keys.
Every matching identity in the radius comes from the cells, and the search then reads only those
identities' practice addresses and points to build, count and page the normalized locations. A
location page has to read every matching identity, so it reads the keys only up to 2,000 of them.
Above that, and for pages without a filter, the radius scan reads fewer rows and answers. An operator geocoder point can replace a ZIP-centroid point or
locate an address the Census geocoder tied or missed. The search reads the identities it touches
from the effective points and every other identity from its keys. Plan searches never use the
keys, because issuer addresses and their points are not in them. Searches without PostGIS or
without a radius don't use them either.
The worker fills the idle one of two slot tables and then switches, so no search waits for a build. Issuer radius search intersects spatial hits with current participating
record keys before indexed address validation. Record IDs may contain colons; the
last source-key component is the address ordinal, and the API rechecks the full key.

`total` is exact, including on empty and out-of-range pages. `meta.unlocated` is exact or
`null`. The unlocated count is an independent anti join over **all** identity/plan-filtered
candidate practice/issuer addresses, before the radius cut; it is not restricted to
spatial hits, and address-less identities do not add an unlocated address. It is never
an estimate. For an NPPES identity search with PostGIS and a radius, the count does not
depend on the origin or radius, only on the filters. Current search keys give it within the
search. Without them, the API counts it once per filter set and revision of the provider tables
`address_point`, `npi_address`, `npi_provider` and `npi_taxonomy`, plus `geocode_attempt` and
`provider_taxonomy`, which operator points and specialty filters read. It keeps the result in
the process until one of those tables changes; plan catalog writes leave it alone. That count
has its own two-minute limit and runs on a database connection of its own, outside the request
pool, one count at a time. A search that cannot wait for it, or that finds another filter set's
count running, answers with `meta.unlocated: null` and `meta.unlocated_status: "unknown"`, never
a guess. The MCP `search_providers` tool returns the same state as `unlocated_status`. The
response cache does not keep such an answer. The count keeps running, and the next search with
the same filters reads it. A count that runs past its limit is not tried again for ten minutes,
and searches in that time answer it as unknown. The compatibility API adds
`provider_unlocated_count_unknown` to its gaps header in that case. A point from an older address snapshot does not locate a
current address. Without PostGIS the existing spherical-distance filter still runs
before pagination. Ten-mile statewide TX checks for Dallas, Austin and El Paso, and
the Harris County provider check, were measured on the retained external PostgreSQL volume;
these are quiet-database measurements, not a concurrent-load guarantee.

Every database read has a 5-second limit. A read that runs past it answers HTTP 504 with
`{"error":{"code":"query_timeout"}}` on the native and compatibility APIs. MCP tools answer an
error with code `query_timeout` and `retryable: true`. A timeout is never reported as an
internal error.

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
`source_incomplete`. `/v1/data-availability` adds `provider_coverage` per issuer/year with
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
To run every suite that needs PostGIS at once, build `Dockerfile.db` and run
`scripts/postgis-tests.sh --image IMAGE`. It starts a disposable container, gives each suite its
own database, fails if any test is skipped and removes the container. CI runs it on every push.
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
`conflicting_variant`. The literal `03` means limited cost sharing, not CSR 94.

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

### Upstream disclosure and `passthrough=off`

A pass-through source answers at request time when the loaded files leave a coverage question
`unknown`. The CMS coverage fallback is one. When a pass-through source filled any answer in a
response, the response has an `x-openplans-upstream` header with the source ids, comma-separated,
for example `x-openplans-upstream: cms-marketplace-api`. The header lists sources whether they
answered during this request or from their stored answers. It also lists a source whose call
failed or that the upstream refused, because the question still left the server. A ZIP
lookup that consulted the CMS county service for a ZIP the loaded geography lacks is listed the
same way, whether the answer was fetched now or read from a stored lookup. A call the
server declined itself, for budget or pacing, sent nothing and is not listed.
It never carries the plan ids or codes that were asked. A response built only from loaded files has no header. A cached response replays
the header it was stored with. The compatibility API sends the same header and lists it in
`Access-Control-Expose-Headers`. MCP tool results put the ids in `_meta["openplans/upstream"]`.

Send `passthrough=off` to keep a request local. It works in three places:

- as a query parameter on any route, such as `/v1/plans/{id}/drugs/{rxcui}?year=2026&passthrough=off`
- as a body field on `POST /v1/drug-coverage`, `POST /v1/provider-participation`,
  `POST /v1/quotes` and the compatibility plan searches, such as `{"passthrough":"off", ...}`
- as the `passthrough` argument of the MCP tools `check_drug_coverage`, `check_provider_network`
  and `quote_plans`

With `off` the server asks no pass-through source and skips their stored answers. A question a
source could have answered stays `unknown` with reason `passthrough_declined`. `on` or no value
keeps the default. Any other value returns 400 `invalid_input` with `field: "passthrough"`.

## Links on unknown answers

When the loaded files cannot answer a coverage question, the `unknown` answer can carry `links`,
pages a person can open to check for themselves. OpenPlans never fetches them and draws no
conclusion from them. An answer with any other status never carries `links`. That includes an
answer a later source filled in, such as the CMS fallback or an issuer document.

Each link has `kind: "link_out"`, a `rel`, the `url`, its `source`, and the `snapshot_id` and
`source_row` of the catalog row that published it. Both are null for a page built from an
identifier.

| Answer                                                | `rel`                                  | Comes from                                                                  |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Provider participation                                | `provider_directory`                   | the plan network's `NetworkURL` (Network PUF)                               |
| Provider participation                                | `npi_registry`                         | the NPI Registry page for the requested NPI                                 |
| Drug coverage                                         | `formulary`                            | the plan's `FormularyURL` (Plan Attributes PUF)                             |
| Plan `cost_sharing` with `benefits_status: "unknown"` | `summary_of_benefits`, `plan_brochure` | the selected variant's `URLForSummaryofBenefitsCoverage` and `PlanBrochure` |
| Medicare Part D drug                                  | `medicare_plan_finder`                 | the Medicare Plan Finder page for the contract, plan and segment            |

State-based exchange bundles fill the same columns, and OpenPlans reads them the same way. It
serves only http and https URLs without credentials; MCP tools show https links only. The plan
read brings the URLs along in the same statement, so a link adds no query. OpenPlans never
serves a URL from a snapshot that is not ACTIVE, such as a quarantined one. Compatibility API
responses do not change.

## Error answers

REST errors use `{"error":{"code":"...","field":"...","hint":"..."}}`, including compatibility, plugin and admin JSON errors. `field` and `hint` are optional, codes are lower snake case, and `src/api/errors.ts` builds every body. Every `unknown` status carries a reason from the `reasons` list in `docs/public-contract.json`.
The nonempty `code` is required. Optional `field` names the refused input and never echoes its value.
Some errors include a fixed `message` or domain details.
The [quoting guide](../../docs/quoting.md#errors) lists the quote codes in full.
Unknown routes return 404 with `not_found`.
Health and readiness failures include the same error object alongside their status fields.
MCP tool errors carry this object inside their result envelope, with nullable `field` and
`retryable`. JSON-RPC protocol errors retain numeric codes and a required message.

| HTTP | Codes                                                                                                                                                                                                                                                                                                                | When                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 400  | `invalid_input`, `invalid_json`, `request_too_large`, `unknown_field`, `year_required`, `invalid_year`, `location_required`, `zip_or_county_required`, `age_or_dob_required`, `unsupported_market`, `query_or_ndc_required`, `invalid_ndc`, `taxonomy_or_specialty_required`, `invalid_plan_key`, `invalid_schedule` | An input is missing, malformed or not allowed; the quote caps and duplicates add their own codes   |
| 401  | `unauthorized`                                                                                                                                                                                                                                                                                                       | A token is configured and the bearer token is missing or wrong                                     |
| 404  | `plan_not_found`, `drug_not_found`, `provider_not_found`, `catalog_not_loaded`                                                                                                                                                                                                                                       | The plan, drug or provider isn't in the active data, or no Medicare catalog is loaded for the year |
| 422  | `unsupported_without_taxonomy`                                                                                                                                                                                                                                                                                       | A specialty name search before NUCC taxonomy is imported                                           |
| 429  | `rate_limited`                                                                                                                                                                                                                                                                                                       | A per-source limit; `Retry-After` gives seconds                                                    |
| 500  | `internal_error`                                                                                                                                                                                                                                                                                                     | An unexpected failure; the log keeps only an error class and a stack hash                          |
| 503  | `schema_not_ready`, `auth_not_configured`, `quoting_disabled`                                                                                                                                                                                                                                                        | A migration is pending, a closed household route has no token, or public quoting is off            |
| 504  | `query_timeout`, `request_deadline`                                                                                                                                                                                                                                                                                  | One database read passed 5 seconds, or a quote, benchmark or ICHRA check passed 15                 |

`GET /v1/data-availability` answers 503 `{"error":{"code":"data_availability_unavailable"}}` when the
database read fails, so a failure never looks like an empty list.

### Request ids and reporting a problem

Every API and MCP HTTP response carries an `x-request-id` header. A request that sends its own
`x-request-id` of 1 to 128 visible ASCII characters gets that value back; a missing, longer or
unprintable value is replaced with a generated 16 hex digit id. Every REST error body repeats
the value as `error.request_id`, and the internal error log line and the MCP request log line
carry it as `request_id`. JSON-RPC protocol errors carry the header only. Rate-limited answers
(429) keep their `Retry-After` header.

When you report a problem, send the `x-request-id` of the failing response, the route and the
time. The contact section of <https://www.openhra.com/> says where to send it. Leave out API
tokens, personal details and request bodies.

## Optional individual offer distribution

The opt-in compare plugin adds `GET /compare/v1` (browser forms),
`GET /compare/v1/market` (JSON) and `POST /compare/v1/print` (HTML from JSON or browser
form fields). MCP `compare_market_costs` uses the same age or household input and result.
For example, `GET /compare/v1/market?zip=77002&county=48201&year=2026&age=40` returns the
gross, non-tobacco Silver offer distribution when that public scope is loaded.

Set an explicit year, ZIP or county, and either one age or household members. Other
supported metals are bronze, expanded bronze and gold. Employer, group and census inputs
are refused; public group costs are unavailable. Keep both TPA switches off so the private
employer routes do not register. Later evidence pages require `evidence_page` and the full
returned `data_generation` token. Missing prices stay unknown; the print sheet includes
counts, exact statistics, source evidence and a link to the next evidence page. See the
[comparator README](../../plugins/compare/README.md) for the complete contract and examples.

<!-- lowest-premiums:generated -->

## Lowest premiums and market summary

Enable `OPENPLANS_LOWEST_PREMIUMS=on` or `lowestPremiums: true` in the config file.
The default is off. Set `lowestPremiumsScope: "single_age_silver"` to admit only ZIP-based non-tobacco Silver minimums and unpriced market counts. This scope omits household POSTs and MCP benchmark; direct calls reject the excluded inputs. The default `full` scope retains the contracts below.
For a ZIP visitor flow, see [Lowest Silver by ZIP](https://github.com/openhra/openplans/blob/main/docs/lowest-silver.md).
The GET routes and single-age MCP tools follow the public quoting switch and admission
limits. Responses use `Cache-Control: no-store`; every pricing read checks generation and publication expiry.

`GET /v1/lowest-premiums?zip=77002&county=48201&year=2026&age=40` returns the lowest
gross on-exchange premium for one person. Send both year and age. It supports silver,
bronze, expanded bronze and gold, tobacco selection, individual medical plans and January 1 coverage.
The answer does not evaluate subsidies and is not a bindable quote.

Accepted fields: `zip`, `county`, `year`, `age`, `metal`, `tobacco`, `coverage_start`, `market`, `coverage`, `market_segment`, `premium_basis`, `page`, `evidence_page`.
Errors use `{"error":{"code":"..."}}`, with an optional `field` naming the refused input.
The route rejects unknown fields. Select a county when a ZIP spans several.
A published cell with missing catalog or pricing evidence returns an unknown result with no minimum.
An unpublished, stale, expired or incomplete cell returns HTTP 404 with `error.code: "lowest_not_built"`.
The matching MCP tool returns the same code as a tool error. Requests never build a missing cell.
ZIP requests resolve to county cells. A county with ZIP-limited offers or sub-county rating areas returns `location_requires_zip` with no price, even when a ZIP is supplied.
Tied plan IDs are sorted and paged at 50. MCP tie pages use a generation-bound cursor. Candidate and evidence details use `evidence_page`, with 10 candidates per page. Every page keeps the winner, exact integer cents, total tie count, completeness and source references. The MCP response has a 128 KiB byte limit. It marks omitted rows with `truncated` and `omitted`. REST defaults to the first tie and evidence pages; use `page` and `evidence_page` to read more. The result is a gross premium, separate from SLCSP.

`GET /v1/market-summary?zip=77002&county=48201&year=2026` and MCP `get_market_summary`
report distinct on-exchange base-plan and issuer counts by metal. Add `age` to request gross minimum
and maximum prices. Tobacco can be set only with an age. Counts keep bronze and expanded bronze
separate. Missing catalog data stays unknown, and a ZIP that spans counties needs an explicit county.
Platinum and catastrophic counts are available, but their price ranges are not supported.

Market summary fields: `zip`, `county`, `year`, `metal`, `market_segment`, `age`, `tobacco`, `coverage_start`.

Household requests use `POST /v1/lowest-premiums` or `POST /v1/market-summary` at the same paths.
Send `year`, a `zip` or `county`, and 1 to 10 `members`. Each member supplies an integer
`age`, `relationship` and boolean `tobacco`. Relationships are `subscriber`, `spouse`,
`child` or `other`. Optional `coverage_start` defaults to January 1 of the requested year.
The minimum defaults to silver. The summary covers supported metals unless `metal` is selected.
Household routes use the existing household token or public-household policy. They rate every
eligible plan for the complete household, including child charging limits and filed family tiers.
They accept no income, names, birth dates or preset households and never cache household results.
MCP `get_lowest_premiums` and `get_market_summary` also accept members, with the household grant.
Household evidence pages contain two detail rows plus the selected minimum/maximum evidence. Follow `next_evidence_page` to inspect the remaining rows. Member `rate_row_refs` index the complete `rating.rate_rows_used` table within that evidence record.
Supply either a single age or members. Household tie pages contain 50 IDs; candidate evidence uses
`evidence_page` with 10 rows per page plus the selected extremes. Evidence references resolve within each page.
An oversized MCP result returns `result_too_large` rather than dropping required evidence.

MCP `get_benchmark` takes `year`, `location: {zip, county}` and 1 to 100 integer `ages`.
It follows household access rules and the same feature switch. Its result preserves the existing
`GET /v1/benchmark` answer and adds a basis describing January 1, non-tobacco pricing,
EHB allocation and pediatric dental adjustment. Missing adjustment evidence stays unknown.
The existing REST benchmark and ICHRA calculations keep their current contracts.

Build a county/year/age cell with
`worker build lowest-premiums --year 2026 --age 40 --zip 77002 --county 48201`.
This command requires migrated tables and admitted imported data. Successful imports
rebuild registered cells while the switch is on. Fresh cells are reused on repeated builds.

For release preparation, mount the admitted national Census relationship snapshot at its recorded raw path, then run `worker prebuild lowest-premiums --years 2026,2027`. A missing or corrupt snapshot refuses the default inventory.
It streams every county in the loaded geography for ages 0 through 64 in each selected year,
using Silver, non-tobacco, January 1 pricing. Use `--dry-run` to count the inventory first.
For a bounded publication, pass `--inventory /absolute/path/cells.json`, a JSON array of
request objects such as `[{"zip":"77002","county":"48201","year":2026,"age":40}]`.
ZIP forms normalize to counties, and ages above 64 share the filed 64+ or admitted state community-rating cell. Unknown rating rules remain unknown. Full evidence is stored once per county/year in a lossless shared dictionary.
Only built cells can be served; an inventory does not change the feature or admission switches.
Use `--max-cells N` to limit new builds per invocation, then rerun the same command to resume.
A partial run exits 2. A complete run reports cell counts, a stable digest and database sizes.
The digest covers the input manifest, normalized inventory and full stored payloads, excluding build IDs and timestamps.
Sources changing during a run fail it. The county publication format replaces older derived cells during migration. Rebuild after a pricing snapshot, geography, rule or algorithm change,
and before cells expire. Cells expire after one day or at the source snapshot expiry, whichever comes first. Record policies can shorten that lifetime.
Reports separate uncompressed binary dictionary and cell bytes from stored payload bytes. Both totals are bounded to 1 GiB, with a 2 GiB limit on derived relations and indexes;
one cell may use at most 2 MiB. A budget failure leaves completed cells available for resuming.
The completion audit must pass before treating an inventory as published.
<!-- /lowest-premiums:generated -->

Private installations can opt into [census affordability batches](../../docs/census-batch.md).
The route accepts at most 25 unchanged employee requests and requires private
ingress plus API authentication. It has no MCP tool and stays off on public installations.
