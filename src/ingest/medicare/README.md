# Medicare ingest

`worker ingest medicare acquire|import --year YYYY [--family F] [--service-area-month YYYY-MM]`.
The [Medicare guide](../../../docs/medicare.md) covers the routes and the data model.

## Acquisition

Archives come from `https://www.cms.gov/files/zip/`. The worker reads listing pages without query
strings, because www.cms.gov robots.txt disallows `/*?`. The contract service-area listings page
only through query strings, so the worker names those archives by report month. Every request in a
job goes through one `AdmissionSession`. It reads robots first, checks the terms hash and waits at
least 10 s between requests to www.cms.gov.

The shipped manifest's www.cms.gov entry covers the Exchange public use files and names their
disclaimer as its terms. Medicare collection therefore needs an operator manifest entry for
www.cms.gov. Its `permittedPaths` list the Medicare archives and listing pages, and its terms review
names the CMS.gov "Link to Us" page, which says "It is a public domain web site." An operator entry
replaces the shipped entry for the same host, so keep it to Medicare jobs.

## Import

| Module            | Reads                                                                            | Writes                                                                              |
| ----------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `county-codes.ts` | `PDP_Cnty_SA_*.csv`, `MA_Cnty_SA_*.csv`                                          | `medicare_county_code`                                                              |
| `landscape.ts`    | `CY*_Landscape_*.csv`, header checked against each audited release               | `medicare_plan`, `medicare_plan_county`                                             |
| `pbp.ts`          | PBP `.txt` tables, their `.sas` layouts and the dictionary workbook              | `medicare_pbp_row`, `medicare_pbp_field`, `medicare_pbp_plan`, `medicare_plan_area` |
| `stars.ts`        | Star Ratings "Summary Ratings", CSV or the workbook when CMS publishes only that | `medicare_star_rating`                                                              |
| `crosswalk.ts`    | `PlanCrosswalk*.txt`                                                             | `medicare_plan_crosswalk`                                                           |

Timings on the CY2026 and CY2027 releases, PGlite on Apple silicon: Landscape loads 138,260 and
130,315 rows in 30 to 46 s and every county row resolves to a FIPS code. PBP 2026 takes 2.5 min.
Its PlanArea has 2,297,167 rows and 2,164,720 of them are employer group rows the import skips.

`tests/fixtures/medicare/regenerate.py` cuts the fixtures byte for byte from the real archives.
`provenance.json` records each source hash.
