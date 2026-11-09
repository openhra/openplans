# Compatibility API

This module is a compatibility API for existing quoting integrations. It maps results from
native OpenPlans repositories and domain functions to the keys, primitive types and nesting
those integrations expect. It reads only native data and calls no outside API. Remove
the single mount line in `src/api/app.ts` and delete this directory and its tests
to remove the facade. There are no new dependencies or native schema changes.

## Routes and inputs

All paths below are under `/compat/v1`.

| Method/path | Inputs |
| --- | --- |
| `GET /zip_counties` | `zip_prefix`, 3–5 digits; resolves only loaded Census ZCTAs |
| `POST /plans/medical/search` | `fips_code`, nonempty `applicants` (`age`, optional `smoker`, `child`); optional `zip_code`, `market`, `enrollment_date`, `ids`, `sort`, `page`, `per_page`, `household_income`, `household_size`, `tax_filing` |
| `GET /plans/:id`, `GET /plans/medical/:id` | Base/published variant HIOS identifier, or URL-encoded native VT `plan_key`; optional `year` |
| `GET /drugs` | `search_term`, optional `page`, `per_page` |
| `GET /carriers` | Optional `state`, `year`, `market`, `line_of_coverage`, `page`, `per_page` |
| `GET /networks` | Optional `state`, `year`, `page`, `per_page` |

Pagination is 1-based; `ids` accepts up to 100 identifiers. Medical pages are capped at **50**.
For example, `page: 2, per_page: 100` starts at offset 50, not 100. Smaller requested
sizes are honored. Other lists retain their 1,000-record cap. Inputs above 1,000
remain invalid. Defaults are 10 medical plans, 25 drugs and 100 carriers/networks. Plan sorting
supports `premium`, `premium_subsidized`, `level`, `name`, `id`, with an optional
leading `-`. Sorting occurs before pagination, with ascending public ID as the
tie breaker and unknown prices last in either direction. Without `sort`, public ID
order is deterministic and independent of the order of an `ids` filter. Totals count available public
results after filtering.

`default_plan_order_unverified` flags the public-ID default order. Use explicit `sort`
for a chosen ordering, or `ids` for a particular set of plans. Missing public plans
remain absent, with no invented placeholders.

All compatibility requests accept `X-Api-Key`, compared in constant time against
`OPENPLANS_COMPAT_API_KEY`. To support a client that sends a different credential
header, optionally set `OPENPLANS_COMPAT_KEY_HEADER` to that one header name
(for example `X-Client-Key`). Both accepted headers use the same key and comparison;
either may authenticate a request. No other credential headers are enabled.
An unset or empty extra-header setting disables it. A configured name must be a
single RFC 7230 token: ASCII letters, digits, or `!#$%&'*+-.^_` plus backtick,
`|` and `~`. Whitespace, commas, colons and other characters prevent API startup.
Header names are case insensitive.

Missing server key configuration returns 503; missing/wrong keys return 401.
`Accept-Version` is tolerated. CORS allows origin `*`, methods `GET, POST, OPTIONS`
and request headers `Content-Type, X-Api-Key, Accept-Version`, plus the configured
extra header (without duplicating a default header). Preflight returns
204 without credentials; browsers can read `x-openplans-gaps`. Responses use
`Cache-Control: no-store`. Keys, request bodies and headers are never logged.
Native `/v1` authentication still uses `OPENPLANS_API_TOKEN` with Bearer auth.

## Run mk03 against OpenPlans

Use the client's existing private key as `OPENPLANS_COMPAT_API_KEY` in the
OpenPlans service environment. Send it as `X-Api-Key`, or set
`OPENPLANS_COMPAT_KEY_HEADER` to the client's existing credential header name.
No client key change is needed. Compose passes both settings to the API service.
Do not put real credentials into this README or
shell command history. Start the built API on port 3001 with a prepared database:

```sh
npm run build
# PostgreSQL: set DATABASE_URL and OPENPLANS_COMPAT_API_KEY privately, then:
PORT=3001 npm start
# Or a private prepared PGlite copy, with OPENPLANS_COMPAT_API_KEY set privately:
PORT=3001 OPENPLANS_PGLITE_DIR=/absolute/prepared/pglite npm run api:pglite
```

In mk03 set its API base URL to `http://localhost:3001/compat/v1` and restart
its development server. Configure the credential header as described above.
The retired compatibility path has no alias and returns 404.

The PGlite runner binds to 127.0.0.1. `OPENPLANS_API_TOKEN` remains a separate native API
credential. Fields without public evidence stay null and are listed in `x-openplans-gaps`.

## Conditional subsidies

Medical search accepts annual MAGI dollars as `household_income`, tax family size
as `household_size`, and the native `tax_filing` enum (for example `single` or
`married_filing_jointly`). Income and size must be provided together. Filing is
never inferred from applicant count. Missing/separate/non-filing status leaves
subsidies unresolved. Native benchmark, parameter, state-rule and pediatric-dental
limitations apply; see `src/api/README.md`. No CSR variant is chosen from income.

The existing response fields carry results in dollars: `plan.premium` remains
gross, `plan.premium_subsidized` receives net after the per-plan gross cap, and
`meta.premium_tax_credit` receives the household credit before that cap. No new
plan or meta keys are invented. `state_subsidy` and `eligible_for_chip_medicaid`
remain null. Sorting by `premium_subsidized` uses these results before pagination.

Without a resolved household credit, `subsidies_unavailable` remains in
`x-openplans-gaps`, accompanied by `household_subsidies_unavailable` and the native
subsidy reason when an income-bearing medical request was evaluated. Resolved
estimates instead retain `puf_calculation_non_bindable`,
`state_subsidies_unavailable` and `csr_eligibility_not_evaluated` in this header.
Unrated plan premiums still add the relevant premium/subsidy gap. A zero credit
above the confirmed income cliff is a resolved calculation; an unknown credit is null.

## Defaults and evidence gaps

Search requests may omit a year. The facade defaults omitted `enrollment_date`
to **2026-01-01**, and detail/list `year` to **2026**; lists default to **TX**.
Explicit dates determine the quote year. Native rating, tobacco, child-charging,
ZIP/county mismatch and service-area rules remain authoritative. ZIP lookup uses
the native Census / optional CMS / loaded GeoNames source precedence. An unresolved
ZIP stays unknown even if a county was also supplied; another location is never substituted.
Searches use loaded individual on-exchange federal medical plans,
NY/VT filed medical catalogs, and individual SADPs; unsupported markets return an empty result with a gap reason.
County and Alaska ZIP3 rating areas delegate to native resolution, without a TX restriction.
NY filed-area availability does not prove exchange/enrollment eligibility: `on_market`,
`off_market` and `plan_market` remain null where the native view says unknown.

NY/VT gross premiums select the native approved contract tier, with `state_filed_tier`
in `x-openplans-gaps`. Medical plan `source` and `premium_source` use `state` for these
filings and `cms` for federal PUFs. Native routes retain their full source vocabulary.
`plan_market` uses `both_markets`, `on_market`, `off_market` or null, based on native flags.
Per-applicant allocations stay empty
because the state filings supply contract totals. Native state-rule/subsidy limitations remain
in the gaps; no age/tobacco factors or subsidy amounts are invented. Full source-cell/rule
provenance remains available through native premium quotes.

`plan.id` is an opaque string with no required HIOS syntax. VT therefore uses its native `plan_key`
(for example `BCBSVT:Gold Plan`) for `plan.id`, search `ids[]`, and detail roundtrips.
`identifiers` is empty, with `hios_ids_unavailable` and `plan_ids_are_native_plan_keys`:
the internal key never becomes an identifier of type `hios_id`. NY retains published HIOS IDs.

Every successful mapped response includes `x-openplans-gaps`, a comma-separated
list of machine-readable reasons. Unsupported vision detail and Medicare Advantage routes return 501 plus this header.
Vision search always returns `200`, `{meta:{total:0},plans:[]}` and
`vision_unsupported`; malformed search bodies still return 400. The response-level
`coverages` array stays empty when `providers` or `drug_packages` were requested,
with an explicit coverage gap. Plans omit the unused `providers` field.

Some fields have no public or native evidence. They are null, with a gap header.
OpenPlans cannot fill them for a client that requires non-null values without
inventing data, so consumers must accept nulls. Missing evidence never becomes
`false`, `0`, "not covered", a guessed document URL or a fabricated premium.
The shape checks enforce required keys, non-null primitive types and nesting,
and allow these nulls and empty collections.

* Quotes expose gross `premium` and per-applicant amounts from the native rating
  engine. Without resolved subsidy inputs, `premium_subsidized` and premium tax
  credit are null. State subsidy and Medicaid eligibility remain null. Conditional
  credit/net mapping is described above.
* The public catalog lacks carrier-only off-exchange plans. Generic searches
  advertise `off_exchange_catalog_incomplete`. An `ids` filter additionally lists
  each unavailable requested identifier as `public_plan_unavailable:<id>`.
  Absence alone does not classify an arbitrary identifier as off-exchange.
* Native catalog views supply names, metal, issuer, network names and exchange
  flags. The selected variant maps available native benefit rows to labelled
  copay/coinsurance strings, preserving publisher conditions, tier 2 and limits.
  Base IDs default to the standard on-exchange variant; missing evidence stays
  null with `variant_cost_sharing_unknown`. Published deductible/MOOP summaries
  label their scope. Unmapped plan metadata and benefits with no evidence stay
  null. These are implementation/native-view gaps, not claims that CMS lacks
  those fields.
* Carrier IDs are CMS issuer IDs (strings), scoped to loaded state/year sources.
  Markets/lines come from the native Network PUF census. Issuer crosswalk
  arrays stay empty. Geographic numeric IDs remain public FIPS/ZIP aliases so
  existing geographic joins continue to work. No public crosswalk to other numeric
  ID schemes exists; `vendor_geography_ids_unavailable` says so. ZIP/county join-row IDs and
  exchange-state flags stay null. `counties[].fips_code`, `states[].fips_number` and `zip_codes[].code`
  retain the public codes as strings, including leading zeros. County display
  names use the unique label from an active Census relationship for that same
  FIPS when available (for example `Harris County` instead of postal `Harris`).
  Otherwise the published source label is retained; suffixes and identifiers
  are never inferred. Postal attribution/source fields remain present.
* External network IDs are unavailable: `networks[].id` is null and `network_ids`
  is empty. Network names and published directory URLs come from the native
  catalog; no arbitrary numeric surrogate is advertised. Import dates are null.

## Drug identity and counts

`drugs[].id` is `rxnorm:<RxCUI>`. Each result is one active matching RxNorm
concept; alternate published names/TTY rows for the same RxCUI are deduplicated.
`meta.total` counts those concepts, **not NDC products**. No fuzzy
brand/generic expansion or strength equivalence is implied.

Published RxNorm NDC associations become `drug_package_ids` and `drug_packages`.
Package IDs format the normalized 11 digits as 5-4-2, retain leading zeros, and
carry the exact associated `rx_cui_id`. A shared NDC may have multiple concept
associations; packages retain each association. `med_id`, package descriptions
and separately resolved ingredient-strength fields are null. Brand concept
names populate `proprietary_name`; other concept names populate
`non_proprietary_name`. The other name is null. No proprietary NDC-product IDs,
package quantities or patient prices are invented. The response header lists
these identity/count/metadata gaps.

An empty catalog import does not include terminology. Load RxNorm into the same
database as the API using the [terminology bootstrap steps](../../ingest/rxnorm/README.md#bootstrap-a-shopping-database).
With no ACTIVE terminology release, drug search returns an empty 200 response with
`rxnorm_terminology_unavailable`; a loaded release with no matching name returns
empty without that gap. Case-insensitive substring matching already handles
`metformin`, `METFORMIN` and interior name fragments; no TTY is excluded.

Only ACTIVE-release `RXNSAT` NDC attributes with `SAB=RXNORM` and `SUPPRESS=N`
supply packages. They do not contain container descriptions or `med_id`
values. Neither clinical concept names nor GPCK/BPCK pack names establish the
bottle/carton description for each NDC, so those fields stay null and their gap
remains. This import does not use the licensed full release or an FDA directory.

Searches use the public repository order: SCD/SBD first, prefix before other substring
matches, then lowercase name, RxCUI, TTY, suppression and exact name. The first
matching row represents a repeated RxCUI. Concepts paginate after deduplication;
their exact NDC strings sort ascending within each concept. No outside product
rank or opaque identifier is installed as source data.

Drug checks use the regenerable public RxNorm cut. They verify nonempty package
associations against raw `RXNSAT` rows, leading zeros, suppression, pagination,
case/substring matching and missing-release diagnostics. Temporary compiled
mutants that remove the NDC lookup or make name matching case sensitive fail the
same positive contracts; the real sources and raw fixtures remain unchanged.

## Verification

Run from the standalone `openplans/` directory:

```sh
scripts/ci.sh
npm test -- tests/compat/v1
```

The tests quote 43 public Harris County plans from real TX source cuts. An MN detail
request returns 404, and MN or other unloaded states return empty results, never TX
substitutes. Unknown drug/ZIP searches return empty 200 responses with evidence gaps.

The committed CMS CSV cuts retain archive hashes, source row offsets and their
own hashes in `tests/compat/v1/fixtures/provenance.json`. Rate groups include
all 51 age bands; split files stay below 200 KB each. Recreate them with
`python3 tests/compat/v1/regenerate.py` against the acquired shared cache.
Regeneration uses the public identifier selection in the provenance manifest.
RxNorm and Census fixtures reuse the existing independently regenerable cuts.

Negative controls alter a premium by one cent in a temporary response copy,
remove rate evidence inside a rolled-back test transaction, and request a non-TX
ZIP. Each must fail the checks used for valid responses. Original evidence is intact.

## Providers, specialties and nonmedical plans

| Method/path | Inputs |
| --- | --- |
| `POST /providers/search` | Required `zip_code`; optional `search_term`, `radius` in miles (0–500), `type` (`individual` or `organization`), `sort` (`distance` or `name`, optional `-`), `page`, `per_page` |
| `GET /providers/:npi` | Published NPI, optional `year` |
| `GET /specialties` | Codes present in the loaded in-scope NPPES identities |
| `POST /plans/dental/search` | Same location/household inputs as medical search |
| `GET /plans/dental/:id` | SADP base/variant HIOS identifier, optional `year` |
| `POST /plans/vision/search` | Required `fips_code`, nonempty `applicants`; explicit unsupported result |

Provider search also accepts native `plan_id` with optional `year`
(default 2026, flagged), and `taxonomy` or `specialty`. Taxonomy codes returned by
`/specialties` work as the specialty filter. Searches delegate to the native
`/v1/providers` logic, including its plan participation and geographic checks.
A ZIP-only request defaults to a 25-mile radius, flagged in gaps, to prevent
returning unrelated distant identities. Unknown ZIP centroids return empty with
a gap. The origin and any returned provider location using ZIP centroids are
separately flagged as approximate. Unlocated addresses excluded by the radius
are flagged; missing evidence never becomes nonparticipation.

Every NPI + normalized address appears once; duplicate issuer source records
are merged **across all native pages before facade pagination**. Each wire
location has a `provenance` array preserving all record IDs, source ordinals,
snapshots, source URLs, original address precision, timestamps and plan evidence.
Different NPIs, different addresses and missing-NPI source records remain distinct.
`meta.total` counts deduplicated locations. Numeric provider IDs/`npis` are public
NPIs; other state provider IDs remain null. `/specialties` and `npi_specialty` use native
NUCC display names/classification/specialization only when `taxonomy_status` is
`known`. Codes remain their IDs. Unknown codes retain null descriptions and
`specialty_descriptions_unavailable`; a mixed result retains that gap even if
other codes are known. A known code without a specialization legitimately maps
`sub_specialty: null`. The specialties list is a read-only projection of native
NPPES/NUCC tables because no native taxonomy-list route exists.
Specialty names and IDs come only from NPPES and NUCC.

Detail wraps one location in `provider` and adds `locations`, native
`plan_participations` and `provider_coverage`. All source locations and provenance
are retained. `networks`, `network_ids` and `hios_ids` are empty until a public
network crosswalk is available, flagged by `provider_network_crosswalk_unavailable`.
Native plan evidence remains in `plan_participations`; it does not populate an
external network or assign offices to one.
Coordinates are null because the native detail response does not
join geocodes. Record-level plan evidence never assigns participation to an
NPPES address or an unrelated issuer record. `network_ids` and `carrier_id`
filters have no public crosswalk: requests using them return empty plus
`vendor_carrier_or_network_filter_unsupported`, rather than ignoring the filter.

Dental catalog selection and pricing delegate to native SADP eligibility and filed
rating (including service areas, ZIP restrictions, business rules and date intervals).
Rated searches map native gross cents into the `premium` field. Native
unknown/missing/ambiguous values stay null with the corresponding `premium_*` gap.
Only native `unsupported_rating_method` adds
`dental_premiums_unsupported_by_native_rating` and a plan-specific
`dental_premiums_unsupported_by_native_rating:<id>`; priced plans do not get that
plan-specific gap. Unmapped benefits stay null with `dental_benefits_unmapped`.
Detail has no household, so its null premium is labelled `dental_premium_requires_household`.
No loaded SADPs or an unsupported market returns empty with a gap. Vision has no
public source and never returns a plan.

Individual SADP filtering follows native eligibility only. Search adds no TX, adult,
date or gender exclusion without public offering evidence. Small group remains
explicitly unsupported.

Refresh negative controls compile a temporary VT mapper that fills an invented
HIOS-shaped `plan.id`, and remove `premium_unknown` from a copied gaps header while
the native price is unknown. The same positive identity/evidence assertions must
reject both. Neither control edits source evidence or production code.

Additional negative controls compile a temporary credential-check mutant that
always returns true, inject duplicate results/drop provenance into response copies,
and inject an invented vision plan. Each fails the same contract used for valid
responses. A 52-record synthetic issuer feed checks deduplication across the
native 50-record page boundary.

## Explicit CSR display selection

Medical search bodies and medical detail query strings accept `csr_variant`
using the native aliases/suffixes (see `../../api/README.md`). A base ID defaults
to the standard on-exchange `-01`; a suffixed HIOS ID selects its own variant.
Conflicting selectors return 400. Missing selected evidence leaves existing wire
fields null and adds `variant_cost_sharing_unknown`; defaulted selection adds
`standard_on_exchange_variant_defaulted`. There is no income-to-CSR mapping.
Existing deductible/MOOP text fields label network tiers, accumulator scopes and any integrated
medical/drug accumulator. Service fields retain publisher conditions. The facade adds no new
response fields. Gross premiums continue to use base-plan rates.
