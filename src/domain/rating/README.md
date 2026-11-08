`parseRateRow(raw, provenance, method?)` converts the published CMS CSV fields to
integer cents while retaining the raw record, its interval, all family columns,
and source identity. Blank prices become `null`; malformed decimals/dates/age
bands throw. Supply `method` when business rules identify composite rating.
Family Option or populated family-tier columns always require a separate adapter.

`selectRateRow(rows, planId, ratingAreaId, age, tobaccoUse, date)` matches the
exact identifiers and business year, inclusive date interval, and CMS age band.
It returns `selected`, `missing`, `ambiguous`, or `unsupported_rating_method`.
Duplicates are ambiguous even if their amounts agree. A blank CMS Tobacco field
does not establish applicability. Both published nonblank Tobacco categories
apply to either tobacco input; choosing the price happens after row selection.

`householdPremium(rows, planId, ratingAreaId, household)` supports only an
explicit `household.ratingMethod: 'per_member'`. Resolve the state's method,
service-area eligibility and rating area upstream. It computes gross USD per
month, never a subsidy or net premium. Every charged member must have a unique
row and the relevant price: tobacco users require `IndividualTobaccoRate` even
on a No Preference row. Missing tobacco evidence returns `unknown`; it never
substitutes `IndividualRate`. All failures have `totalCents: null`; member issues
and rows remain available. With multiple failures, the top-level status is the
first member's failure in input order; inspect `issues` for the complete set.

Members provide either completed `age` on `coverageStartDate` or `dateOfBirth`,
an ID, relationship (`subscriber`, `spouse`, `child`, `other`), and `tobaccoUse`.
Only the three oldest members with relationship `child` and age below 21 are
charged; a child aged 21 is charged outside that cap. Equal completed ages use
DOB when both are known, then input order. A Feb 29 birthday advances on March 1
in non-leap years. Invalid input (including an empty household) throws; valid
inputs with unavailable rates produce typed failure results. Results retain
member calculations and the rate rows used, including provenance. Uncharged
children need no rate row. Inputs are never mutated; this module performs no I/O.

`communityFamilyPremium(rule, rate, members, coverageStart)` is the separate
NY/VT PY2026 `community_family_tier` adapter. It selects four explicit filed-tier
prices using the cited state's household mapping; age and tobacco do not price
members. Nominal multipliers remain in the trace. It uses filed prices to retain
issuer rounding, and returns unsupported for child-only policies, unproved adult
dependent extensions, absent rules and unsupported relationships. The existing
per-member engine now also rejects NY/VT state rows even if a caller labels them
per-member. See `src/ingest/state/README.md` for sources, supported subset, staging,
and the outstanding native API integration.
