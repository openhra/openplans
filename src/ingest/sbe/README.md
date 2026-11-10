# CMS state-based exchange catalog

`worker ingest sbe acquire|import --year 2026 --state GA` selects the state ZIP
from the [CMS SBE publication page](https://www.cms.gov/marketplace/resources/data/state-based-public-use-files).
`--all-states` processes every listed bundle independently and returns nonzero on
any failure. `worker bootstrap --states GA --years 2026` selects this adapter
automatically. For SBE-only requests, omitting `--years` selects the reviewed
PY2026 publication, so `worker bootstrap --states GA` also works. Explicit years
take precedence. Federal or mixed requests still require an explicit year. Bootstrap's programmatic graph builder accepts explicit SBE scopes;
its original no-scope acquired-federal-manifest contract remains available.

The reviewed CMS page lists 22 PY2026 bundles and no PY2027 SBE release. Discovery
uses the publication's year sections and explicit state links, never guessed URLs.
Cache-only imports verify acquisition hashes and byte counts; ZIP members are
streamed with bounded inflation, size and CRC verification. Acquisitions and reports
stay below `OPENPLANS_DATA_DIR`; fixtures are regenerable cuts from real GA bytes.

The six files map to the existing immutable catalog tables. Spaced/uppercase
headers map to their canonical spellings; original fields remain in `raw`.
`RATE EXPIRATION` maps to `RateExpirationDate`; ISO and M/D/YYYY dates are parsed
strictly. Boolean TRUE/FALSE and true/false map to Yes/No. County labels supply
their explicit five-digit FIPS suffix. Blank age with filed family amounts maps to
Family Option; every published cent is retained. The importer never fills missing age or tobacco prices,
extrapolates them or calculates them from an age curve.

SBE Benefits CSVs contain coverage/limit evidence but omit the federal copay and
coinsurance columns. These values remain empty/null, never zero. Colorado's 192
benefit variants absent from its Plan Attributes are reported as warnings when
their base plans exist; their variant cost sharing stays unknown. Missing base
plans remain errors. California publishes an empty Business Rules CSV; that
observed empty file is allowed, while plans/rates/areas remain required.
Business Rules with blank market retain `unknown`; issuer-level rows are never
silently assigned to a plan. Blank issuer names produce no inferred marketing name.
Minnesota's additional Plan ID Mapping XLSX is retained in the original bundle;
its contents are not executed or used to change any published ID.

A reconciled import records `cms_sbe_puf`, bundle URL/SHA-256, member, source row,
six snapshot IDs and counts in the usual JSON/Markdown reconciliation reports.
`sbe_catalog` links bundle provenance; `sbe_issuer_status` records both feed kinds
as unknown with `sbe_no_index_registry` for every issuer. A separately evidenced
ACTIVE feed, if subsequently imported, keeps its own availability. No issuer index
URL is guessed from the bundle's network/formulary link cells.

The serving pointer is scoped by state/year. NY/VT SBE catalogs are retained as
validated supplemental evidence; they never alter their P8 filed-tier catalogs,
rule snapshots or API answers. Bootstrap reuses an existing ACTIVE P8 catalog; on a
fresh deployment it loads the already prepared, hash-verified state publication
JSON, or reports `state_filed_tier_publications_not_prepared` if preparation has
not run. Oregon's SBE bundle contains only SHOP plans; it
never replaces the federal individual catalog. The importer records it as the SHOP
catalog in `puf_market_catalog` instead. Every other reviewed bundle serves
through the existing native plan and premium repositories. Family tiers remain
`unsupported_rating_method`. Massachusetts uses its filed per-age rows, including
its state age-rating limits; no federal age curve is applied. Missing tobacco cells stay
unknown. Dental rules retain the existing separately authorized SADP path.

The bootstrap geography adapter registers three evidenced spelling corrections in
the existing county-name registry (GA Heralson → Haralson, IL Vermillion → Vermilion,
NM Dona Ana → the Census key for Doña Ana). CA also maps San Bernadino → San Bernardino.
CA's mixed GRA table retains 57 whole-county areas plus the explicitly LA-only ZIP3
rows. A Los Angeles request needs a ZIP; a different county sharing an LA prefix
conservatively returns `ambiguous`, never the LA price. Availability labels CA
premium coverage `partial` for this reason. MA retains Census border ZCTAs whose
ZIP3 prefixes are absent from CMS's MA table, but their rating area stays unknown.
The geography snapshots retain the original CMS/Census hashes and source rows;
constraints are recorded as quality warnings. No missing rating area is filled.

The complete cited PY2026 rules document combines the existing federal rules with
19 SBE individual per-member authorizations under the [CMS state rating table](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating)
and [45 CFR 147.102(c)-(e)](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.102).
It uses filed rows and the three-oldest-children-under-21 rule, not the federal
age curve. NY/VT retain their existing citations. PY2026 rules never authorize
PY2027. Reports and availability distinguish rate evidence from supported policy
and resolved rating-area geography.

## Georgia Access PUFs (PY2027)

CMS lists no PY2027 SBE bundles. Georgia Access publishes its own PUF CSVs on
[georgiaaccess.gov/public-use-files](https://georgiaaccess.gov/public-use-files/).
`importSbe` reads them only for a Georgia year that CMS has not published, and only
from the cache. Each of the six kinds needs exactly one admitted file for that year,
meaning a fetch receipt that marks georgiaaccess.gov as allowed. When CMS lists a
bundle, the bundle stays the catalog.

PY2026 shows why. Georgia Access re-issued its PY2026 PLAN-PUF on 2026-08-28 with
723 individual variants. The CMS bundle has 887. The 164 missing variants belong to
43 base plans of issuers 15105, 43802 and 89942. Georgia Access's own PY2026 rate
file and 2025-to-2026 crosswalk still list them, and so does its benefits file for
15105 and 43802. That set fails the `rates_without_plan` check, so the importer
never picks it.

The Georgia Access files differ from the CMS layout in five ways. None changes a value.

- Benefits, network and business-rule rows end with one trailing comma. The reader
  drops exactly one extra empty field. Any other extra field still fails.
- The rate header is spelled `Tobaco`. It maps to `Tobacco`.
- The PY2027 PLAN-PUF lacks the federal waiting-period columns. This source does not
  require them.
- `PlanMarketingName` holds each variant's own name. A base plan keeps a name only
  when all its variants agree. Otherwise its name is `unknown`. Variant names stay.
- The catalog records `source = georgia_access_puf`, the listing page as its URL, and
  a digest of the six kind, URL and SHA-256 entries as its identity.

The PY2027 benefits file has 282 records with unescaped quotes inside quoted text,
such as `the "Schedule of Benefits."`. The strict reader rejects them. By default the
whole catalog is QUARANTINED and serves nothing. `OPENPLANS_GA_QUOTE_RECOVERY=on`
makes the reader take such a quote literally. A quote then closes the field only
when a delimiter or newline follows it, and the header's field count must still
hold. The importer stores a `csv_unescaped_quote_recovered` warning with the source
row for every recovered record. The option is off by default and awaits the owner's
approval.

PY2027 rating uses a Georgia row reviewed for PY2027 on its own. The CMS state rating
table leaves Georgia's individual-market cells blank, so the federal defaults apply.
Only filed per-member rows are used.

## Checks

`npm test -- tests/ingest/sbe` runs offline real cuts and labelled synthetic
controls. `python3 tests/fixtures/sbe/georgia-2027/regenerate.py` copies the Georgia
Access PY2027 cuts line for line from the admitted cache. `python3 tests/fixtures/sbe/regenerate.py` reproduces the catalog cuts from the
cached Georgia SHA-256 recorded in `provenance.json` (each CSV under 200 KB). `geography-regenerate.py` reproduces
the CA/MA fact-only geography cuts from the same external cache. Their provenance
records every original row and source hash; site chrome and contact fields are excluded.

After `npm run build`, `node scripts/oracle/sbe.mjs --year 2026` independently reads
all cached ZIPs with Python csv/Decimal, compares every stored rate field/count and
base ID, prices every member band and supported household, and checks the immutable
249-plan Georgia reference when available. Per-state PGlite databases are isolated
under the external cache. The check does not use Docker or touch another lane's database. A missing
2027 publication is explicitly reported. The oracle is appended to `realdata.sh`.
`--states GA` restricts development checks. `--mutate-rate` changes one raw expected
price by one cent and must exit nonzero, with separate synthetic-mutant reports.
