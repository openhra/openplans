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

```sh
worker ingest medicare part-d import --kind quarterly --tables dispensing_fee
```

`dispensing_fee` reads the pharmacy networks file again but keeps no pharmacy rows. It stores one
range per plan, channel, in-area flag, fee type and days supply. The fee types are brand, generic
and selected drug. Each range has the lowest and highest fee, the number of pharmacies that list a
fee, the number that show `.` and the highest floor price. A `.` counts as missing, never as zero.
Each range names the network file members it came from and the SHA-256 of each member. The data
files call the selected-drug fee `SELECTED_DISPENSING_FEE_30`, `_60` and `_90`, but the record
layout says `SELECTED_DRUG_DISPENSING_FEE_30`. The importer accepts either spelling. On a release
that is already loaded, importing a large table adds it to that release and leaves the core tables
alone. Unit costs live in `partd_plan_unit_cost` (migration 1004). Pricing imported before that
migration reads as not loaded, so import it again with `--tables pricing`. A table can also be
written in short batches with `stageLargeTable` (`src/ingest/medicare/spuf.ts`), which leaves it
off the release's `tables` list until the caller adds it. While such staged rows exist, the
one-transaction import refuses to add that table; finish the staged load instead. Drug-cost estimates read unit costs and fee ranges only with
`price_basis: "cms_plan_average"`, behind its own switch. See
[Plan-average prices](#plan-average-prices).

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
- Every figure is `{status, cents, reason, evidence_refs}`. `status` is `value`, `bounded` or
  `unknown`. A `bounded` figure has `cents: null` and adds `minimum_cents` and `maximum_cents`.
  The refs are ids in one top-level `evidence` list, which holds each source row, PBP row, fee
  range, rule citation and request field once. Each fill's `status` follows its patient pay:
  `estimated` for a value, `bounded` or `unknown`. The estimate's own `status` is `estimated`
  when every fill's patient pay is a value, `partial` when some are and `unknown` when none is.
- The plan file has one row per county, so a plan can file the same deductible and SNP code on
  ninety rows or more. When every county row holds the same raw value in each cited field, the
  answer lists them as one `source_rows` item. That item gives the snapshot, the table, the
  fields, every row number in `source_rows` and the shared cells in `values`. A figure that rests
  on those rows cites the group's id. If any row differs, each row is listed on its own.
- The service checks each answer before it leaves. Every value cites evidence, every ref
  resolves and every unknown has a reason. A group lists its rows in ascending order and has a
  value for each field. No answer says "not covered". Every row and rule the engine used must be
  in the list, on its own or inside a group, or the service refuses to answer. The MCP tool also
  checks that its data matches the service answer byte for byte and that it can resolve every
  cited snapshot and document.
- `bindable_quote` is always `false`. Premiums come back as `not_evaluated`.

### What it does not do yet

The estimator is evidence-only today. Four gaps keep almost every amount unknown:

- **No prices by default.** With `price_basis: "none"`, the default, no price is read. Without a
  price, the engine cannot split a claim between deductible, initial coverage and catastrophic
  phases, so fill amounts are `unknown` with `pricing_not_loaded`. The exception is a fill that
  starts at or past the out-of-pocket threshold, covered below. `cms_plan_average` reads the
  plan's average prices, but only while its switch is on and the release has them loaded. See
  [Plan-average prices](#plan-average-prices).
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

### Plan-average prices

`price_basis: "cms_plan_average"` prices each fill from the quarterly Part D pricing file and the
dispensing-fee ranges described above. The unit cost is the plan's average cost per unit of the
proxy NDC at in-area retail pharmacies, as of the release date and before manufacturer
discounts. It is not the price at any one pharmacy. Every answer on this basis adds that caveat
to its `assumptions`.

How the estimator reads a fill's price:

- The pricing rows come from the same release as the benefit rows. The estimator never borrows
  another year, release, plan, segment or NDC.
- The proxy NDC is the fill's own, or the only one the plan lists for the RxCUI. A drug listed
  under several NDCs with none chosen gets no price.
- The days supply must be 30, 60 or 90 and must match a pricing row exactly. A 30-day unit cost is
  never reused for a 90-day fill, and nothing is pro-rated.
- The fill's `unit` must be `ndc_unit`, meaning units of the proxy NDC itself. No public file
  names that unit, so the answer labels the quantity `caller_asserted_ndc_units`.
- The unit cost covers retail pharmacies only. Mail-order fills get no price.
- The fee comes from the plan's in-area pharmacies for the requested channel and days supply. For
  a selected drug it is the selected-drug fee, or the brand fee where none is filed. Otherwise the
  files do not say whether the brand or the generic fee applies, so both count.

The files do not say whether the unit cost already includes a dispensing fee, and the fee differs
from pharmacy to pharmacy. So the estimator prices each fill three ways: the unit cost times the quantity,
that plus the lowest fee, and that plus the highest fee. The fill's `price` block shows all three
as `unit_cost_total`, `total_lowest_fee` and `total_highest_fee`, with `gross` beside them. Each
cites the pricing row (snapshot, table and row number) and the fee range, which names its
snapshot, source files, the SHA-256 of each file and its first row.

A selected drug is priced from its maximum fair price instead of the plan-average unit cost. The
negotiated price of a selected drug can be no more than the maximum fair price plus the dispensing
fee, and CMS prices its worked example at exactly that amount. The estimator takes the price per
unit in effect on the fill date from the CMS Selected Drug List and Maximum Fair Price file. `data/medicare-part-d/drug-lists.json` pins that file with the other CMS drug lists. The price is
multiplied by the quantity and rounded to the cent, then priced two ways: plus the lowest and plus
the highest selected-drug fee. The maximum fair price leaves out the fee, so there is no reading
without one, and a floor price cannot raise the amount. The `price` block reports
`ingredient: "maximum_fair_price"`, the per-unit price with its effective dates, and
`maximum_fair_price_total`. Its evidence cites the row of the CMS file. `unit_cost_total` stays as information.
`total_lowest_fee` and `total_highest_fee` are the maximum fair price plus each fee. A selected
drug with no price in effect on the fill date has an unknown gross cost
(`maximum_fair_price_not_in_effect`). The plan average is never used in its place. When the
formulary flag and the CMS list disagree, the program stays open and both ways count
(`ingredient: "open"`). The gross cost is then a value only when both give the same cents, and
otherwise unknown with `maximum_fair_price_may_apply`. Any other drug reports
`maximum_fair_price_total` as unknown with `drug_not_selected`.

When all three agree to the cent, a figure is a `value`. When they differ, the gross cost is
`bounded`. It lies somewhere from the unit cost plus the lowest fee to the unit cost plus the
highest fee, both ends included. The answer does not know where in that range a real claim falls
and never picks one number inside it. `unit_cost_total` stays in the answer as information; it is
not an end of the range. Patient pay and the TrOOP increment are also bounded when only this
fill's fee moves them and they rise with the price. A copay below every reading settles as one
value.

What stays unknown on this basis, each with its reason:

- Any figure the fee moves that is not a simple range: the split between plan, subsidy and
  discount, the accumulators, and every later fill (`dispensing_fee_unknown`). A total that a
  bounded amount feeds stays unknown.
- A fill whose fee is missing (`.`) at every pharmacy (`dispensing_fee_unknown`), or whose floor
  price could exceed the price (`floor_price_may_apply`). A missing fee is never $0.
- Mail-order fills (`unit_cost_retail_only`), other days supplies
  (`price_days_supply_not_published`), other units (`quantity_unit_not_ndc_unit`), a missing
  pricing row (`unit_cost_not_published`) and a zero or blank unit cost (`unit_cost_unreadable`).
- Every year whose loaded release has no pricing file. The 2027 monthly files carry none, so
  2027 answers `pricing_not_published_for_year` until CMS posts a quarterly file for that year.
- Prices at a named pharmacy, and anything listed under "What it does not do yet".

### Switches and access

Two operator switches must both be `on`, and a third adds plan-average prices:

- `OPENPLANS_MEDICARE_PART_D=on` serves Part D data. Without it the estimate answers
  `{status: "unknown", reason: "pending_terms_review"}`.
- `OPENPLANS_MEDICARE_DRUG_COST=on` turns the estimator on. Without it the answer is
  `{status: "unknown", reason: "estimator_disabled"}` and no plan data is read.
- `OPENPLANS_MEDICARE_DRUG_COST_PRICES=on` accepts `price_basis: "cms_plan_average"`. It counts
  only while the two switches above are on. With it off that basis answers `unsupported` with
  `price_basis_not_supported`. With it on, a release without its pricing rows or fee ranges
  answers `unknown` with `pricing_not_loaded` or `dispensing_fees_not_loaded`, and no fill is
  calculated. Load both with `--tables pricing,dispensing_fee` first.

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
Its `pricing` entry says whether the year's release has prices and fee ranges loaded and whether
the price switch is `on` or `off`. `price_basis` lists `cms_plan_average` only when both hold.

### Nothing is stored or logged

Estimate answers carry `Cache-Control: no-store`. The route and the tool mark their request so no
response cache keeps them, and the tool reports a cache bypass. The service does not log the
schedule, and the MCP request log records only the tool name, status, timing, size and cache
result. Nothing from a request is written to the database.

### Unknown reasons

A closed answer has no figures and one `reason`:

| Reason                           | Meaning                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `pending_terms_review`           | `OPENPLANS_MEDICARE_PART_D` is off.                                                    |
| `estimator_disabled`             | `OPENPLANS_MEDICARE_DRUG_COST` is off.                                                 |
| `not_loaded`                     | No active Part D release with every core table is loaded for the year.                 |
| `plan_not_in_part_d_files`       | The plan is in the Medicare catalog but not in the Part D files.                       |
| `plan_suppressed_by_cms`         | CMS suppressed the plan's Part D data.                                                 |
| `several_formularies_listed`     | The plan's rows name more than one formulary.                                          |
| `rules_not_loaded`               | The year has no reviewed CMS rules. Only 2026 and 2027 do.                             |
| `too_many_unsettled_facts`       | The open facts across the schedule give more than 1,024 readings. Send fewer products. |
| `scenario_not_supported`         | The scenario is not `non_lis_no_other_payer` (status `unsupported`).                   |
| `price_basis_not_supported`      | `cms_plan_average` while `OPENPLANS_MEDICARE_DRUG_COST_PRICES` is off (`unsupported`). |
| `pricing_not_loaded`             | `cms_plan_average`, but the release was imported without its pricing table.            |
| `dispensing_fees_not_loaded`     | `cms_plan_average`, but the release was imported without its fee ranges.               |
| `pricing_not_published_for_year` | `cms_plan_average`, but the year's loaded release has no pricing file.                 |

An unknown figure names its reason. When several readings disagree, their reasons are joined with
`+`, for example `insulin_cost_row_missing+pricing_not_loaded`.

| Reason                                                                                                             | Meaning                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing_not_loaded`                                                                                               | The fill has no price, so its amount cannot be split between phases.                                                                                                 |
| `dispensing_fee_unknown`                                                                                           | The amount depends on a dispensing fee the files do not settle, no pharmacy lists a readable fee, or the plan has no in-area pharmacy for the channel and supply.    |
| `floor_price_may_apply`                                                                                            | A pharmacy's floor price could exceed the plan-average price, and the files do not say how it applies.                                                               |
| `maximum_fair_price_not_in_effect`, `maximum_fair_price_not_pinned`                                                | A selected drug has no maximum fair price in effect on the fill date, or none is pinned for the year. The plan average is never used instead.                        |
| `maximum_fair_price_rows_disagree`                                                                                 | Two rows of the CMS file in effect on the fill date give different prices for the NDC.                                                                               |
| `maximum_fair_price_may_apply`                                                                                     | Whether the drug is selected is open, and the maximum fair price and the plan average give different amounts.                                                        |
| `drug_not_selected`                                                                                                | Only on `maximum_fair_price_total`: the drug is not a selected drug, so it has no maximum fair price.                                                                |
| `cost_sharing_not_monotonic_in_price`                                                                              | Patient pay does not rise with the price, so the lowest and highest fee do not bound it.                                                                             |
| `unit_cost_retail_only`, `unit_cost_not_published`, `unit_cost_unreadable`                                         | A mail-order fill, no pricing row for the plan, NDC and days supply, or a zero or blank unit cost.                                                                   |
| `price_days_supply_not_published`, `quantity_unit_not_ndc_unit`, `proxy_ndc_ambiguous`                             | The days supply is not 30, 60 or 90, the unit is not `ndc_unit`, or several proxy NDCs are listed and none was chosen.                                               |
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

The drug-cost estimator has three checks.

- `tests/ingest/medicare/medicare-cost-oracle.test.ts` runs the CMS worked examples in
  `tests/fixtures/medicare-costs/oracles.json` end to end. Each example's plan is a synthetic edit
  of the fixture Part D and PBP files that files the benefit the example describes. The test
  imports those files, posts the schedule to the HTTP route with a Bearer token and calls the MCP
  tool. Every expected figure must match to the cent on both, and the two answers must be equal.
  The plan deductible must name every county row of the example's plan, as one group when the
  plan has more than one row. No price source is loaded, so the test supplies each example's CMS price and the insulin facts
  the example states. Everything else comes from the imported rows. Five planted mutants must each
  break an example: the price dropped, 2027 rules used for 2026, an enhanced alternative filing
  read as basic, the selected-drug flag ignored and the plan deductible ignored.
  The same test runs every example again with `price_basis: "cms_plan_average"`, from synthetic
  pricing and fee-range rows. The example's ingredient cost comes from the unit cost, or for a
  selected drug from its maximum fair price in the pinned CMS file. Both transports must match the example and cite the
  pricing row and fee range. Five more planted mutants must each break an example: the fee
  dropped, the brand fee charged for a selected drug, the quantity read as one unit, the plan
  average used for a selected drug and a maximum fair price used for a drug that is not selected.
- `scripts/realdata.sh` runs `scripts/oracle/medicare-cost.mjs` for each year with cached Part D,
  Landscape and PBP archives. It imports them into a throwaway database, turns both switches on and
  asks the HTTP route, for every Part D plan, about the lowest RxCUI on each formulary tier and the
  lowest selected drug. The plan gets one request for the whole schedule. Each drug also gets a
  request of its own, once from a new calendar year and once from an opening TrOOP at the
  out-of-pocket threshold. Every answer must pass the provenance check and cite only listed
  documents. Without a price, an amount may be calculated only for a fill that starts in the
  catastrophic phase, where it is $0. About one plan in a hundred also goes through the MCP tool,
  whose answer must equal the HTTP body. Every answer large enough to come near the tool's output
  limit also goes through the tool. The tool sends each answer twice, as data and as text, and refuses one over
  its 128 KiB limit with `RESULT_TOO_LARGE` rather than cut it. The check counts those refusals
  and fails on any other error. Nine planted mutants on real answers must each be caught. Three of
  them target grouped county rows: a row dropped from a group, a group without its shared values
  and an MCP answer that no longer matches the HTTP body. The counts of calculated and unknown results, by reason, go to
  `reports/medicare-cost-oracle-<year>.json` under the data directory.
- `scripts/realdata.sh` also runs `scripts/oracle/medicare-part-d-price.mjs` for 2026 when
  `OPENPLANS_PRICE_CHECK_DATABASE_URL` names a database that holds the year's quarterly release
  with its pricing and dispensing-fee tables. It prices a fixed sample of 200 plans
  (`scripts/oracle/medicare-part-d-price-cases.json`) through the estimate service and compares
  each answer with a separate Python reading of the cached archive. A bounded answer matches only
  when its ends equal that reading's lowest-fee and highest-fee amounts. Without the database or
  the archive the step prints `SKIP`. The report goes to
  `reports/medicare-part-d-price-<year>.json` under the data directory.
