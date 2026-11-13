# ICHRA affordability

`POST /v1/ichra/affordability` estimates whether an individual coverage HRA (ICHRA) is
affordable for one employee in the first month of the plan year. It answers the IRS premium tax
credit rule and, on request, the employer safe harbors. Figures come from public filed rates in
the CMS Exchange public use files or New York DFS publications. This is an estimate, not tax or legal advice, and never a
bindable quote: every answer carries `bindable_quote: false`.

## What it computes

1. **Lowest cost silver plan (LCSP)** for self-only coverage of the employee: the cheapest
   on-Exchange silver plan offered in the rating area, rated for one non-tobacco subscriber at
   the employee's age on the first day of the plan year
   ([26 CFR 1.36B-2(c)(5)(ii)(A), (iii)(A)](https://www.ecfr.gov/current/title-26/section-1.36B-2)).
   Plans that only sell child-only policies are left out. A plan that later closes stays the LCSP.
2. **Monthly HRA amount**: the self-only amount newly made available for the plan year, divided
   by the months the HRA is available. Carryovers are ignored ((c)(5)(iii)(B), (c)(5)(v)). If the
   HRA offers one amount for every coverage tier, send that amount ((c)(5)(ii)(B)).
3. **Required HRA contribution**: LCSP minus the monthly HRA amount, never below zero.
4. **Verdict**: affordable when the contribution does not exceed the threshold for the income
   measure. Equal is affordable. The comparison is exact, in integer cents and basis points.
   Display values are rounded half up and are never used in the comparison.

The required contribution percentage is the one for plan years beginning in the calendar year of
`plan_start`:

| Plan years beginning in | Percentage | Source                                                                          |
| ----------------------- | ---------- | ------------------------------------------------------------------------------- |
| 2026                    | 9.96%      | [IRS Rev. Proc. 2025-25, s.3.02](https://www.irs.gov/pub/irs-drop/rp-25-25.pdf) |
| 2027                    | 10.22%     | [IRS Rev. Proc. 2026-26, s.3.02](https://www.irs.gov/pub/irs-drop/rp-26-26.pdf) |

## Income measures

| `measure`            | Amount field    | Threshold                                                            | Purpose            | Rule                                                                                                            |
| -------------------- | --------------- | -------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `household`          | `annual_cents`  | household income x percentage / 12                                   | premium tax credit | 1.36B-2(c)(5)(i), final                                                                                         |
| `w2`                 | `annual_cents`  | Form W-2 box 1 wages x percentage / 12 for a full calendar plan year | employer           | [54.4980H-5(e)(2)(ii)](https://www.ecfr.gov/current/title-26/section-54.4980H-5), applied by proposed (f)(5)(i) |
| `rate_of_pay_hourly` | `hourly_cents`  | 130 hours x hourly rate x percentage                                 | employer           | (e)(2)(iii), applied by proposed (f)(5)(ii)                                                                     |
| `rate_of_pay_salary` | `monthly_cents` | monthly salary x percentage                                          | employer           | (e)(2)(iii), applied by proposed (f)(5)(ii)                                                                     |
| `fpl`                | none            | one-person poverty line of the state of employment x percentage / 12 | employer           | (e)(2)(iv), applied by proposed (f)(5)(iii)                                                                     |

Each verdict states its `purpose`. Employer verdicts answer section 4980H(b) only and never decide
whether the employee may claim the premium tax credit.

Three optional inputs refine the employer measures. A request without them gets the same answer
as before.

- **Partial-year offer, `w2`** ((e)(2)(ii)(B)): send `w2_months_offered` and `w2_months_employed`
  on the `w2` measure when the HRA is offered for part of a calendar plan year. A calendar month
  counts when the HRA is offered, or the employee is employed, on at least one day of it. The
  rule multiplies the wages by months offered / months employed and compares the contributions
  for the offered months with the percentage of that amount. With one monthly contribution for
  every offered month, the monthly threshold is wages x percentage / months employed. Example:
  wages of $30,000, 10 months employed, 6 offered, 9.96%: $30,000 x 6 / 10 = $18,000, 9.96% of
  that is $1,792.80 for six months, so $298.80 a month. `w2_months_offered` must equal
  `months_available`. If it differs, or the plan year is not a calendar year, the verdict is
  `unknown`.
- **Hourly rate that changes** ((e)(2)(iii)): `hourly_cents` is the rate on the first day of the
  plan year. Send `lowest_hourly_cents` when the rate was lower at any time in the month. The
  threshold uses the lower of the two, so a raise does not lift it.
- **Reduced salary** ((e)(2)(iii)): send `salary_reduced: true` when the monthly salary was
  reduced, including through fewer work hours. The rule says the safe harbor is not available
  then, so the verdict is `unknown` (`rate_of_pay_salary_reduced`).

The poverty-line measure uses the state of the worksite, or of the residence when no worksite is
sent, including the Alaska and Hawaii tables. It uses the newest HHS guideline in effect on the
plan start: the 2025 guideline ($15,650 for one person in the 48 states and DC, in effect from
2025-01-15, [90 FR 5917](https://www.govinfo.gov/content/pkg/FR-2025-01-17/html/2025-01377.htm))
for 2026 plans and the 2026 guideline ($15,960, in effect from 2026-01-13,
[91 FR 1797](https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm)) for 2027
plans. When a newer guideline may be in effect but is not yet on file, the guideline in effect six
months before the plan year is used, as the 2014 final rule allows
([79 FR 8544, preamble VIII.D](https://www.govinfo.gov/content/pkg/FR-2014-02-12/html/2014-03082.htm));
otherwise the verdict is `unknown` (`fpl_guideline_not_in_effect`).

## Employer safe harbors (proposed rule; reliance permitted)

The employer measures and the flags below come from
[REG-136401-18](https://www.federalregister.gov/documents/2019/09/30/2019-20034/application-of-the-employer-shared-responsibility-provisions-and-certain-nondiscrimination-rules-to),
proposed 26 CFR 54.4980H-5(f). The rule is still proposed (eCFR, 2026-11-05). Its preamble lets
taxpayers rely on it for plan years beginning before six months after final rules. Every rule in
a response carries `status: "final"` or `status: "proposed_reliance_permitted"` with citations.

- **Lowest age band** ((f)(7)(iii)(C)): employer verdicts identify the plan at the 0-14 age band
  and price that plan at the employee's age. This applies to every employer verdict.
- **Age** ((f)(7)(i)): age on the first day of the plan year, or on `eligible_from` for an
  employee who becomes eligible later.
- **Location** (`safe_harbors.location`, (f)(6)): the rating area of the primary site of
  employment instead of the residence. A remote employee with no site to report to
  (`worksite.remote: true`) keeps the residence.
- **Look-back month** (`safe_harbors.look_back`, (f)(4)): January of the prior calendar year for a
  calendar-year plan, January of the current calendar year otherwise.

With a location or look-back flag, the household-income verdict is also an employer verdict and
uses the same safe-harbor LCSP. Without them it uses the residence LCSP for the plan start month.

For a non-calendar plan year, the look-back changes the rate month, while the employee's age
and location describe the current offer. For example, a plan starting July 1, 2026 uses January
2026 rates. An employee born August 15, 1985 who can first receive the HRA on August 15, 2026
is priced at age 41, even though the employee was 40 when the plan year started and in January.
Send that effective date as `employee.eligible_from`. On August 14 the applicable age would
still be 40. The plan year determines the contribution percentage, so this example uses 9.96%.
The employer LCSP still identifies the plan at the lowest age band before pricing it at the
applicable age. For February through December starts, responses cite proposed (f)(4)(ii) and
(f)(7)(i)-(ii) as `look_back_current_circumstances`, with status
`proposed_reliance_permitted`.

Every non-January start month uses January of the year in `plan_start`, including a mid-year
entrant. `eligible_from` does not move the look-back month to the eligibility year. A missing
catalog returns `unknown` with `lookback_catalog_not_loaded`; another year's rates cannot fill
the gap. The supplied worksite or residence describes the current offer's location.

A calendar-year 2026 plan looks back to January 2025, so it needs the PY2025 catalog.
`data/rating-rules/2025.json` prices 31 states per member: the 2026 set plus Illinois. New York
and Vermont are not in the PY2025 Exchange PUF and stay unsupported for 2025, so their look-back
stays `unknown`. A past year's geography uses the CMS rating-area table only if that page was
last modified before the year began. South Dakota's page changed in 2026, so its 2025 rating
areas are unknown. A look-back there answers `incomplete_lcsp` with an `UNRESOLVED_RATING_AREA`
reason. Without a ZIP it answers `location_requires_zip` with `rating_area_needs_zip`.

## Premium basis

The LCSP uses the full monthly premium by default, as 26 CFR 1.36B-2(c)(5)(ii)(A) says ("monthly
premium"); (c)(5)(iii)(A) lists the only adjustments and does not include an
essential-health-benefits allocation. The figure ranked on the EHB portion of each premium
(`EHBPercentTotalPremium` in the Plan Attributes file) is always computed too and can be selected
with `lcsp_premium_basis: "ehb_portion"`. The fraction is read as an exact decimal from 0 to 1 with up
to 15 decimal places, and only the resulting monthly premium is rounded to the cent, half up. A
value with 16 or more places, or outside 0 to 1, leaves that plan's EHB figure unknown
(`ehb_allocation_unknown`). `lcsp.by_basis` returns both, every verdict has
`affordable_by_basis`, and `basis_sensitive` is `true` when the plan or a verdict differs between
the two, `false` when neither does, and `null` when the EHB figure could not be computed.

## Request

The route is open by default and shares the household per-source limits. A set
`OPENPLANS_API_TOKEN` requires `Authorization: Bearer <token>`. The body carries income, so
responses carry `Cache-Control: no-store`, are never cached, and no value is logged. Bodies are at most 64 KiB and any
unlisted field is refused.

```json
{
  "plan_start": "2026-01-01",
  "months_available": 12,
  "employee": { "date_of_birth": "1985-10-01", "eligible_from": null },
  "residence": { "zip": "77002", "county": "48201" },
  "worksite": { "zip": "78701", "county": "48453", "remote": false },
  "hra": { "self_only_annual_cents": 340000 },
  "income": [
    { "measure": "household", "annual_cents": 4000000 },
    { "measure": "rate_of_pay_hourly", "hourly_cents": 2000 }
  ],
  "safe_harbors": { "location": false, "look_back": false },
  "lcsp_premium_basis": "gross"
}
```

`income` holds one to four distinct measures. `worksite`, `safe_harbors`, `months_available`
(default 12) and `lcsp_premium_basis` (default `gross`) are optional. A ZIP is needed where a
county has ZIP-limited service areas or sub-county rating areas.

Optional fields on a measure:

| Measure              | Field                                     | Values                                               |
| -------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `w2`                 | `w2_months_offered`, `w2_months_employed` | integers 1 to 12, sent together, offered <= employed |
| `rate_of_pay_hourly` | `lowest_hourly_cents`                     | integer cents above zero                             |
| `rate_of_pay_salary` | `salary_reduced`                          | `true` or `false`                                    |

A value outside these ranges gets a 400 that names the field. The service never substitutes a
default.

## Response

`lcsp` is the residence LCSP for the premium tax credit verdict; `employer_lcsp` is the
safe-harbor LCSP for employer verdicts. Each is `null` when no verdict needs it. Both carry
`plan_ids`, `monthly_cents`, `by_basis`, `location` (county, ZIP, rating area), `coverage_month`,
`identified_at_age`, `priced_at_age`, `silver_plan_count` and the rate rows used. Money is integer
cents. Ratios are `{ numerator, denominator, display }` in cents.

For a plan year starting after January in a per-member state, the service selects rate rows whose
filed effective and expiration dates include the coverage month. When that is the January 1
calendar-year row, `provenance.rate_rows_by_plan[].rate_basis` labels it
`calendar_year_individual_rate` and names the coverage month. Its citation identifies the CMS
Rate PUF's `RateEffectiveDate` and `RateExpirationDate` fields and their filed dates. The
existing `rate_rows_used` entries identify the source snapshot and CSV row. An expired row, a
row from another year, or a missing age rate cannot supply a price. SHOP rates are outside this
calculation. January starts after the first day keep the existing `unknown` response with
`month_rate_rows_missing`.

Worked example, Harris County TX (Rating Area 10), PY2026, age 40: the LCSP is 27248TX0010019 at
$586.21 a month. With a $3,400 HRA over 12 months the monthly HRA amount is $283.33 (85,000 / 3
cents), and the required HRA contribution is 58,621 x 12 - 340,000 = 363,452 cents over 12 months,
$302.88. With household income of $40,000 the threshold is 4,000,000 x 9.96% / 12 = $332.00, so the
HRA is affordable for the premium tax credit test. At $20.00 an hour the rate-of-pay threshold is
130 x $20.00 x 9.96% = $258.96, so it is not affordable under that employer safe harbor.

## When there is no answer

Without the evidence, the response gives a status and no verdicts. It never reports affordable
or unaffordable in these cases:

| `status`                    | `reason`                                                                      | Meaning                                                                                |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `unknown`                   | `catalog_not_loaded`                                                          | No loaded catalog for that state and year; no other year is used                       |
| `unknown`                   | `lookback_catalog_not_loaded`                                                 | The look-back January needs the prior year's catalog                                   |
| `unknown`                   | `month_rate_rows_missing`                                                     | A silver plan lacks a rate row for that month and age, or the plan starts January 2-31 |
| `unknown`                   | `location_ambiguous`, `location_unknown`                                      | The ZIP spans counties without a county, or is not known                               |
| `location_requires_zip`     | `zip_limited_service_area`, `sub_county_rating_area`, `rating_area_needs_zip` | A ZIP is needed to know which plans are offered or which rating area applies           |
| `requires_state_rules`      | `state_filed_tier_pending`                                                    | The required filed-tier rating rule is unavailable                                     |
| `unsupported_state`         |                                                                               | Territories have no Exchange LCSP in these files                                       |
| `unsupported_rating_method` |                                                                               | The state's rating method is not supported                                             |
| `incomplete_lcsp`           | plan and cause                                                                | A silver plan is unrated, or its child-only offering is unknown                        |
| `ambiguous_lcsp`            |                                                                               | Conflicting duplicate prices for one plan                                              |
| `no_silver_plans`           |                                                                               | No on-Exchange silver plan is offered                                                  |
| `parameters_unconfirmed`    |                                                                               | No cited parameters for the plan year                                                  |

A single verdict can also be `unknown`. It still lists the rules it falls under, with citations.

| Verdict `reason`                                  | Meaning                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `w2_partial_year_not_supported`                   | W-2 measure with fewer than 12 months or a non-calendar plan year, and no month counts |
| `w2_months_offered_differs_from_months_available` | The month counts do not describe the months this HRA is available                      |
| `w2_non_calendar_plan_year_not_supported`         | Month counts were sent for a plan year that is not a calendar year                     |
| `rate_of_pay_salary_reduced`                      | The monthly salary was reduced, so the rate-of-pay safe harbor is not available        |
| `fpl_guideline_not_in_effect`                     | No poverty guideline on file is in effect for the plan start                           |

A verdict is `ambiguous_lcsp` when plans tied at the lowest age band have different prices at the
employee's age and the verdicts differ.

Errors: 400 `{"error":{"code":...,"field":...}}` with `INVALID_DATE`, `INVALID_INPUT`,
`UNKNOWN_FIELD`, `DUPLICATE_MEASURE`, `LOCATION_REQUIRED`, `SAFE_HARBOR_INPUT_MISSING`,
`W2_MONTHS_INCOMPLETE` (one month count without the other), `W2_MONTHS_OFFERED_EXCEED_EMPLOYED`,
`INVALID_JSON` or `REQUEST_TOO_LARGE`; 401 `UNAUTHORIZED`; 503 `AUTH_NOT_CONFIGURED`; 504
`REQUEST_DEADLINE`. Errors name the field and never echo its value.

## MCP

The MCP tool `check_ichra_affordability` takes the same body as the route and follows the same
access rule as `quote_premiums`: open by default, restricted by a set `OPENPLANS_MCP_TOKEN`. It returns each calculated LCSP in `lcsps`
(with `use`: `premium_tax_credit` or `employer`) with source references, the verdicts exactly as
the route computes them, and each rule's status with its citation URLs. It is never cached.

## Coverage

`GET /v1/data-availability` rows carry `ichra_status` (`available`, `unknown`, `unsupported`,
`requires_state_rules`, `incomplete_lcsp`), `ichra_reason`, `ichra_lookback_status` and `ichra_rules`. `available`
means premiums are available for the row, the year's catalog is loaded and the year's parameters
are confirmed. The EHB-portion figure can still be unknown in some counties. `ichra_lookback_status` is
`available` when `ichra_status` is `available` and the prior plan year's catalog for the state is
loaded too, and `unknown` otherwise.

### New York and Vermont

For 2026, New York uses the lowest filed `single` price among eligible silver plans in the
employee's DFS rating region. Each exact HIOS identity must appear in an active, complete
[CMS SBE PUF Plan Attributes publication](https://www.cms.gov/marketplace/resources/data/state-based-public-use-files).
The response labels this Exchange-offer evidence `cms_sbe_puf_plan_attributes` and cites its
bundle URL, hash, snapshot and source rows. It also cites the filed price cell, county-to-region
mapping and state rating rule. This evidence does not establish county-specific enrollment
eligibility.

Some filed rate rows cover off-Exchange plans absent from the CMS publication. For four
2026 filings, a small source cut from [DFS final Exhibit 23 publications](https://myportal.dfs.ny.gov/web/prior-approval/2026-final-exhibits)
supplies explicit metal and Exchange/CSR fields. The join uses the current 16-character HIOS
variant ID, its 14-character base, the exact rate-publication hash, and a matching 2026 regional
single premium. Quotes use the approved rate-template cells. Exhibit 23 prices only validate
the identity join. Previous-year IDs and rates cannot establish a match.

The response cites these facts as `filed_identity.source: ny_dfs_exhibit_23`, with the
publication URL, hash, workbook, sheet, physical rows and field columns. A consistent `Off`
field on every current variant excludes that plan from the Exchange silver set. Conflicting
Exchange evidence for a silver plan prevents an answer. DFS `On` fields do not replace CMS
Exchange-offer evidence.
The source cut resolves 424 regional rows: 422 off-Exchange and two catastrophic. To verify
or regenerate it from cached original files, run:

```sh
python3 -B src/ingest/state/ny-identity.py --data-dir "$OPENPLANS_DATA_DIR"
# Add --write to regenerate data/rating-rules/ny-plan-identities-2026.json.
node src/ingest/state/ny-identitycheck.mjs "$OPENPLANS_DATA_DIR"
```

The second command needs a build. It imports cached publications into a disposable database,
checks that a refused template's rows are absent and its refusal is recorded, expects
`unknown` in each region where it lists a possible silver plan, rejects a planted service
that computes those regions without it,
checks gross and EHB prices in the other regions against independent decimal calculations,
and plants missing-silver, changed-price and unnormalized-percentage controls. Results go to
`reports/ny-ehb-2026/` under the data directory. It never connects to a running service or
downloads files.

When the template guard described in the state ingest README refuses an issuer's DFS
approved-rates template, that issuer's plans have no usable price. In a region where the refused template lists a plan
that could be silver, the LCSP is `unknown` and the reason is the refusal's code, for example
`template_saved_before_submission`. It is never calculated from the remaining issuers. A
listed plan is ruled out only when CMS Plan Attributes give it one non-silver metal level.
`provenance.refused_templates` names the issuer, filing, plan and region. Other regions keep
their answers. In the PY2026 cache one issuer is refused and it lists a possible silver plan
in all eight regions. Every NY LCSP stays `unknown` until the cache holds approved rates for
that issuer.

An operator can turn on a second source for a refused issuer with `ny.rateSourceOverrides` in the
[config file](configuration.md#ny-rate-source-override). Its family-tier rates then come from the
CMS state-based exchange rate file for New York, which must match every DFS approved rate it
lists for the other issuers to the cent. Each rate cell names the CMS column it came from, and
the issuer carries an `info` quality issue `rate_source_override`. A plan the CMS file prices no
longer blocks its regions. A plan it does not price stays `unknown` and still makes its regions'
LCSP `unknown`. The switch is off by default.

A silver plan without CMS offer evidence or an explicit off-Exchange exclusion makes the LCSP `incomplete_lcsp` with reason
`exchange_offering_unverified`. Missing or conflicting metal evidence also makes the result
`incomplete_lcsp`, with reason `metal_level_unknown`. The calculation never drops an unverified
candidate to choose a more expensive plan. Unknown family eligibility and conflicting filed
rows also prevent an answer.

New York responses use `quote_method: state_filed_tier`, `age_rating: none` and null
`identified_at_age` and `priced_at_age`. Both employee and employer checks use the same
age-independent single-tier prices. The EHB-portion basis needs a published, consistent EHB
fraction for every eligible silver plan. Missing fractions leave the gross calculation intact
and the EHB-portion result incomplete. Ingestion converts published percentages such as `99%`,
`99` and `99.5 %` to fraction strings, while `0.99` stays a fraction. Unmarked values through
1 are fractions; values above 1 through 100 are percentages. Conflicting aliases, malformed
values and values outside the range stay unknown. Allocation accepts only fraction strings
and rounds the resulting premium to cents.

Vermont 2026 uses the explicit `METAL LEVEL` cells in the admitted
[CMS Vermont SBE bundle](https://www.cms.gov/files/zip/vermontsbepuf2026.zip).
`data/rating-rules/vt-plan-metals-2026.json` maps all 26 main-filing designs to their
literal CMS metal fields through the existing exact HIOS identity join. The mapping pins the
original filed PDF hash and tier cells, the CMS bundle hash, variant identities and physical
CSV rows. Names and prices do not supply a metal level. Missing or conflicting evidence
returns `incomplete_lcsp` with `metal_level_unknown`, including a missing Silver variant.
A changed or unreviewed bundle cannot inherit the mapping.

Vermont has one statewide rating area. The eight eligible Silver designs have a lowest filed
single premium of $1,288.59. ICHRA uses that lowest premium. The second-lowest gross Silver
premium is $1,298.94; this figure alone does not establish an adjusted premium-tax-credit
benchmark. The optional eight reflective designs remain explicitly off-Exchange and are
excluded from the ICHRA candidate set under their cited state filings. Both the original and
reflective catalogs retain the same eligible Silver set.

Verify or regenerate the cut and check the actual service from cached originals after a build:

```sh
python3 -B src/ingest/state/vt-metal.py --data-dir "$OPENPLANS_DATA_DIR"
# Add --write to regenerate data/rating-rules/vt-plan-metals-2026.json.
node src/ingest/state/vt-metalcheck.mjs "$OPENPLANS_DATA_DIR"
```

The checker uses a disposable database, checks all 14 counties, and rejects changed metal,
missing Silver evidence, changed prices and inactive attribute snapshots. It writes results
to `reports/vt-metal-2026/`. Neither command downloads files or uses a running service.

Both states use community-rated family tiers without age or tobacco factors. Self-only
coverage uses the filed `single` tier. The state premium rules cite
[New York Insurance Law 3231](https://www.nysenate.gov/legislation/laws/ISC/3231),
[4317](https://www.nysenate.gov/legislation/laws/ISC/4317) and the
[DFS 2026 filing instructions, sections M and N](https://www.dfs.ny.gov/apps-and-licensing/health-insurers/pa-nysoh-out-nysoh/2026-instruct-filing-premium-rates).
For Vermont, they cite
[33 V.S.A. 1811](https://legislature.vermont.gov/statutes/section/33/018/01811),
[DFR Docket 13-002-I, page 2](https://dfr.vermont.gov/sites/finreg/files/regbul/dfr-order-docket-13-002-i-vermont-health-benefits-exchange.pdf)
and [DVHA 2026 issuer guidance, section 2.2](https://dvha.vermont.gov/sites/dvha/files/documents/IssuerGuidanceForParticipation2026.pdf).

NY and VT availability rows report these limits as follows:

| Scope                                          | `ichra_status`    | Reason                                                                       |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| NY 2026, complete loaded regional evidence     | `available`       | null                                                                         |
| NY 2026, incomplete candidate evidence         | `incomplete_lcsp` | `exchange_offering_unverified`, `metal_level_unknown` or the candidate issue |
| NY 2026, a refused template lists a candidate  | `unknown`         | the refusal's reason code, e.g. `template_saved_before_submission`           |
| NY 2026, no loaded filed catalog               | `unknown`         | `catalog_not_loaded`                                                         |
| VT 2026, complete cited catalog                | `available`       | null                                                                         |
| VT 2026, missing or conflicting metal evidence | `incomplete_lcsp` | `metal_level_unknown`                                                        |
| VT 2026, no loaded filed catalog               | `unknown`         | `catalog_not_loaded`                                                         |
| NY/VT 2027                                     | `unknown`         | `catalog_not_loaded`                                                         |

NY readiness checks every loaded DFS region. It describes gross-premium calculation readiness;
a particular request may still lack an EHB fraction or family eligibility evidence.
Both states retain `ichra_lookback_status: unknown` and
`ichra_lookback_reason: catalog_not_loaded`. No prior-year filed catalog is supported.
NY/VT requests for 2027 or a missing look-back catalog return `unknown`; a non-January coverage
month returns `unknown` with `month_rate_rows_missing`.

`ichra_reason` explains the row's year. `ichra_documentation` points to this section.
The MCP tool `get_data_status` and resource `openplans://availability` include the same
fields. A state and year with no manifest entry has no availability row. Confirmed 2027
affordability parameters alone do not supply a state LCSP or a look-back catalog.

Not covered: the employer's section 4980H payment, QSEHRA, class rules, months after the first one,
a required contribution that changes during the offered months, and part-year periods across
taxable years ([26 CFR 1.36B-2(c)(5)(vi)](https://www.ecfr.gov/current/title-26/section-1.36B-2)).
