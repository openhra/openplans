# NY / VT individual community rating, PY2026

Surveyed 2026-11-07. Public rate publications exist for both states. P8a supplies
source preparation, staging, and the pure filed-tier calculator. P8c connects the
staged catalog to the API repository, filed-tier quotes, and data availability.
NY HIOS base IDs work through native premium HTTP. VT keeps issuer + published
plan name keys; `plan_keys` requests select its filed tiers. Supplemental CMS SBE
identity evidence supplies `hios_id` only for a unique exact match under the rule
below. Matched base HIOS IDs also work in native `plan_ids` requests and detail
routes. An absent or ambiguous match keeps `hios_id: null`.
The ingestion command continues to report `STAGED`: staging alone does not prove
native HTTP readiness.

## Source survey

No credentials, cookies, login sessions, captcha solvers, or alternate access
paths were used. Ordinary anonymous HTTPS requests reached every publication
used below. A web-search proxy sometimes returned 403 for Vermont pages that
ordinary Python HTTPS requests reached with status 200; the actual acquisition
results, original bytes, and SHA-256 records are in the external data cache.

| Candidate | Format and plan-level rates | Access observed | Terms / use decision |
| --- | --- | --- | --- |
| [NY DFS additional information, 2026](https://myportal.dfs.ny.gov/web/prior-approval/ind-and-sg-medical/additional-information-2026) | HTML listing with separate **Proposed Rates** and **Approved Rates** links. Approved files are BIFF8 XLS, OOXML XLSM, or ZIPs containing those workbooks. HIOS base IDs, rating areas, effective dates, and all family prices are present. **Used: approved templates for 12 on-exchange issuers**, including any off-exchange individual products present in those files. Exchange eligibility is unknown in the rate file. | HTTP 200; no login/captcha. All 12 approved-template URLs are enumerated in `prepare.py`. | Public download, with [DFS website privacy policy](https://www.dfs.ny.gov/privacy). The listing states no dataset-specific reuse licence. Retain publisher/URL/hash/cell provenance; this is not a claim of an open licence for entire filing documents. Only factual rate cells are retained in fixtures. |
| [NY DFS 2026 final exhibits](https://myportal.dfs.ny.gov/web/prior-approval/2026-final-exhibits) | ZIPs of XLSM exhibits; Exhibit 23 has variant IDs and regional subscriber rates. **Not a pricing source:** MetroPlus's final Exhibit 23 says $784.45 for `11177NY0010001-01`; its approved rate template says $784.51 for the base plan. Final-exhibit filenames also retain their original submission dates. | HTTP 200, no login/captcha. | Same DFS public-download qualification above. Survey only; do not replace approved tier cells with Exhibit 23 base rates. |
| [NY DFS requested/approved rate-action summary](https://myportal.dfs.ny.gov/web/prior-approval/ind-and-sg-medical/summary-of-2026-requested-rate-actions) | HTML aggregate percentage changes per issuer, **not plan premiums**. | HTTP 200, no login/captcha. | DFS policy above. Discovery only. Never apply an issuer's average percentage change to individual plans. |
| [NY State of Health 2026 plans](https://info.nystateofhealth.ny.gov/2026plans), [individual shopping](https://nystateofhealth.ny.gov/individual/) | Plan information and an interactive comparison tool, rather than a bulk rate file found in this survey. [DOH's enrollment announcement](https://www.health.ny.gov/press/releases/2025/2025-11-06_open_enrollment.htm) links the shopping tool. | `/2026plans` returned 403 to anonymous HTTP. Whether its current shopping workflow requires login/captcha was not established. Not used. | No shopping-session terms accepted; no private endpoints or access-control workarounds used. |
| [NY annual health insurance premiums dataset](https://catalog.data.gov/dataset/health-insurance-premiums-on-policies-written-in-new-york-annually) | Machine-readable aggregate written premiums; **not individual plan-level monthly rates**. | Public catalog; no rate acquisition attempted. | Consult the dataset's own metadata for its reuse terms; outside the selected source set. |
| [Vermont Health Connect plan designs and rates](https://info.healthconnect.vermont.gov/compare-plans/qualified-health-plans/plan-designs-and-rates), [2026 final rate sheet](https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_PlanDesigns_FinalRates.pdf) | Text PDF, not CSV/XLS. A reproducible, checksum-pinned table extraction supplies **26 named plan designs × 4 explicit tier prices**, 13 per issuer. No HIOS IDs are printed. **Used**, retaining issuer + published plan name as an internal key, never manufacturing a HIOS ID. | HTTP 200 for listing/PDF, no login/captcha. | VHC links [Vermont website policies](https://www.vermont.gov/policies/privacy). No dataset-specific reuse licence stated on the listing/PDF. Attribute VHC, retain provenance, extract only factual rate cells. Do not infer unrestricted reuse rights for the document. |
| [VHC enhanced Silver sheet](https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_CSR_Plan_Designs.pdf), [catastrophic sheet](https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_Catastrophic_Plans.pdf) | Separately linked PDF publications for benefit/eligibility-specific products. **Not imported** in this adapter; no CSR mapping or catastrophic eligibility is inferred. | Public links on the anonymous rate listing; no login/captcha encountered there. Separate workflows were not exercised. | VHC policy qualification above. The 26-plan import is explicitly the main final-rate sheet, not a claim of every Vermont product/variant. |
| [GMCB rate review](https://ratereview.vermont.gov/), [MVP 2026 individual filing](https://ratereview.vermont.gov/content/mvp-health-care-2026-individual-filing) | Public HTML docket, approved with modification 2025-08-22; linked [complete packet](https://ratereview.vermont.gov/sites/dfr/files/documents/MVPH-134522721_2.pdf) is a 485-page PDF. Its glyph mapping does not yield ordinary text in Poppler or pypdf. No uniform CSV/XLS rate export found on that docket. | HTTP 200, no login/captcha, including packet. | Public docket with Vermont policy footer; no dataset-specific licence on the listing. Not used to guess a HIOS/name join. |
| [SERFF NY](https://filingaccess.serff.com/sfa/home/NY), [SERFF VT](https://filingaccess.serff.com/sfa/home/VT) | Filing/binder access could contain plan-level rates and IDs. No filings acquired. | Both anonymous pages returned a robot-verification/JavaScript challenge. **Not used; never bypassed.** Login requirements after that challenge were not tested. | Current NY/VT agreement could not be inspected behind the challenge. The [NAIC SFA agreement reproduced by Kentucky DOI](https://insurance.ky.gov/ppc/Documents/publicaccessinsurancefilingsforproperty.pdf) describes workflow and copyright restrictions; it is not treated as a grant to automate or bypass NY/VT's interface. |

## Rating evidence and scope

`data/rating-rules/community-family-2026.json` is a separate versioned, cited rule
set. `2026.json` retains unsupported authorization for the federal per-member path.
The state API adapter reads only the cited rules pinned to the staged import. No PY2026 rule authorizes PY2027.

- NY: Insurance Law [3231](https://www.nysenate.gov/legislation/laws/ISC/3231) and
  [4317](https://www.nysenate.gov/legislation/laws/ISC/4317), plus 11 NYCRR Part 360
  (Regulation 145, confirmed in [DFS's regulation index](https://www.dfs.ny.gov/industry_guidance/regulations/ins_regs_by_part_number)).
  The actual multipliers are in the [PY2026 filing instructions](https://www.dfs.ny.gov/apps-and-licensing/health-insurers/pa-nysoh-out-nysoh/2026-instruct-filing-premium-rates),
  sections M-N, pp.16-17: single 1, couple 2, parent/children 1.70, family 2.85.
  Child-only products require their own policies and calculation; not supported here.
- VT: [33 V.S.A. 1811(e)-(f)](https://legislature.vermont.gov/statutes/section/33/018/01811)
  governs exchange health benefit plans. The binding tier multipliers are the
  [DFR order, Docket 13-002-I, 2013-03-13](https://dfr.vermont.gov/sites/finreg/files/regbul/dfr-order-docket-13-002-i-vermont-health-benefits-exchange.pdf),
  p.2, effective 2014 and thereafter: 1, 2, 1.93, 2.81. The brief's 8 V.S.A. 4080a
  pointer concerns small groups; it is not the individual exchange tier order.
- Household mapping: one subscriber, optional spouse, and covered child dependents.
  The NY instructions and [individual comprehensive checklist](https://www.dfs.ny.gov/system/files/documents/2024/07/ind-comprehensive-off-exchg-checklist-20240711-fill.pdf)
  support parent/child and family coverage under 26. VT's [2026 issuer guidance](https://dvha.vermont.gov/sites/dvha/files/documents/IssuerGuidanceForParticipation2026.pdf),
  section 2.2, p.11 defines medical enrollment categories; section 2.3 makes the
  service area every Vermont ZIP. Its dental age-21 tiers in section 3.2.1 must not
  be used for medical plans. The [VHC Student FAQ](https://info.healthconnect.vermont.gov/learn-more/student-faq)
  confirms dependent coverage until 26 and possible calendar-year extension.
  This calculator supports children **under 26**. Age-26 extensions, age-29 riders,
  disabled adult dependents, other relationships, and minor subscribers return
  `unsupported_rating_method` pending eligibility evidence. That is not a denial
  of coverage. Eligibility itself remains upstream.
- No age/tobacco price factors: corroborated by the [CMS state-rating table](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating).
  A relationship=child aged 21-25 remains a child in this medical adapter.

**Use the published tier cents.** Do not multiply an already rounded single price:
MetroPlus Bronze `11177NY0010001` has single $784.51 and couple $1,569.01, whereas
2 × the rounded single is $1,569.02. NY component/base rounding can also produce
small differences for other tiers. The nominal state multiplier remains in the
result's rule trace; the approved contract price is selected verbatim. No premium
is synthesized from an age curve, an Exhibit 23 base, or an issuer-average change.

## Reproduction and worker

From `openplans/` (no package additions; preparation uses Python stdlib and, for
VT only, an existing `pdftotext` executable):

```sh
python3 src/ingest/state/prepare.py --state NY --fixtures
python3 src/ingest/state/prepare.py --state VT --fixtures
npm run build
node dist/worker/cli.js ingest state --state NY --file /absolute/cache/derived/state-rating/ny-2026.json
node dist/worker/cli.js ingest state --state VT --file /absolute/cache/derived/state-rating/vt-2026.json
```

Replace `/absolute/cache` above with the absolute cache path reported by preparation.
`--data-dir` / `OPENPLANS_DATA_DIR` changes that external cache location. Reuse
matching cached SHA-256 snapshots; partial downloads are renamed after metadata
is recorded. No downloaded workbooks/PDFs enter the repo. BIFF/OOXML readers inspect
cached cell values only; macros and formulas never execute. The VT extractor
rejects changed PDF bytes before applying the reviewed column labels. The worker
requires the original publication paths and verifies their byte counts/hashes;
`verifyRaw: false` is a test-only library option, never a worker flag.

Preparation produces 1,245 NY family-tier plan/rating-area rows from 12 approved
publications (1,245 distinct keys) and 26 Vermont named designs. NY child-only
age-labelled sheets are skipped, never interpreted as federal per-member rates.
All three dependent-count columns must agree for each of NY's parent/family tiers.
Different date intervals or nonuniform family columns stop preparation. NY geographic availability is the filed rating-area scope, with enrollment
eligibility and exchange status unknown. VT service area is statewide under DVHA
section 2.3. No CSR variant or HIOS/name join is inferred from a rate row.

`620_state_community_rates.sql` stores immutable publication snapshots, raw rate
records, cited rule documents, and an atomic staging pointer. Duplicate plan/area
matches return `ambiguous`, and failed imports preserve the previous pointer.
`stagedStatePremium()` reads this staging catalog; it is not a native HTTP route.

## Vermont HIOS identity join: `vt-hios-exact-v1`

The [CMS VT SBE bundle](https://www.cms.gov/files/zip/vermontsbepuf2026.zip)
provides identity evidence alongside the unchanged filed-tier pricing source.
Migration `860_vt_hios_match.sql` stores one result per filed record, SBE import,
and rule version in `state_vt_hios_match`. Historical results are retained. It
records the original publication snapshot, URL, SHA-256, PDF cell location, issuer,
and name; the normalized tuple; and every candidate base HIOS ID with bundle URL,
SHA-256, attribute member/snapshot, and physical source rows (including variants).
The result is `matched`, `ambiguous`, or `none`, with a reason. No rate or raw
record is updated, and the supplemental SBE catalog is never a pricing pointer.

The rule is scoped to VT and the same plan year:

1. Map the filed issuer labels `BCBSVT` to CMS issuer `13627` and `MVP` to `77566`.
   These are explicit aliases evidenced by the CMS `BCBSVT ...` and `[MVP VT ...]`
   marketing-name families and their published issuer IDs, rather than a fuzzy
   issuer-name search. Unknown issuer labels cannot match.
2. Lowercase names, trim, and collapse whitespace. For issuer `13627`, remove
   only an optional leading `BCBSVT `. For issuer `77566`, rewrite only
   `[MVP VT] ...`, `[MVP VT Plus] ...`, `[MVP VT HDHP] ...`, and
   `[MVP VT Plus HDHP] ...`: remove the brackets and move `HDHP`, if present,
   after the remaining name. Thus `[MVP VT HDHP] Silver 4` equals the filed
   `MVP VT Silver 4 HDHP`. Do not remove `Plan`, CDHP, numbers, or other wording;
   do not change punctuation, expand abbreviations, or use edit distance.
3. The prepared VT sheet has `metal: null`. Derive its metal identity family from
   the single distinct whole-word `Platinum`, `Gold`, `Silver`, or `Bronze` in the
   published plan name. If a separate metal is present it must agree. Map the
   CMS metal `Expanded Bronze` to the Bronze family for identity comparison only.
   Missing/conflicting metal evidence cannot match; no benefit facts are inferred.
4. Compare issuer ID, metal family, and normalized name exactly against CMS
   **Individual, medical, on-exchange-capable** attribute rows. SHOP and dental
   rows, off-exchange-only plans, and other states/years cannot supply an ID.
   Multiple CSR rows with the same base HIOS ID are one candidate. Multiple
   distinct base IDs are `ambiguous`. Multiple filed designs with the same tuple
   are also `ambiguous`, preventing two internal keys from claiming one ID.
   Zero candidates is `none`; never substitute a near name or the first row.

The newest fully ACTIVE VT SBE import (root and all six file snapshots) is the
current identity source, ordered by import start time with import ID as a tie
break. Activation triggers populate the join in either import order; migration
backfills deployments with both sources already installed. Partial/quarantined
imports cannot replace a valid source. `state_vt_hios_current` limits results to
the current state-rate pointer and current SBE set. Re-importing the same inputs
is idempotent for each import pair.

Native plan views and estimates expose `hios_match`, `hios_candidates`, rule,
reason and match provenance when there are candidate identities. With zero
candidates the API keeps a stable `none` / `no_verified_hios_match` response and
null match provenance, so an unrelated supplemental import cannot change it.
The audit table retains the attempted rule, precise reason and source provenance
even for zero candidates. The pricing key remains `plan_key`; HIOS IDs are
lookup aliases. Compatibility searches by key and details by key or HIOS publish
the actual joined HIOS identifier in `identifiers`, never an internal key in a
HIOS field. Compatibility search `ids` filtering still compares internal keys;
HIOS filtering in that separate router requires a follow-up. CSR/benefit evidence
and subsidy eligibility are not granted by an identity match.

For a uniquely matched VT design, the repository also reads the CMS attribute
rows' explicit on/off-exchange flags. Native responses include the attribute
snapshot and physical rows as `provenance.exchange`; the existing compatibility
mapping exposes `on_market`, `off_market` and `plan_market`. This does not change
filed prices, catalog pointers, or enrollment eligibility. With no unique match,
off-exchange availability remains unknown.

`python3 src/ingest/state/offexchange-inventory.py --data-dir /absolute/cache`
writes `reports/p8g-vt-offexchange.md` and JSON outside the repository. The pinned
CMS bundle has 55 base plans, including 28 individual medical plans, all marked
`Both`. Twenty-six match the main filed sheet; the other two are catastrophic.
There are eight individual Silver base designs, but they already match the filed
sheet: none is an additional off-exchange-only identity. All 55 base IDs have PUF
rate cells. The eight additional Silver identities seen in a comparison are
absent from this bundle and cannot be added from these sources. The report labels
this `DATA_GAP`, preserves original source rows and rate cells, and does not claim
that missing identities are absent from the market. No federal age math, new
HIOS IDs, or inferred premiums are supplied. Offline tests label missing-rate
fixtures synthetic and reject an implementation mutant that emits zero.
After `npm run build`, `node src/ingest/state/offexchangecheck.mjs /absolute/cache`
loads the hash-verified real bundle and filed sheet into isolated PGlite, then
checks 26 native and 26 compatibility responses over loopback TCP HTTP and all
104 original tier prices. It writes `reports/p8g-vt-http.json`, leaves the filed
rate rows byte-identical, and makes no production Postgres/PostGIS claim.

From `openplans/`, run `python3 tests/ingest/state/regenerate-hios.py --data-dir
/absolute/data/cache` to regenerate the small, fact-only CMS attribute fixture.
Run `npm run build` then `node src/ingest/state/hioscheck.mjs /absolute/data/cache`
for all 26 real designs, an independent Python CSV identity oracle, 104 native
tier comparisons before/after, HIOS/key aliases, compatibility responses, and
renamed/duplicate negative controls. The check uses an isolated PGlite database
and real TCP HTTP on loopback, with no network downloads; it writes
`reports/p8d-vt-hios.md` and JSON plus byte-comparable premium evidence under
`work/p8d/`. This is not a production Postgres/PostGIS or performance claim.

## Verification

Offline tests use small regenerated real cuts, synthetic households, and labelled
mutants. Hand calculations for NYC `11177NY0220001`, Rating Area 4:
$1,270.98 single; ×2 = $2,541.96 couple; ×1.70 = $2,160.67 parent; ×2.85 = $3,622.29
family of four. A separate Bronze check preserves the filed rounding above.
[CMS identifies NYC's five counties in Rating Area 4](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/ny-gra).
Burlington is in VT's statewide service area: BCBSVT Gold single $1,345.45;
×2 = $2,690.90; ×1.93 = $2,596.72; ×2.81 = $3,780.71.

Run `node src/ingest/state/realcheck.mjs` after the build to reproduce the full
cache/DB/domain check; it writes `reports/p8a-state-rating.json` in the external
data directory and explicitly labels native HTTP checks as not run.

Source acquisition was exercised over real anonymous HTTP, then the entire
prepared corpus was staged with original-file hash checks in PGlite. Those are
source/DB/domain checks, **not** a claim that native HTTP premium estimates work.
Native HTTP accepts VT's distinct `plan_keys` array and `/v1/plans` recognizes
the active state catalog. New York retains its published HIOS base IDs; Vermont
retains its named keys and supplements them only with evidenced HIOS matches.
`nativecheck.mjs` tests actual Postgres/TCP HTTP against the full cached corpus and writes failures as
`PARTIAL`, separately from its explicit VT library checks. Its `--candidate` option
only selects a separate report filename for review-copy testing.
