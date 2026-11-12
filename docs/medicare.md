# Medicare plan data

OpenPlans serves Medicare Advantage plans with and without drug coverage, stand-alone Part D
plans, Special Needs Plans and Cost plans. Plan and coverage values come from files that the Centers
for Medicare & Medicaid Services publishes on www.cms.gov, served as filed and tagged with its release.
Medicare premiums are not age-rated and the routes take no personal data, so they need no token.

## Sources

| Family         | CMS file                                                        | What OpenPlans reads from it                                                                                                                |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `landscape`    | MA and PDP Landscape, for example `cy2026-landscape-202609.zip` | Plans per state and county, premiums, Part D deductible, MOOP, summary and overall stars, SNP attributes, regions                           |
| `pbp`          | Plan Benefit Package Benefits, `pbp-benefits-2026.zip`          | Benefits as filed in Sections A and D and the core benefit tables, websites, phone numbers, plan service areas with the partial-county flag |
| `stars`        | Part C and D Star Ratings data tables                           | Contract summary and overall ratings                                                                                                        |
| `crosswalk`    | Part C&D Plan Crosswalk                                         | Which prior-year plan became which current-year plan                                                                                        |
| `service_area` | Monthly MA and PDP contract service area by state and county    | SSA county codes and their Census county FIPS codes                                                                                         |

The import skips employer group plans, meaning plan IDs 800 and above or rows flagged EGHP. National
PACE, demonstrations and Medigap are not loaded either.

## Collecting and importing

```sh
# Network step. One reviewed admission session for www.cms.gov, see src/ingest/medicare/README.md.
OPENPLANS_ACCESS_MANIFEST=/abs/path/manifest.json worker ingest medicare acquire --year 2026 \
  --service-area-month 2026-10
# Offline step, from the cache. Service areas load first, then the year's families.
worker ingest medicare import --year 2026
```

Each archive loads in one transaction. A layout change stops the import. These count as layout
changes: a renamed Landscape column, a PBP column its SAS layout does not declare, text in a
numeric PBP field, and a repeated column that carries two different values. The worker then marks
the snapshot quarantined and the previous release keeps serving.

## Routes

`GET /v1/medicare/plans?county_fips=48201&year=2026&type=ma_pd` lists the plans filed for a county.
A `zip` also works when it lies in one county. A ZIP that spans several counties returns
`status: "multiple_counties"` and lists them. CMS files stand-alone PDPs for "All Counties" of a
state, so they appear in every county of that state.

Each plan carries these fields.

- `premiums_monthly`, `part_d.deductible`, `part_d.oop_threshold` and `moop_in_network` are cells
  with a `status` of `value`, `not_applicable` or `unknown`, plus `cents`. CMS publishes some Part D
  basic premiums as negative amounts and OpenPlans serves them as negative.
- `part_d.low_income_premium_subsidy` depends on the PDP region, so it belongs to the county row.
- `stars` is `rated` with a half-star value, or `too_new`, `not_enough_data` or `not_applicable`.
- `plan_benefit_package` holds deductibles, combined and out-of-network MOOP, the Part B premium
  reduction, websites and phone numbers from PBP Sections A and D.
- `availability.partial_county` comes from the PBP service area. CMS does not publish which ZIPs a
  partial county covers.
- `provider_network` is always `unknown` with reason `published_only_by_each_organization`. Each
  MA organization runs its own provider directory and CMS has no central file.

`/plans/{plan_key}` adds the contract's Star Ratings and the states the plan is filed in.
`/benefits` returns every filled PBP field of the core tables with its dictionary title and code
label. A missing field means the filing left it blank. OpenPlans never reads that as "not covered".
`/service-area` lists the Landscape counties and the PBP areas with SSA codes and FIPS codes.
`/lineage` reads the plan crosswalk. CMS publishes it per contract and plan, so every segment of a
plan shares one lineage.

A year with no loaded release answers `status: "unknown"` and `reason: "catalog_not_loaded"`. It
never returns an empty list as if no plans existed. `GET /v1/medicare/data-availability` lists the
loaded releases, their as-of labels and their row counts.

## County codes

Landscape names counties. PBP identifies them by 5-digit SSA code. The newest PDP contract
service-area file maps SSA codes to FIPS for every county, and the newest MA file adds the codes
the PDP file lacks. The MA file also lists retired FIPS codes next to current ones, for example
Miami-Dade 12025 beside 12086. OpenPlans reports those extras and does not use them. When the two
files map an SSA code to disjoint FIPS sets, the code stays unmapped and the service area shows
`county_code_unmapped`. One SSA unit can cover several FIPS counties, as in the US Virgin Islands,
and one county can have several SSA codes, as Los Angeles does.

## Part D formulary, pharmacy network and costs

CMS publishes Part D formularies, pharmacy networks and drug pricing on data.cms.gov under the
"Agreement for Use of Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information
Public Use Files". Serving them is off by default. Until an operator turns it on, every route
reports `part_d_drug_data: {status: "unknown", reason: "pending_terms_review"}`. An operator who has
read that agreement can set `OPENPLANS_MEDICARE_PART_D=on`. This is a native API
environment option. Compose does not forward it by default; add it to the API
service in a local override and recreate the service. See the
[configuration reference](configuration.md). Responses then carry the release's
as-of date and a note that unit costs are plan averages, not the price at any one pharmacy.

```sh
worker ingest medicare part-d acquire --url https://data.cms.gov/sites/default/files/.../SPUF_2026_20261007.zip
worker ingest medicare part-d import --kind quarterly
worker ingest medicare part-d import --kind quarterly --tables pharmacy_network,pricing
```

The default import loads plan information, formularies, excluded and indication-based drugs,
beneficiary and insulin cost sharing and the county locator. Pharmacy networks and pricing are
large. The Q3 2026 quarterly file holds about 300 million pharmacy network rows, so load those two
tables only on a Postgres instance sized for them. The importer stores each distinct plan network
once and points plans at it.

Two routes read these tables when serving is on.

- `GET /v1/medicare/plans/{plan_key}/drugs?year=2026&rxcui=860975` returns the formulary packages
  for the RxCUI with tier, prior authorization, step therapy and quantity limits, the tier's cost
  sharing by coverage phase and pharmacy channel, and the plan's average unit cost per proxy NDC.
  An RxCUI absent from the formulary file returns `not_listed`, never "not covered". Tier names
  such as "preferred brand" are not in the public files and stay `unknown`.
  The nullable `name` comes from an exact join of the formulary row's RxCUI to the newest active
  loaded NLM RxNorm release. `name_snapshot_id` identifies that release and `name_tty` gives the
  published term type. Selection prefers SCD or SBD terms, then sorts by term type, name,
  suppression code and source record. Synonyms stay in RxNorm and do not multiply formulary rows.
  No loaded RxNorm release gives `name_reason: "rxnorm_not_loaded"`;
  a loaded release without that RxCUI gives `rxcui_not_in_loaded_rxnorm`. An RxCUI absent from the
  plan's formulary has a null name and snapshot with `rxcui_not_in_plan_formulary`. A null name also
  has a null `name_tty`. When a name is selected, `name_reason` is null. No name is inferred from
  an NDC, another drug or a brand link.
  These fields are present on `listed` and `not_listed` responses. Responses with `status: "unknown"`,
  including the default flag-off response, keep their existing shape.
- `GET /v1/medicare/plans/{plan_key}/pharmacies?year=2026&zip=77002` lists the plan's network
  pharmacies in a ZIP. The Part D file gives only the NPI and ZIP, so names, addresses and phones
  come from NPPES when that is loaded.

CMS suppresses some plans' pharmacy data. Those plans answer `plan_suppressed_by_cms`.

## Part D drug-cost estimates

The estimator applies the CMS Part D rules for contract years 2026 and 2027 to one plan and a fill
schedule supplied by the caller. It reads the plan's filed benefit from the loaded Part D and PBP
files and returns each figure with the rows and rule documents it rests on. It runs only on
evidence. When the evidence leaves a figure open, that figure is `unknown` with a reason, never a
guess and never zero.

### What it does

- `POST /v1/medicare/plans/{plan_key}/drug-cost-estimates?year=2026` and the MCP tool
  `estimate_medicare_drug_costs` call the same service and return the same answer.
- The request names the scenario (`non_lis_no_other_payer`, the only one supported), a pharmacy
  channel, an opening state and up to 50 fills of at most 10 products. Each fill has an id, a date,
  an exact RxCUI, an optional proxy NDC, a quantity with its unit and the days supply. The opening
  state is either `new_calendar_year` or `provided`, with the gross covered drug cost, TrOOP and
  plan deductible met so far, which the answer labels as the caller's assertion.
- The plan's benefit type (defined standard, actuarially equivalent, basic alternative or enhanced
  alternative) comes from its PBP filing. Its deductible, tier cost sharing, insulin rows and
  selected-drug flags come from the Part D files. The standard deductible and the out-of-pocket
  threshold come from the CMS rate announcement. The request has no field for a benefit type or drug class.
  Sending one gives `400 UNSUPPORTED_FIELD`.
- A drug is a selected drug when the formulary flag and the CMS selected-drug NDC list for the
  year agree. If they disagree, the program stays unknown.
- For each fill the answer gives the listing and its conditions, the filed cost sharing for the
  tier, supply and channel, the phase at the start and end of the fill, and these figures: patient
  pay, TrOOP increment, gross cost below and above the threshold, selected-drug subsidy,
  manufacturer discount, and plan paid inside and outside the standard benefit. It also gives the
  accumulators before and after the fill. Totals add a labelled subtotal of the fills whose amount
  is known. That subtotal is not a lower bound for the year.
- Every figure is `{status, cents, reason, evidence_refs}`. The refs point into one `evidence`
  list of source rows, PBP rows, rule citations and request fields. Before an answer leaves the
  service, a check confirms that every value cites evidence, every unknown has a reason and no
  answer says "not covered". The MCP tool also checks that every cited snapshot and document can
  be resolved.
- `bindable_quote` is always `false`. Premiums come back as `not_evaluated`.

### What it does not do yet

The estimator is evidence-only today. Four gaps keep almost every amount unknown:

- **No prices.** No drug price source is loaded for estimates, so `price_basis` accepts only
  `none`. Without a price, the engine cannot split a claim between deductible, initial coverage
  and catastrophic phases, so fill amounts are `unknown` with `pricing_not_loaded`. The exception
  is a fill that starts at or past the out-of-pocket threshold, covered below.
  `cms_plan_average` answers `unsupported` with `price_basis_not_supported`.
- **Insulin and vaccine status.** No admitted file lists covered insulin products or ACIP adult
  vaccines by drug, so both stay open (`insulin_product_list_not_cached`,
  `acip_vaccine_list_not_cached`). A plan's insulin row for a tier never makes a drug on that tier
  insulin.
- **Applicable-drug status.** Whether a drug that is not selected falls under the manufacturer
  discount program stays open (`applicable_drug_list_not_cached`).
- **RxNorm not loaded.** The estimate matches drugs only by exact RxCUI and proxy NDC as filed.
  It returns no drug names, does no name or ingredient search and makes no substitutions.

Each unsettled fact is tried both ways. A figure is a value only when every reading gives the same
amount. A reading where a drug would be both covered insulin and an ACIP vaccine is not a valid
reading and is skipped. If the files settle a drug as both, its fills stay unknown with
`classification_conflict`.

A fill that starts once TrOOP has reached the out-of-pocket threshold is in the catastrophic
phase. The enrollee pays nothing there, whatever the price, and an ACIP vaccine costs the enrollee
nothing in any phase. So patient pay and the TrOOP increment are $0 in every valid reading. The
answer reports both as values and cites the year's catastrophic rule. The gross cost, the subsidy,
the manufacturer discount and the plan's payments still depend on the price. They stay unknown
with `pricing_not_loaded`, or with `vaccine_payer_split_not_modelled` for the vaccine reading. Before the threshold, every fill
amount on a real plan still needs a price. The Checks section says how that is counted.

It also does not cover the low-income subsidy, other payers, premiums, IRMAA, late enrollment
penalties, drugs outside Part D, pharmacy network membership (the channel is the caller's
assumption, `channel_verification: "unknown"`) or Medicare Prescription Payment Plan billing.

### Switches and access

Two operator switches must both be `on`:

- `OPENPLANS_MEDICARE_PART_D=on` serves Part D data. Without it the estimate answers
  `{status: "unknown", reason: "pending_terms_review"}`.
- `OPENPLANS_MEDICARE_DRUG_COST=on` turns the estimator on. Without it the answer is
  `{status: "unknown", reason: "estimator_disabled"}` and no plan data is read.

A fill schedule is personal, so access needs a Bearer token on both transports. Public household
access never opens it.

- HTTP: `Authorization: Bearer <OPENPLANS_API_TOKEN>`. With no API token configured the route
  answers `503 AUTH_NOT_CONFIGURED`. A missing or wrong token gets `401`.
- MCP over HTTP: `Authorization: Bearer <OPENPLANS_MCP_TOKEN>`. The tool is listed only when both
  switches are on and the caller holds that token. With no MCP token configured a call gets
  `503 AUTH_NOT_CONFIGURED`. A missing or wrong token gets `401` with a Bearer challenge.
- MCP over stdio follows the local personalized-tool rule: `OPENPLANS_MCP_ALLOW_PERSONALIZED=1`
  grants the tool and `0` withholds it. Left unset, it is granted only while household tools are
  open, meaning no MCP token is set and `OPENPLANS_PUBLIC_HOUSEHOLD` is on.

`GET /v1/medicare/data-availability` adds a `part_d_drug_cost_estimates` section per year only
while the estimator switch is on. It shows which inputs are available and which stay unknown.

### Nothing is stored or logged

Estimate answers carry `Cache-Control: no-store`. The route and the tool mark their request so no
response cache keeps them, and the tool reports a cache bypass. The service does not log the
schedule, and the MCP request log records only the tool name, status, timing, size and cache
result. Nothing from a request is written to the database.

### Unknown reasons

A closed answer has no figures and one `reason`:

| Reason                       | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `pending_terms_review`       | `OPENPLANS_MEDICARE_PART_D` is off.                                                    |
| `estimator_disabled`         | `OPENPLANS_MEDICARE_DRUG_COST` is off.                                                 |
| `not_loaded`                 | No active Part D release with every core table is loaded for the year.                 |
| `plan_not_in_part_d_files`   | The plan is in the Medicare catalog but not in the Part D files.                       |
| `plan_suppressed_by_cms`     | CMS suppressed the plan's Part D data.                                                 |
| `several_formularies_listed` | The plan's rows name more than one formulary.                                          |
| `rules_not_loaded`           | The year has no reviewed CMS rules. Only 2026 and 2027 do.                             |
| `too_many_unsettled_facts`   | The open facts across the schedule give more than 1,024 readings. Send fewer products. |
| `scenario_not_supported`     | The scenario is not `non_lis_no_other_payer` (status `unsupported`).                   |
| `price_basis_not_supported`  | `price_basis` is not `none` (status `unsupported`).                                    |

An unknown figure names its reason. When several readings disagree, their reasons are joined with
`+`, for example `insulin_cost_row_missing+pricing_not_loaded`.

| Reason                                                                                                             | Meaning                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing_not_loaded`                                                                                               | The fill has no price, so its amount cannot be split between phases.                                                                                                 |
| `drug_program_unknown`                                                                                             | Whether the drug is a selected drug, an applicable drug or neither is open and changes the amount.                                                                   |
| `insulin_classification_unknown`                                                                                   | Whether the drug is covered insulin is open and changes the amount.                                                                                                  |
| `vaccine_classification_unknown`                                                                                   | Whether the drug is an ACIP adult vaccine is open and changes the amount.                                                                                            |
| `classification_conflict`                                                                                          | The files settle the drug as both covered insulin and an ACIP vaccine. While either fact is open, that reading is skipped.                                           |
| `benefit_type_unknown`                                                                                             | The plan's PBP filing gives no benefit type and the amount depends on it.                                                                                            |
| `channel_not_offered`                                                                                              | The plan does not offer the chosen channel for this tier and supply.                                                                                                 |
| `not_listed`, `supplemental_listing_only`                                                                          | The RxCUI is not on the plan's formulary, or only on its supplemental excluded-drug list. Neither means the drug is not covered.                                     |
| `ambiguous_drug_product`, `proxy_ndc_not_listed`                                                                   | Several proxy NDCs match, or the given proxy NDC is not listed. Send one listed proxy NDC.                                                                           |
| `supply_bucket_unproved`                                                                                           | The days supply does not map to a filed 30, 60 or 90-day bucket.                                                                                                     |
| `earlier_fill_unknown`                                                                                             | An earlier fill left the accumulators unknown, so later amounts depend on it.                                                                                        |
| `plan_deductible_unknown`, `deductible_applies_unknown`                                                            | The plan deductible or the tier's deductible flag is unreadable.                                                                                                     |
| `bound_class_unrecognised`, `lis_range_not_no_subsidy_charge`                                                      | The tier's minimum and maximum cost sharing follow no reviewed rule, or they are the low-income subsidy range in a phase where the no-subsidy charge is not settled. |
| `insulin_cost_row_missing`, `insulin_cost_not_reported`, `insulin_cost_unknown`, `insulin_supply_ceiling_unproved` | The plan's insulin cost sharing for the tier is missing or unreadable, or the supply is not the 30-day bucket the insulin ceiling is read for.                       |

The answer's `gaps` list also names the missing source behind an open fact:
`insulin_product_list_not_cached`, `acip_vaccine_list_not_cached`,
`applicable_drug_list_not_cached`, `selected_drug_flag_disagrees_with_cms_list`,
`selected_drug_flag_unknown` and `benefit_type_not_reported`.

## Checks

`scripts/realdata.sh` runs `scripts/oracle/medicare.mjs` for each year. The check imports the
cached archives into a throwaway database. It then compares every county listing and every plan's
service area with a separate Python reading of the raw files. Five planted mutants must each fail
the comparison: a premium one cent off, a dropped county, two swapped SSA codes, a changed star
value, and a negative premium read as positive.

It also runs `scripts/oracle/medicare-part-d.mjs` for each year with a cached Part D archive. The
check loads the default tables into a throwaway database and compares them with a separate Python
reading of the same archive. It compares every row of every table, each plan's formulary and
suppression flag, three drug lookups per formulary and one RxCUI each formulary does not list. It
also confirms that lookups answer `pending_terms_review` while serving is off. Seven planted mutants
must each fail: a tier one higher, a flipped prior authorization flag, an unlisted drug read as
listed, a changed cost-sharing amount, a flipped suppression flag, a dropped county and a plan
pointed at another formulary. The check does not load pharmacy networks or pricing.
`tests/ingest/medicare/part-d-check.test.ts` runs the same comparison on the fixture cut. It also
imports six archives with one value changed in each and expects the comparison to report every one.
The disposable database has no RxNorm release, so the check also requires null drug names and
the corresponding reasons. The Part D archive contains no names to check. Synthetic HTTP fixtures
in `tests/api/medicare-drug-names.test.ts` check exact name matches, missing terminology, inactive
releases, synonym selection and unchanged flag-off responses. Moving a loaded name to another RxCUI
must fail the expected-name assertion.

The drug-cost estimator has two checks.

- `tests/ingest/medicare/medicare-cost-oracle.test.ts` runs the CMS worked examples in
  `tests/fixtures/medicare-costs/oracles.json` end to end. Each example's plan is a synthetic edit
  of the fixture Part D and PBP files that files the benefit the example describes. The test
  imports those files, posts the schedule to the HTTP route with a Bearer token and calls the MCP
  tool. Every expected figure must match to the cent on both, and the two answers must be equal.
  No price source is loaded, so the test supplies each example's CMS price and the insulin facts
  the example states. Everything else comes from the imported rows. Five planted mutants must each
  break an example: the price dropped, 2027 rules used for 2026, an enhanced alternative filing
  read as basic, the selected-drug flag ignored and the plan deductible ignored.
- `scripts/realdata.sh` runs `scripts/oracle/medicare-cost.mjs` for each year with cached Part D,
  Landscape and PBP archives. It imports them into a throwaway database, turns both switches on and
  asks the HTTP route, for every Part D plan, about the lowest RxCUI on each formulary tier and the
  lowest selected drug. The plan gets one request for the whole schedule. Each drug also gets a
  request of its own, once from a new calendar year and once from an opening TrOOP at the
  out-of-pocket threshold. Every answer must pass the provenance check and cite only listed
  documents. Without a price, an amount may be calculated only for a fill that starts in the
  catastrophic phase, where it is $0. About one plan in a hundred also goes through the MCP tool,
  whose answer must equal the HTTP body. The tool sends each answer twice, as data and as text, and refuses one over its 128 KiB output limit with `RESULT_TOO_LARGE` rather than cut it.
  An answer for a single fill can reach that limit when the plan's evidence list is long. The
  check counts those refusals and fails on any other error. Six planted mutants on a real answer
  must each be caught. The counts of calculated and unknown results, by reason, go to
  `reports/medicare-cost-oracle-<year>.json` under the data directory.
