# ICHRA affordability parameters, retrieved 2026-11-09

One file per calendar year in which an individual coverage HRA plan year begins. Every value has
a `value` and `citations` wrapper, and the files are validated by `ichraParameterErrors` without
network access. `src/domain/ichra/generated.ts` embeds them; rebuild it with
`node scripts/ichra/build.mjs` after an edit (a test fails when it is stale).

The required contribution percentage is not copied here. It is read from
`data/subsidy/<year>.json` (`requiredContributionPercentageBasisPoints`), so it has one source:

| Plan years beginning in | Required contribution percentage | Source |
|---|---|---|
| 2026 | 9.96% | [IRS Rev. Proc. 2025-25, s.3.02](https://www.irs.gov/pub/irs-drop/rp-25-25.pdf) |
| 2027 | 10.22% | [IRS Rev. Proc. 2026-26, s.3.02](https://www.irs.gov/pub/irs-drop/rp-26-26.pdf) |

The one-person poverty lines for the poverty-line safe harbor also come from the subsidy tables,
by guideline year, including the Alaska and Hawaii tables:

| Guideline | In effect from | 48 states + DC | Alaska | Hawaii | Source |
|---|---|---|---|---|---|
| 2025 | 2025-01-15 | $15,650 | $19,550 | $17,990 | [HHS, 90 FR 5917](https://www.govinfo.gov/content/pkg/FR-2025-01-17/html/2025-01377.htm) |
| 2026 | 2026-01-13 | $15,960 | $19,950 | $18,360 | [HHS, 91 FR 1797](https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm) |

The guideline used is the newest one in effect on the first day of the plan year. If a newer
guideline may already be in effect but is not on file, the guideline in effect six months before
the plan year is used, as the 2014 final rule allows
([79 FR 8544, preamble VIII.D](https://www.govinfo.gov/content/pkg/FR-2014-02-12/html/2014-03082.htm));
otherwise the answer is `unknown` (`fpl_guideline_not_in_effect`). Guidelines for a year are
assumed never to take effect before January 1 of that year.

## Rules and their status

| Rule | Status | Source |
|---|---|---|
| Affordability, required HRA contribution, premium adjustments, monthly HRA amount | final | [26 CFR 1.36B-2(c)(5)](https://www.ecfr.gov/current/title-26/section-1.36B-2) |
| W-2, rate of pay and poverty-line measures | final for employer coverage, (e)(2)(ii)-(iv); applied to individual coverage HRAs by the proposed (f)(5) | [26 CFR 54.4980H-5](https://www.ecfr.gov/current/title-26/section-54.4980H-5), [REG-136401-18](https://www.federalregister.gov/documents/2019/09/30/2019-20034/application-of-the-employer-shared-responsibility-provisions-and-certain-nondiscrimination-rules-to) |
| Location, age, lowest age band, look-back month | proposed; reliance permitted | REG-136401-18, prop. 54.4980H-5(f)(4), (f)(6), (f)(7) |

`proposed_reliance_permitted` means the text is a proposed rule. Its preamble (84 FR 51484) lets
taxpayers rely on it for plan years beginning before six months after final rules are published.
eCFR 54.4980H-5 had no paragraph (f) on 2026-11-05. When final rules appear, these files change
and the status becomes `final`.

The employer safe harbors apply to section 4980H(b) only. They never change whether the employee
can claim the premium tax credit, and responses mark each verdict with its purpose.

## Premium basis

`lcspPremiumBasisDefault` is `gross`: 26 CFR 1.36B-2(c)(5)(ii)(A) uses the monthly premium of the
lowest cost silver plan, and (c)(5)(iii)(A) lists the only premium adjustments. The figure from
the essential-health-benefits portion of the premium is also computed and can be selected.
