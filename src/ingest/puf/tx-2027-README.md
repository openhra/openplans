# TX PY2027 catalog, rates and rules

The cached CMS 2027 inputs acquired on 2026-11-07 imported as ACTIVE. The import reused cached source
archives and kept them outside the repository. Validation uses portable
PGlite SQL. This lane did not run the production PostgreSQL/PostGIS worker.

## Header audit

`python3 src/ingest/puf/import-header-audit.py` regenerates the eight-file comparison
in `tests/fixtures/puf/headers-2026-2027.json` from the acquisition cache, verifying
archive hashes. PY2027 Plan Attributes adds `AdultDentalServicesWaitingPeriod` and
`WaitingPeriodDuration`. Both are required for a 2027 import and retained verbatim in
`plan_attribute.raw`; blank or conditional waiting-period text is never interpreted
as a benefit assertion. The remaining five catalog CSV schemas are unchanged.

The crosswalk rolls its prior/current year suffixes forward (12 additions and 12
removals), explicitly outside the six-file catalog import. The MR URL XLSX header is
unchanged and belongs to the separate QHP ingestion lane. The audit reads only its
header. No MR contact values enter the artifact. Fixtures are unmodified small real
cuts with hashes and source line provenance; regenerate them with
`python3 tests/fixtures/puf/import/regenerate.py --year 2027`.

Required-column failures name the file kind, year and missing column in the import
report and quality issue, quarantine the replacement and preserve the ACTIVE pointer.

## Rating rules and areas

`data/rating-rules/2027.json` authorizes TX individual medical per-member summation
using filed rate rows only. [45 CFR 147.102(c)(1), (d)](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.102)
was retrieved 2026-11-07; eCFR identified Title 45 as current through 2026-11-05.
The same per-member and three-oldest-children-under-21 methodology applies to 2027
under that retrieved text. No pending change to that method was indicated on the
section page. This is an as-of review; a later regulatory change requires review.
No default age curve, fabricated rate, dental support or SHOP support is introduced.

The [CMS TX geographic rating-area table](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/tx-gra)
was refreshed on 2026-11-07. Its SHA-256 is unchanged from P1b:
`c1ac46907b43ec9d22a30060a72e3b1b3d651652ef96021da78b007ebb27cb8f`.
All 254 county mappings and 27 areas match; Harris remains Area 10. CMS labels the
page last modified 2024-09-10 and provides no year-specific table. The existing geo
importer associates this immutable snapshot with 2027 as `current_cms_table`. No
new table or geo source code change was needed. Refresh evidence is saved in the
external cache at `reports/p6b-rating-areas-2027.json`.

## Real-data evidence

Run `scripts/realdata.sh --year 2027`; omit `--year` to validate both years. The
2027 persistent database is `OPENPLANS_DATA_DIR/puf-pglite-2027`, separate from the
legacy 2026 validation DB. Reports are under `OPENPLANS_DATA_DIR/reports/`:
`2026-11-07-validation-2027.{json,md}` and
`puf-2027-TX-12bb8e4b-7c6f-49e3-8e71-0a0726ad5bef.{json,md}`.

| Imported relation          |    Rows |
| -------------------------- | ------: |
| Base plans                 |     972 |
| Variants / plan attributes |   4,556 |
| Service-area rows          |   1,856 |
| Networks                   |      43 |
| Business rules             |     972 |
| Rates                      | 223,533 |
| Benefits                   | 303,839 |

| Check                         | Result | Evidence                                                            |
| ----------------------------- | ------ | ------------------------------------------------------------------- |
| Counts and IDs vs raw         | PASS   | 972 bases; 4,556 variants; 223,533 rates; 1,856 service-area rows   |
| Every filed rate reproduced   | PASS   | 223,533 rows; 569,790 age/tobacco comparisons; zero mismatches      |
| Harris County plan set vs raw | PASS   | 140 on-exchange individual medical plans                            |
| Disposable real-data controls | PASS   | +1 cent 2027 rate, statewide flag loss, truncated JSON all detected |

Offline controls also rename `IndividualRate` in a 2027 fixture and observe
a named-column quarantine, and request a 2027 premium while its temporary rule file
is absent. The latter returns `unsupported_rating_method` even after 2026 support
has been loaded; adding the cited 2027 document enables a filed-rate estimate.

## Year-over-year method

The generated comparison below covers individual on-exchange medical base plans.
Age-40 premiums are non-tobacco filed rates effective January 1, once per base plan
and rating area. Changes compare cross-sectional medians, not renewals of matched
plans or equivalent benefits. Even-size medians can fall on half cents. The separate
JSON includes full-catalog counts and source hashes. Regenerate with
`python3 scripts/oracle/year-over-year.py`.

Medical issuer 11819 (Antidote Health of TX) enters; 17933 (Moda), 40788 (Baylor Scott
and White) and 76589 (Cigna) leave. The full catalog also gains 55409 (Cigna), which
is dental; the Cigna brand is therefore still present in 2027.

| Metal           | 2026 medical plans | 2027 medical plans |
| --------------- | -----------------: | -----------------: |
| Bronze          |                 43 |                  8 |
| Catastrophic    |                 29 |                 70 |
| Expanded Bronze |                182 |                186 |
| Gold            |                277 |                310 |
| Silver          |                303 |                333 |

| Rating area    | 2026 plans | 2027 plans | 2026 median ($) | 2027 median ($) | Change ($) | Change (%) |
| -------------- | ---------: | ---------: | --------------: | --------------: | ---------: | ---------: |
| Rating Area 1  |         40 |         35 |         843.155 |          887.44 |     44.285 |       5.25 |
| Rating Area 2  |         54 |         50 |          731.76 |          781.49 |      49.73 |        6.8 |
| Rating Area 3  |        145 |        171 |          652.32 |          752.51 |     100.19 |      15.36 |
| Rating Area 4  |        105 |        116 |          612.39 |           665.5 |      53.11 |       8.67 |
| Rating Area 5  |         94 |        135 |         637.325 |          685.37 |     48.045 |       7.54 |
| Rating Area 6  |         67 |         64 |          661.26 |          676.24 |      14.98 |       2.27 |
| Rating Area 7  |         66 |        100 |         671.295 |         687.115 |      15.82 |       2.36 |
| Rating Area 8  |        138 |        137 |          690.41 |          746.57 |      56.16 |       8.13 |
| Rating Area 9  |        119 |        145 |          656.01 |          713.59 |      57.58 |       8.78 |
| Rating Area 10 |        121 |        140 |          646.92 |         720.815 |     73.895 |      11.42 |
| Rating Area 11 |         55 |         50 |          708.75 |         819.565 |    110.815 |      15.64 |
| Rating Area 12 |         57 |         91 |          658.18 |          824.92 |     166.74 |      25.33 |
| Rating Area 13 |         61 |         66 |          631.75 |         667.115 |     35.365 |        5.6 |
| Rating Area 14 |         74 |         56 |          732.62 |         843.995 |    111.375 |       15.2 |
| Rating Area 15 |         94 |        135 |         617.895 |          647.27 |     29.375 |       4.75 |
| Rating Area 16 |         54 |         50 |         642.035 |           689.1 |     47.065 |       7.33 |
| Rating Area 17 |         54 |         50 |          919.88 |          964.48 |       44.6 |       4.85 |
| Rating Area 18 |        141 |        184 |          616.33 |          707.89 |      91.56 |      14.86 |
| Rating Area 19 |         69 |         64 |          758.12 |         804.345 |     46.225 |        6.1 |
| Rating Area 20 |         59 |         64 |          716.56 |          771.77 |      55.21 |        7.7 |
| Rating Area 21 |         61 |         66 |          672.12 |         688.385 |     16.265 |       2.42 |
| Rating Area 22 |         59 |         87 |          732.28 |          757.73 |      25.45 |       3.48 |
| Rating Area 23 |         44 |         40 |          692.78 |         716.775 |     23.995 |       3.46 |
| Rating Area 24 |         66 |         64 |         644.115 |         743.645 |      99.53 |      15.45 |
| Rating Area 25 |        137 |        133 |          717.79 |          768.06 |      50.27 |        7.0 |
| Rating Area 26 |        112 |        143 |          653.28 |           718.2 |      64.92 |       9.94 |
| Rating Area 27 |        117 |        137 |          665.78 |           741.7 |      75.92 |       11.4 |
