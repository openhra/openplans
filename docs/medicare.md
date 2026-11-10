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
read that agreement can set `OPENPLANS_MEDICARE_PART_D=on`. Responses then carry the release's
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
