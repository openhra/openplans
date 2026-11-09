# Subsidy parameter report — retrieved 2026-11-07

Coverage/tax years **2026 and 2027 are confirmed** for the parameters below. Both IRS Revenue
Procedures are published; neither year substitutes an assumed legislative extension. Confirmation
is about parameter evidence, not a person's eligibility. No year in this release is unconfirmed.
An unknown year, an explicitly unconfirmed file, a mismatched year, or invalid citation/schema data
produces `parameters_unconfirmed` with all numerical fields null.

Each JSON policy value has a `value` and `citations` wrapper. A citation on a table
covers every cell in that table; its section identifies the region or Revenue Procedure table.
All citations have retrieval date **2026-11-07**. `schemaVersion: 1` is the file format version,
not a tax parameter. No network is required to validate or use these files.

## Poverty guidelines (annual dollars)

The coverage year uses the guidelines in effect when the preceding open enrollment period began,
so 2026 uses the 2025 guidelines and 2027 uses the 2026 guidelines. Source:
[26 CFR 1.36B-1(h)](https://www.ecfr.gov/current/title-26/section-1.36B-1), retrieved 2026-11-07.
This selects the poverty guideline publication year; it does not use the coverage year's newly
published Medicaid guidelines as the APTC tax-credit denominator.

| Coverage year | Guideline year | Region | Family sizes 1, 2, 3, 4, 5, 6, 7, 8 ($/year) | Additional person after 8 ($) | Source |
|---|---|---|---|---|---|
| 2026 | 2025 | 48 states + DC | 15,650; 21,150; 26,650; 32,150; 37,650; 43,150; 48,650; 54,150 | 5,500 | HHS25 |
| 2026 | 2025 | Alaska | 19,550; 26,430; 33,310; 40,190; 47,070; 53,950; 60,830; 67,710 | 6,880 | HHS25 |
| 2026 | 2025 | Hawaii | 17,990; 24,320; 30,650; 36,980; 43,310; 49,640; 55,970; 62,300 | 6,330 | HHS25 |
| 2027 | 2026 | 48 states + DC | 15,960; 21,640; 27,320; 33,000; 38,680; 44,360; 50,040; 55,720 | 5,680 | HHS26 |
| 2027 | 2026 | Alaska | 19,950; 27,050; 34,150; 41,250; 48,350; 55,450; 62,550; 69,650 | 7,100 | HHS26 |
| 2027 | 2026 | Hawaii | 18,360; 24,890; 31,420; 37,950; 44,480; 51,010; 57,540; 64,070 | 6,530 | HHS26 |

- **HHS25:** HHS Annual Update, **90 FR 5917–5918**, January 17, 2025, document 2025-01377,
  [three regional tables and their additional-person notes](https://www.govinfo.gov/content/pkg/FR-2025-01-17/html/2025-01377.htm).
  Retrieved 2026-11-07.
- **HHS26:** HHS Annual Update, **91 FR 1797–1798**, January 15, 2026, document 2026-00755,
  [three regional tables and their additional-person notes](https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm).
  Retrieved 2026-11-07.

Only 50 states and DC are mapped. Territories or invalid state codes return `requires_state_rules`
with reason `unsupported_state`; they never inherit the contiguous table.

## Applicable percentages and employer affordability

JSON percentages use integer **basis points**: 210 means 2.10%; the engine result uses a fraction:
`applicablePercentage: 0.021` means 2.10% of annual household income.

| Income band (% FPL) | 2026 initial → final (%) | 2027 initial → final (%) |
|---|---|---|
| 100 ≤ income < 133 | 2.10 → 2.10 | 2.15 → 2.15 |
| 133 ≤ income < 150 | 3.14 → 4.19 | 3.23 → 4.30 |
| 150 ≤ income < 200 | 4.19 → 6.60 | 4.30 → 6.78 |
| 200 ≤ income < 250 | 6.60 → 8.44 | 6.78 → 8.66 |
| 250 ≤ income < 300 | 8.44 → 9.96 | 8.66 → 10.22 |
| 300 ≤ income ≤ 400 | 9.96 → 9.96 | 10.22 → 10.22 |
| Employer required contribution percentage | **9.96** | **10.22** |

2026 table and year: [IRS Revenue Procedure 2025-25, §§3.01 and 5](https://www.irs.gov/pub/irs-drop/rp-25-25.pdf).
2026 employer percentage: same procedure, §3.02. Retrieved 2026-11-07.

2027 table and year: [IRS Revenue Procedure 2026-26, §§3.01 and 5](https://www.irs.gov/pub/irs-drop/rp-26-26.pdf).
2027 employer percentage: same procedure, §3.02. Retrieved 2026-11-07.

The employer percentage is recorded for affordability integrations. It is **not** the applicable
household percentage across all bands and is deliberately unused by `estimateAptc`.

Both years have a **100% minimum** and an exact **400% maximum** under
[26 USC 36B(c)(1)(A), (E)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section36B&num=0&edition=prelim),
retrieved 2026-11-07. The temporary exception ends before 2026. The first Revenue Procedure band
says “less than 133%”; the JSON starts it at the statutory 100% minimum, with below-minimum cases
handled separately. The 400% endpoint is included. Even one cent above the exact income limit
returns `above_income_cliff`, the Worksheet 2 FPL figure **401**, zero credit, and no applicable
percentage or contribution amount. Figure 401 is the IRS above-limit sentinel, not a raw ratio.

## Rounding and low-income review parameters

All of these apply to both years and have citations in the JSON:

| Parameter | Value / behavior | Primary source (retrieved 2026-11-07) |
|---|---|---|
| FPL percentage | Exact cliff comparison first, then truncate fractional percentage points | [Form 8962 instructions, line 5 / Worksheet 2](https://www.irs.gov/instructions/i8962) |
| Applicable percentage | Linear interpolation; nearest 0.01 percentage point, half up | [26 CFR 1.36B-3(g)(1)](https://www.ecfr.gov/current/title-26/section-1.36B-3) |
| Annual expected contribution | Income × applicable fraction, nearest whole dollar, half up | [Form 8962 instructions, line 8a](https://www.irs.gov/instructions/i8962) |
| Monthly expected contribution | Rounded annual dollars / 12, nearest whole dollar, half up | [Form 8962 instructions, line 8b](https://www.irs.gov/instructions/i8962) |
| State-rule review screen | At or below **138%** of the coverage-year tax-credit FPL denominator, including below 100%; no numeric credit | [CMS HealthCare.gov Medicaid expansion explanation](https://www.healthcare.gov/medicaid-chip/medicaid-expansion-and-you/) |

The Form 8962 page available at retrieval is the **2025** edition. Only its procedural rounding
instructions are used; its 2025 enhanced percentage table and eligibility exceptions are not
imported. Year-specific percentages and limits come from the sources above. Money calculations
use integer cents and BigInt ratios, preserving half-dollar and half-basis-point ties exactly.
Gross premiums, benchmark premiums and credit retain their cents; the IRS contribution amounts
are the fields rounded to dollars.

The 138% value is a conservative review trigger derived from CMS's effective expansion threshold,
not a state Medicaid rule or an eligibility cutoff. Medicaid can use current-year FPL, monthly
income, different family definitions and higher limits for some groups. This function cannot
resolve any of that from its input. Below 100% returns `requires_state_rules` with reason
`below_100_fpl`; 100% through the screen returns the same status with reason
`medicaid_expansion_review`. It never declares those households ineligible or invents a $0 credit.
Above the screen, `estimated` is conditional arithmetic assuming the caller has separately
resolved Medicaid/CHIP, other minimum essential coverage, filing status and immigration eligibility.
The screen does not establish eligibility above 138%, including at the changed 2027 rules.

## Domain contracts and integration

```ts
import { estimateAptc, netPremium, slcsp } from '../../src/domain/subsidy/index.js';

// SYNTHETIC worked example; income is annual MAGI dollars, benchmark is monthly cents.
const estimate = estimateAptc({ householdIncome: 31300, householdSize: 1, state: 'TX',
  year: 2026, slcspMonthlyCents: 60000 });
// fplPercent 200; applicablePercentage .066; annualExpectedContributionCents 206600;
// expectedContributionCents 17200 (MONTHLY); estimatedMonthlyCreditCents 42800.
if (estimate.status === 'estimated') {
  const price = netPremium(60000, estimate.estimatedMonthlyCreditCents!);
  // grossMonthlyPremiumCents 60000; estimatedMonthlyCreditCents 42800;
  // estimatedNetMonthlyPremiumCents 17200.
}
```

The optional second `estimateAptc(input, parameters)` argument accepts an audited parameter object.
By default, it uses the generated registry, whose types prevent mutation. Domain modules perform no file/network I/O.
Family size is the **tax family** size; SLCSP uses the **coverage family**, which can be smaller.
`expectedContributionCents` is monthly; the annual trace is separately named.

`slcsp(candidates, household)` consumes `HouseholdPremium` results from `domain/rating`. Candidates
must be the complete applicable household offer set, already filtered/attested for service area,
Exchange, enrollment date and coverage-family eligibility. `availableToHousehold` is explicit.
`onExchange` and silver metal level are checked. Call the rating engine with all tobacco flags
false even for a smoker's household: [IRS PTC FAQ Q26](https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit),
retrieved 2026-11-07. A result rated with tobacco, for another household/date, or across rating
areas is rejected. A missing/unsupported/ambiguous silver rating blocks the entire benchmark;
it is not silently omitted to produce a partial-catalog estimate.

The caller must explicitly set `benchmarkScope: 'single_location_single_policy'` on the household
and `benchmarkBasis: 'ehb_only_no_dental_adjustment_required'` on candidates. The API supplies already allocated/adjusted EHB totals under this domain attestation;
its pediatric dental adapter is described below. Multi-location/policy adjustments remain unsupported.
Otherwise the result is `requires_benchmark_adjustments`, with no number. These requirements follow
[26 CFR 1.36B-3(e), (f)(1)–(8)](https://www.ecfr.gov/current/title-26/section-1.36B-3), retrieved
2026-11-07. The API implements the ordinary single-location/policy case, including pediatric dental, with missing evidence failing closed.

Distinct plans at tied prices both count: [$400 A, $400 B, $500 C] has a $400 benchmark.
With only one silver plan, its premium is the benchmark. Source:
[IRS PTC FAQ Q25](https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit),
retrieved 2026-11-07. Repeated rows of the same plan are not additional offers: this implementation
uses existing `parse_hios(...).base` identity to deduplicate repeated imports/CSR variants before
ranking. That identity policy is an implementation decision, not a separate IRS tie rule.
Conflicting prices for one base ID return `ambiguous_benchmark`. Returned IDs are base IDs sorted
deterministically; no CSR variant eligibility is inferred.

`netPremium(gross, credit, eligiblePremium = gross)` caps applied credit at the enrollment
EHB premium (and therefore never exceeds gross), keeps gross/credit/net as separate fields and always returns `quote_method: 'puf_calculation'`, `bindable_quote: false`.
The optional default requires an all-EHB premium; the API always supplies the allocated EHB amount.
This is the enrollment-premium cap in [26 USC 36B(b)(2)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section36B&num=0&edition=prelim),
retrieved 2026-11-07. The same metadata labels benchmark and APTC results. CSR remains unevaluated. The caller must not turn a null/incomplete result into a zero credit.

## Offline maintenance and validation

```sh
node scripts/subsidy/build.mjs        # deterministic JSON → TypeScript embedding; no network
npm run build
node scripts/subsidy/check.mjs        # citation/schema/year checks + generated registry freshness
npx vitest run tests/domain/subsidy
```

`tests/domain/subsidy/parameters.test.ts` exercises the checker, so the unchanged
`scripts/ci.sh` and repository gate both run it after building. It accepts an optional
quarantine directory containing year JSON files. It rejects missing citations, non-primary
URLs, invalid dates, malformed tables, inconsistent increments/bands, mismatched year filenames,
and stale generated output. Citation validation checks that values have sources. It does not check whether legislation
has changed. To review a future change, retrieve its primary sources and dates again.

Negative controls use temporary files/source copies only: remove citations and observe the CLI
exit 1; mark an otherwise valid year unconfirmed and observe all-null `parameters_unconfirmed`;
compile an AK → contiguous-table source mutant and observe the same Alaska worked-example
assertion fail (wrong 249% versus correct 200% FPL).

The test households and invented ordering-test premiums are labelled **synthetic**. A separate
integration test passes the real, committed rating fixture through our household rating engine
before SLCSP selection. The checks did not compare live CMS results or determine enrollment eligibility.
Those checks need the later shopping/eligibility adapters and a matched household benchmark.

## P5c audit: ZIP 77002, PY2026, single age 40, annual income $31,300

Audited 2026-11-07 using a private copy of the complete TX PGlite catalog. Household inputs
are **synthetic**; plan/rate/benefit records are real CMS PUF records. No invented
premium is involved. The existing engine deliberately follows Form 8962 contribution rounding.
**Under that policy the correct result is 41,976 cents, not the proposed 41,961 cents.**
This is a conditional Form-based estimate, not a claim that Marketplace advance-payment rounding
or eventual tax-return reconciliation has been reproduced. The API now explicitly identifies
`rounding_policy: form_8962_lines_8a_8b_whole_dollars` in the contribution trace.

The Census geography snapshot is `census-zcta-county-2020:3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf`.
The active catalog import is `puf-2026-TX-fd37dae9-e565-41d5-8495-b20acfe4ca71`;
append `:rate` or `:plan-attributes` to obtain the response's snapshot IDs. Row numbers are
CSV source rows including the header. Cached, unchanged input identities:

| CMS source | SHA-256 of imported CSV |
|---|---|
| [Rate PUF](https://download.cms.gov/marketplace-puf/2026/rate-puf.zip) | `a05423ee91d137420510ca0d325fb8538861ace21d07ea062e8c3f6410732edf` |
| [Plan Attributes PUF](https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip) | `954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2` |
| [Benefits PUF](https://download.cms.gov/marketplace-puf/2026/benefits-and-cost-sharing-puf.zip) | `aa2d6874704bc951ed28792af3e65a4bd5b48eb3dbc086325f5ce053f08d8682` |

| Step | Exact value / result | Evidence or rule |
|---|---|---|
| Request | ZIP 77002; coverage 2026-01-01; one member age 40; no tobacco for benchmark | Synthetic household; benchmark premiums exclude tobacco under §1.36B-3(e) |
| Geography | Harris County 48201; Rating Area 10 | Census ZCTA-county source row 39844 (77002 → 48201); CMS rating-area source row 104, snapshot `cms-rating-areas:c1ac46907b43ec9d22a30060a72e3b1b3d651652ef96021da78b007ebb27cb8f` |
| Silver offer set | 46 distinct applicable on-Exchange base plans | Full active catalog, county/ZIP service areas; every silver rating must succeed |
| Cheapest silver | `27248TX0010019`: gross 58,621¢; EHB fraction 1; EHB 58,621¢ | Rate row 1892337; Plan Attributes rows 16126–16132 |
| Second silver | `87226TX0140004`: gross 61,443¢; EHB fraction .9631 | Rate row 2036055; Plan Attributes rows 19702–19708 |
| EHB allocation | 61,443 × .9631 = 59,175.7533¢ → **59,176¢** | §1.36B-3(j): allocate before ranking; decimal money serialization to nearest cent |
| Dental adjustment | **0¢** | No coverage-family member under 19; §1.36B-3(f)(9), Example 4 |
| Benchmark | **59,176¢** | Second cost after EHB allocation, not gross 61,443¢; §1.36B-3(f)(1)–(3) |
| FPL publication year | **2025** for coverage year 2026 | §1.36B-1(h), guidelines effective at preceding open enrollment |
| One-person contiguous FPL | **$15,650** | HHS25 table above; TX uses contiguous table |
| Income/FPL | $31,300 ÷ $15,650 = **200% exactly** | Form 8962 line 5; no fractional truncation changes this case |
| Applicable percentage | **6.60% = .066 = 660 basis points** | Rev. Proc. 2025-25 §3.01, initial endpoint of 200–250% band; both adjoining endpoints agree |
| Unrounded annual contribution | $31,300 × .066 = **$2,065.80** | §1.36B-3(g)(1) |
| Annual contribution (line 8a) | **$2,066 = 206,600¢** | Form 8962 instructions, line 8a: nearest whole dollar |
| Divide rounded annual by 12 | $2,066 ÷ 12 = **$172.166666…** | Form 8962 instructions, line 8b |
| Monthly contribution (line 8b) | **$172 = 17,200¢** | Line 8b also requires nearest whole dollar |
| Household credit before plan cap | 59,176 − 17,200 = **41,976¢** | Benchmark minus rounded contribution |
| Example enrollment | `20069TX0100006`, gross/EHB 75,874¢ | Real Rate PUF through own rating engine; HTTP output below |
| Applied credit / net | min(75,874, 41,976) = **41,976¢**; net **33,898¢** | Enrollment EHB cap, §1.36B-3(d)(1), (j)(1) |

[IRS Form 8962 instructions, lines 8a–8b](https://www.irs.gov/instructions/i8962)
explicitly round both contribution fields to whole dollars. Those instructions are quoted next
to the calculation in `src/domain/subsidy/aptc.ts`. The proposed $172.15 contribution skips
**both** steps: $2,065.80 / 12 = $172.15, yielding $419.61. That is the entire 15¢ discrepancy.
It is not a changed FPL year, interpolation error, dental premium, or gross/EHB difference.
The correction here is to the hand calculation and its undocumented precision assumption;
changing the established rounding algorithm solely to force $419.61 would contradict its cited policy.
The retrieved Form instructions are the 2025 edition; year-specific percentages still come from
the 2026 Revenue Procedure, never that form's 2025 percentage table.

A regression test checks every contribution intermediate and 41,976¢ against this real
benchmark. A disposable compiled source mutant calculates monthly cents directly; it produces
41,961¢ and fails the same trace assertion. Monthly whole-dollar rounding without annual rounding
happens to give the same $172 here, so that mutation alone cannot distinguish this household;
the annual trace assertion also guards the annual step. Exact 150%, 200% and 400% FPL cases
assert the corresponding annual/monthly contributions and credits to the cent.

## Pediatric dental and the enrollment cap

The current [26 CFR 1.36B-3](https://www.ecfr.gov/current/title-26/section-1.36B-3)
places the dental benchmark rule in **(f)(3)**, with the worked calculation in **(f)(9),
Example 3**. Paragraph (f)(6) concerns plans not available for enrollment. For each silver
option lacking pediatric dental EHB, add the second-lowest **pediatric EHB allocation** among
applicable SADPs **before** selecting the second-lowest silver option. Gross dental prices
are not the ranking basis. Tied distinct plans count separately; a sole dental offer is used
under (f)(8). Only under-19 members add pediatric premiums; ages 19 and 20 no longer trigger
the former blanket under-21 refusal.

Public data does contain the allocation: Plan Attributes
`EHBPediatricDentalApportionmentQuantity`. The [CMS dictionary, page 11](https://www.cms.gov/files/document/planattributes-datadictionary-py27.pdf)
states it is a percentage in 2017–2027 (a dollar amount only in 2014–2016). Current TX values
are decimal fractions, some with nine decimal places. Medical `EHBPercentTotalPremium` is a
separate field and is blank for dental plans. The adapter sums child self-only Rate PUF
premiums and applies the filed dental fraction once to the sum. Adult dental premiums never
enter this pediatric amount. It uses the complete county/ZIP on-Exchange dental offer set,
child-eligible offers, the selected rating area and coverage-date interval. Duplicate base
plans do not create extra offers. Missing/unsupported child rates, conflicting allocations
or an absent offer set leave the benchmark unresolved.

Medical pediatric coverage evidence comes from the four Benefits PUF rows `Dental Check-Up
for Children`, `Basic Dental Care - Child`, `Major Dental Care - Child`, and `Orthodontia - Child`, checking `IsEHB`
and `IsCovered` consistently across variants. A missing row, mixed coverage, or missing/conflicting
EHB marker yields `requires_benchmark_adjustments`, naming the missing evidence. Absent SADP
allocation names **`EHBPediatricDentalApportionmentQuantity_missing_or_conflicting`**; it never
substitutes 1 or 0. Both dental allocation/rate provenance and medical benefit provenance are
returned with the benchmark. This conservative adapter supports the complete, uniform pediatric
benefit cases; partial dental benefit packages require further allocation evidence.

The synthetic offline/API fixture follows the regulation's example: a parent and 10-year-old;
silver EHB premiums $650 (includes dental), $620 and $590 (exclude dental); dental child rates
$50 × .4 = $20 and $40 × .375 = $15. The second dental allocation is $20. Adjusted silver
options are **$650, $640, $610**, so the benchmark is **$640**, not $620 or $670. These are
explicitly synthetic PUF-shaped rows created in rolled-back test transactions. A dental-ignoring
mutant returns $620 and fails the identical $640 assertion.

The credit remains capped at the **enrollment premium**, specifically its **EHB portion**.
§1.36B-3(d)(1) supplies the lesser-of rule; (j)(1) excludes additional non-EHB benefits from
**both enrollment and benchmark** premiums. Thus $100 gross with 90% EHB can absorb at most
$90 credit, leaving $10 payable. The gross quote stays $100. Missing enrollment allocation
returns null applied credit/net and `requires_premium_adjustments`, rather than assuming gross
is all eligible. `netPremium`'s two-argument default is only for explicitly all-EHB premiums;
the API always supplies the allocated enrollment premium. No actual SADP enrollment is requested
by this API, so it does not add a hypothetical dental enrollment premium to the cap. Actual
combined enrollment would need the separate allocation specified in (k).

## P5c real HTTP acceptance evidence

Run `npm run build`, then `OPENPLANS_PGLITE_DIR=/absolute/private/prepared/pglite
node tests/api/subsidy-realdata.mjs` from `openplans/`. The server binds only 127.0.0.1,
uses an in-memory, unlogged token and shuts down after the checks. It does not download files
or change source data. On 2026-11-07 this ran against
`$OPENPLANS_DATA_DIR/puf-pglite-p5c-subsidy-api`, a private filesystem clone of
the prepared real P5b DB. Full output: `$OPENPLANS_DATA_DIR/reports/p5c-subsidy-http.json`.
Enrollment rate rows at age 40: `11718TX0140016` **1847763**, `20069TX0100006`
**1857351**, `87226TX0100013` **2035443**. Their respective Plan Attributes
rows **15440–15443**, **15507–15513**, **19663–19666** all file EHB fraction **1**,
so the enrollment cap equals gross in these three real examples.
Trimmed HTTP response fields (all amounts cents; household inputs synthetic):

```json
{
  "single": {
    "ages": [40], "income": 31300, "benchmark_status": "calculated",
    "silver_plan_count": 46, "slcsp": 59176, "annual_contribution": 206600,
    "monthly_contribution": 17200, "household_credit": 41976,
    "estimates": [
      {"plan_id":"11718TX0140016","gross":39676,"credit":39676,"net":0},
      {"plan_id":"20069TX0100006","gross":75874,"credit":41976,"net":33898},
      {"plan_id":"87226TX0100013","gross":55354,"credit":41976,"net":13378}
    ]
  },
  "family": {
    "ages": [40,40,10], "income": 53300, "benchmark_status": "calculated",
    "dental_adjustment": 1282, "dental_plan_id": "23891TX0010006",
    "slcsp": 155055, "annual_contribution": 351800,
    "monthly_contribution": 29300, "household_credit": 125755,
    "estimates": [
      {"plan_id":"11718TX0140016","gross":103101,"credit":103101,"net":0},
      {"plan_id":"20069TX0100006","gross":197166,"credit":125755,"net":71411},
      {"plan_id":"87226TX0100013","gross":143842,"credit":125755,"net":18087}
    ]
  },
  "passed": true
}
```

Family dental trace: cheapest `26250TX0070006`, age 0–14 rate row **1890883** = 916¢,
allocation **1** from Plan Attributes rows **16101–16102**. Second `23891TX0010006`,
rate row **1881295** = 1,282¢, allocation **1**, attribute row **16094**. The lowest
medical option `27248TX0010019` is 58,621 + 58,621 + 35,090 = 152,332¢; adjusted =
153,614¢. Second option `87226TX0140004` is 61,443 + 61,443 + 36,779 = 159,665¢;
× .9631 = 153,773.3615¢ → 153,773¢; + 1,282¢ = **155,055¢**.
The medical child rate is source row **2036029**; the cheapest option's child rate is row **1892311**.
$53,300 / $26,650 = 200% FPL; × .066 = $3,517.80 → $3,518 annually → $293 monthly.
155,055 − 29,300 = **125,755¢**, before applying the enrollment EHB cap.
