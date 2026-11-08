# Cited individual medical rating rules

Each year file lists the states discovered in that year's acquired Plan Attributes
PUF with on-exchange individual medical rows, plus explicit unsupported NY/VT guards.
The 2026 publication lists 30 states; 2027 lists 29 (Oregon is absent).

Reviewed 2026-11-07:

- [CMS Market Rating Reforms](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating),
  current table updated 2021-12-10: the individual-market columns identify age-curve,
  tobacco and family-tier exceptions; unlisted/blank cells use federal defaults.
- [45 CFR 147.102](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.102),
  eCFR current through 2026-11-05: (c)(1) sums member rates with the three-oldest-covered-
  children-under-21 cap; (c)(2) permits community-rating family tiers; (d)/(e) describe
  age bands and state curves. The section's displayed amendment history ends in 2018.
- [CMS State Specific Age Curve Variations](https://www.cms.gov/CCIIO/Programs-and-Initiatives/Health-Insurance-Market-Reforms/Downloads/StateSpecAgeCrv053117.pdf),
  the CMS page's currently linked 2018-effective document (dated 2017-05-31), including
  AL individual, MS, OR and UT curves. CMS does not label this a PY2026/PY2027 document.

These sources support using **filed age rows**, not calculating rates from an assumed
curve. The current CMS table and regulation were reviewed for both requested years;
re-review when guidance or regulation changes. No source date is relabelled as 2026/2027.
Every entry names the reviewed state row and the federal child-count provision.

Family Option rows in AK/MI/UT/NH (2026) are preserved and counted in the raw oracle;
no rule in these files authorizes tier selection. Their presence does not authorize
pricing tiers as member rates. Dental and SHOP remain outside this rule grant.
NY/VT can never be assigned `per_member` by this importer; absent evidence returns
`unsupported_rating_method`. A separate cited household-to-tier adapter is needed.

The existing no-file `worker ingest rating-rules` command remains the TX PY2026
bootstrap in `default-tx.json`. Use `worker ingest rating-rules --file
data/rating-rules/2026.json` (or 2027) to activate the complete year set. The importer
replaces the rule set atomically. Rerunning the TX bootstrap after an all-state load
revokes other 2026 states. This compatibility behavior preserves the original
no-file scope; all-state ingestion and validation always select the year file.

P8a adds `community-family-2026.json`, a **separate schema** for the NY/VT pure
community adapter. It records state-source tiers, nominal multipliers and the
supported household mapping. Do not pass it to `ingest rating-rules`, whose v1
schema still authorizes only the existing per-member API. Public state rates now
exist in the staging adapter; the unsupported NY/VT entries in `2026.json` explain
that native catalog/API integration is still missing. Public rates are available. No 2027 authorization is inferred. See `src/ingest/state/README.md`.
