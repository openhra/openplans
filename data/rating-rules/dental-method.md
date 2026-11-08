# SADP filed rates, method sadp-filed-v1

Reviewed 2026-11-07 for PY2026/PY2027 individual-market dental in the explicitly
listed federal PUF state/year scopes in `src/domain/rating/dental.ts`. This is
separate policy from the medical `rating-rules-v1` documents and does not activate
medical rules for dental. There is no database migration or new ingestion command.
A complete active PUF catalog, geography, plan attributes and business rules are
required. SHOP and states outside this scope, including NY/VT dental, remain
unsupported even when a caller supplies federal-looking rows.

## Sources and interpretation

- [45 CFR 148.220 introductory paragraph and (b)(1)](https://www.ecfr.gov/current/title-45/section-148.220)
  exempts qualifying separately insured limited-scope dental from Part 147. Thus
  [147.102](https://www.ecfr.gov/current/title-45/section-147.102), including its
  medical age curve and child cap, does not itself authorize SADP rating.
- [45 CFR 156.210(d), 2025 published CFR](https://www.govinfo.gov/content/pkg/CFR-2025-title45-vol2/pdf/CFR-2025-title45-vol2-sec156-210.pdf)
  requires SADP age determination at issuance/renewal and guaranteed rates from
  PY2024 onward. The calculation uses completed age at coverage start.
- [CMS Rate PUF dictionary, PY2014–2027, pp. 4, 6–8](https://www.cms.gov/files/document/rate-ratadictionary-py27.pdf)
  defines age-based and Family Option rows, the individual price, and the seven
  family columns. No Preference applies to both tobacco inputs; the separate
  tobacco price applies only to the dual tobacco category. This dental adapter
  follows those fields without changing the existing medical tobacco contract.
- [CMS Business Rules dictionary, pp. 5–6, 8](https://www.cms.gov/files/document/businessrules-datadictionary-py27.pdf)
  defines MaximumUnderageDependent, DependentMaximumAgRule, AgeDeterminationRule
  and CohabitationRule. MaximumUnderageDependent is the filed limit on rated
  underage dependents. The allowed 1/2/3 count is required for the age-based
  adapter, which uses the existing per-member oldest-under-21 selection path.
  This is a filed plan limit, not a presumed Part 147 mandate. Relationship
  entries indicate permitted relationships; Yes/No indicates required
  cohabitation, not whether the relationship is permitted.
- [CMS Plan Attributes dictionary, p. 11](https://www.cms.gov/files/document/planattributes-datadictionary-py27.pdf)
  identifies EHBPediatricDentalApportionmentQuantity as a dental field, expressed
  as a percentage from PY2017 onward. Raw filings here express it as a decimal
  fraction. EHBPercentTotalPremium is a medical field and is not used for SADPs.
- [CMS Exchange PUF publication](https://www.cms.gov/marketplace/resources/data/public-use-files)
  defines the federal publication scope and includes certified off-exchange
  SADPs. Explicit state/year lists mirror the publication-listed catalog scope;
  they are not an inference that a state's medical rating policy applies to dental.

## Supported household mapping

Only the API's explicit subscriber, spouse and child relationships are mapped.
The caller's spouse is a secondary subscriber; declared children are dependents.
The dictionary does not prove how `other`, multiple primary subscribers or
child-only Family Option contracts map. Those cases return
`unsupported_rating_method` with a reason. Minor Family Option subscribers also
remain unsupported. Dependent ages must fit the filed maximum (inclusive).
Required cohabitation cannot be established by this API's input and is unsupported;
missing, conflicting or absent relationship entries cannot establish membership.

| Household | Filed Rate PUF column |
|---|---|
| One primary subscriber, no dependents | IndividualRate |
| Primary subscriber and spouse, no dependents | Couple |
| Primary subscriber and one child dependent | PrimarySubscriberAndOneDependent |
| Primary subscriber and two child dependents | PrimarySubscriberAndTwoDependents |
| Primary subscriber and at least three child dependents | PrimarySubscriberAndThreeOrMoreDependents |
| Primary subscriber, spouse, one child dependent | CoupleAndOneDependent |
| Primary subscriber, spouse, two child dependents | CoupleAndTwoDependents |
| Primary subscriber, spouse, at least three child dependents | CoupleAndThreeOrMoreDependents |

Family columns are used only when Age is Family Option. Populated family columns
on an age row, mixed methods and unsupported composite methods fail closed.
A missing filed price is unknown; conflicting rows are ambiguous. Nothing
multiplies a single price to invent a family premium. Family Option rows may use
No Preference or leave Tobacco blank, as NH does: these columns define contract
totals and IndividualTobaccoRate applies only to age rows. Dual-tobacco family
rows or separate tobacco prices are unsupported because no household tobacco
mapping is defined in these columns. Source row/date/area evidence is
retained; family totals have no invented per-member breakdown.

Age rows reuse the per-member selector and household sum, with the dental filed
child limit and dictionary-defined No Preference semantics. The API also checks
ChildOnlyOffering. A child-only age-based household is supported; this is distinct
from an unproved child-only family tier. This is an estimate for the declared
covered members, not an enrollment or dependency determination.

## Native response and EHB

`POST /v1/premium-estimates` accepts SADP base/variant IDs through the existing
validation/authentication path. Estimates contain `coverage: dental`,
`bindable_quote: false`, the filed method, rate-row evidence, cited dental policy
and filed business-rule evidence. Gross dental is independent of medical quotes.

For rated per-member households, pediatric gross is the sum of charged members
under 19, followed by the exact filed pediatric fraction, rounded once to cents
using the existing subsidy allocation helper. At 19 and above the pediatric EHB
portion is zero. Missing, malformed or disagreeing fractions produce an unknown
EHB allocation without losing a valid gross price. Family Option households with
children preserve the fraction as evidence, but a pediatric dollar amount remains
unknown because the filed family price has no member allocation. No medical
EHB percentage or zero is substituted. The subsidy enrollment allocator is still
medical-only; allocating APTC between medical and SADP enrollment is follow-up work.

## Reproduce the independent check

```sh
npm run build
node scripts/oracle/dental.mjs
```

This uses only SHA/byte-verified acquired CMS archives in OPENPLANS_DATA_DIR. It
owns `puf-pglite-p5e-dental`, not another lane's database. Python's CSV reader and
Decimal generate expectations without importing application code; the Node runner
compares the persisted cents through the production dental adapter. Every TX SADP
row is checked, including explicit unsupported SHOP rows. All age-band equivalence
classes, both tobacco flags and both interval boundaries are covered. Five
mixed-age households per group exercise the sum, child cap and EHB arithmetic.
Arbitrarily many households cannot be literally enumerated: this is a finite
basis of the supported member-selection, addition and cap rules, not that claim.

TX2026 has no Family Option rows. The same check covers every non-TX SADP Family
Option row, independently checking all eight columns with three and four children.
A temporary compiled-source mutation maps the two-dependent suffix to the
three-or-more suffix. The identical comparison detects that defect against a real
published row with distinct prices. Offline tests also plant this mutation with
labelled synthetic prices. NY/VT federal-row relabellings must remain unsupported.

Results, mismatches, controls and three real Harris HTTP examples are written to
`OPENPLANS_DATA_DIR/reports/p5e-dental.json` and `p5e-dental.md`. This oracle is an
explicit real-data check, not part of offline CI; no script outside the lane lease
was modified to invoke it.
