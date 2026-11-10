# ICHRA affordability

`POST /v1/ichra/affordability` estimates whether an individual coverage HRA (ICHRA) is
affordable for one employee in the first month of the plan year. It answers the IRS premium tax
credit rule and, on request, the employer safe harbors. Figures come from public filed rates in
the CMS Exchange public use files. This is an estimate, not tax or legal advice, and never a
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
| `w2`                 | `annual_cents`  | Form W-2 box 1 wages x percentage / 12; full calendar plan year only | employer           | [54.4980H-5(e)(2)(ii)](https://www.ecfr.gov/current/title-26/section-54.4980H-5), applied by proposed (f)(5)(i) |
| `rate_of_pay_hourly` | `hourly_cents`  | 130 hours x hourly rate x percentage                                 | employer           | (e)(2)(iii), applied by proposed (f)(5)(ii)                                                                     |
| `rate_of_pay_salary` | `monthly_cents` | monthly salary x percentage                                          | employer           | (e)(2)(iii), applied by proposed (f)(5)(ii)                                                                     |
| `fpl`                | none            | one-person poverty line of the state of employment x percentage / 12 | employer           | (e)(2)(iv), applied by proposed (f)(5)(iii)                                                                     |

Each verdict states its `purpose`. Employer verdicts answer section 4980H(b) only and never decide
whether the employee may claim the premium tax credit.

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

## Premium basis

The LCSP uses the full monthly premium by default, as 26 CFR 1.36B-2(c)(5)(ii)(A) says ("monthly
premium"); (c)(5)(iii)(A) lists the only adjustments and does not include an
essential-health-benefits allocation. The figure ranked on the EHB portion of each premium
(`EHBPercentTotalPremium` in the Plan Attributes file) is always computed too and can be selected
with `lcsp_premium_basis: "ehb_portion"`. `lcsp.by_basis` returns both, every verdict has
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

## Response

`lcsp` is the residence LCSP for the premium tax credit verdict; `employer_lcsp` is the
safe-harbor LCSP for employer verdicts. Each is `null` when no verdict needs it. Both carry
`plan_ids`, `monthly_cents`, `by_basis`, `location` (county, ZIP, rating area), `coverage_month`,
`identified_at_age`, `priced_at_age`, `silver_plan_count` and the rate rows used. Money is integer
cents. Ratios are `{ numerator, denominator, display }` in cents.

Worked example, Harris County TX (Rating Area 10), PY2026, age 40: the LCSP is 27248TX0010019 at
$586.21 a month. With a $3,400 HRA over 12 months the monthly HRA amount is $283.33 (85,000 / 3
cents), and the required HRA contribution is 58,621 x 12 - 340,000 = 363,452 cents over 12 months,
$302.88. With household income of $40,000 the threshold is 4,000,000 x 9.96% / 12 = $332.00, so the
HRA is affordable for the premium tax credit test. At $20.00 an hour the rate-of-pay threshold is
130 x $20.00 x 9.96% = $258.96, so it is not affordable under that employer safe harbor.

## When there is no answer

Without the evidence, the response gives a status and no verdicts. It never reports affordable
or unaffordable in these cases:

| `status`                    | `reason`                                             | Meaning                                                                           |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `unknown`                   | `catalog_not_loaded`                                 | No loaded catalog for that state and year; no other year is used                  |
| `unknown`                   | `lookback_catalog_not_loaded`                        | The look-back January needs the prior year's catalog                              |
| `unknown`                   | `month_rate_rows_missing`                            | Plan years that start after January need month-specific rates (not yet supported) |
| `unknown`                   | `location_ambiguous`, `location_unknown`             | The ZIP spans counties without a county, or is not known                          |
| `location_requires_zip`     | `zip_limited_service_area`, `sub_county_rating_area` | A ZIP is needed to know which plans are offered or which rating area applies      |
| `requires_state_rules`      | `state_filed_tier_pending`                           | New York and Vermont use filed family tiers, not yet supported here               |
| `unsupported_state`         |                                                      | Territories have no Exchange LCSP in these files                                  |
| `unsupported_rating_method` |                                                      | The state's rating method is not supported                                        |
| `incomplete_lcsp`           | plan and cause                                       | A silver plan is unrated, or its child-only offering is unknown                   |
| `ambiguous_lcsp`            |                                                      | Conflicting duplicate prices for one plan                                         |
| `no_silver_plans`           |                                                      | No on-Exchange silver plan is offered                                             |
| `parameters_unconfirmed`    |                                                      | No cited parameters for the plan year                                             |

A single verdict can also be `unknown`: `w2_partial_year_not_supported` (W-2 measure with fewer
than 12 months or a non-calendar plan year) or `fpl_guideline_not_in_effect`. A verdict is
`ambiguous_lcsp` when plans tied at the lowest age band have different prices at the employee's
age and the verdicts differ.

Errors: 400 `{"error":{"code":...,"field":...}}` with `INVALID_DATE`, `INVALID_INPUT`,
`UNKNOWN_FIELD`, `DUPLICATE_MEASURE`, `LOCATION_REQUIRED`, `SAFE_HARBOR_INPUT_MISSING`,
`INVALID_JSON` or `REQUEST_TOO_LARGE`; 401 `UNAUTHORIZED`; 503 `AUTH_NOT_CONFIGURED`; 504
`REQUEST_DEADLINE`. Errors name the field and never echo its value.

## MCP

The MCP tool `check_ichra_affordability` takes the same body as the route and follows the same
access rule as `quote_premiums`: open by default, restricted by a set `OPENPLANS_MCP_TOKEN`. It returns each calculated LCSP in `lcsps`
(with `use`: `premium_tax_credit` or `employer`) with source references, the verdicts exactly as
the route computes them, and each rule's status with its citation URLs. It is never cached.

## Coverage

`GET /v1/data-availability` rows carry `ichra_status` (`available`, `unknown`, `unsupported`,
`requires_state_rules`), `ichra_reason`, `ichra_lookback_status` and `ichra_rules`. `available`
means premiums are available for the row, the year's catalog is loaded and the year's parameters
are confirmed. The EHB-portion figure can still be unknown in some counties.

Not covered: the employer's section 4980H payment, QSEHRA, class rules, months after the first one,
and part-year periods across taxable years.
