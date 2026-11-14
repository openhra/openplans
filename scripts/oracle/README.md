# Cache-only public-data checks

Run `scripts/realdata.sh` after acquiring the public source files into
`OPENPLANS_DATA_DIR` (default `$HOME/.local/share/openplans`). Node.js 22+,
Python 3 and the pinned development dependencies are required. These checks do not download files,
start Docker containers or request external health-plan APIs.
Missing required cached files fail; an old report cannot substitute for evidence.

Both PY2026 and PY2027 run by default. Select one with `--year 2025`,
`--year 2026` or `--year 2027`. PY2025 requires its own acquired PUF manifest, a reviewed
`data/rating-rules/2025.json`, and cached geography sources. Year selection does not
acquire them. The checks compare each supported state's imported catalog with
independently parsed CMS raw CSV counts, plan sets and filed premiums. Rates are
checked in integer cents; unknown or unsupported methods stay explicit. Each
state/year has a resumable developer database and reports under `reports/` in
the external cache. Production migrations are unchanged; only PostGIS is omitted
in disposable PGlite migration copies.

The dental check compares filed family and age-based premiums against raw CMS CSVs
for every publication-listed state and year. Run `dental.mjs --all-states --year 2026`, or
pass `--state XX` for one state. Each state must catch three planted defects, and TX PY2026
also checks county HTTP examples. `csr.mjs` takes the same options. It compares every
silver variant's accumulators and benefit rows and must catch two planted defects per
state. Each state gets its own developer database, copied from the all-states database
when one exists. Per-state reports and an `a6-{dental,csr}-all-states-<year>.json`
summary go under `reports/`.
`year-over-year.py` compares the two cached Texas catalogs using raw CMS files;
its premium changes are cross-sectional medians, not renewal quotes.

The lowest cost silver plan check has two parts. `ichra-reference.py` reads the plan for a
county, rating area, age and month from the raw Plan Attributes, Service Area and Rate CSVs.
It prices the plan on the filed premium and on its EHB portion, and the caller supplies the
county's rating area. The reading skips an `EHBPercentTotalPremium` with more than 15 decimal
places or outside 0 through 1. The EHB-portion answer is then `requires_premium_adjustments`
with reason `<plan>: ehb_allocation_unknown`, the same answer the application gives.
`allocatePremium` in `src/domain/subsidy/dental.ts` documents the limit. The gross answer
still stands.
`ichra-logic.mjs` compares those answers with the application's.
`tests/oracle/ichra.test.mjs` runs both offline on a synthetic catalog and must catch five
planted defects: one cent on a rate row, the second lowest plan in place of the lowest, the
two premium bases swapped, a case only one side answers, and a reading that accepts a
16-place EHB fraction. `scripts/realdata.sh` does not run this check yet.

The Part D plan-average price check also has two parts. `medicare-part-d-price-reference.py`
runs with `python3 -I`, imports nothing from the application and uses exact `Decimal`
arithmetic. It reads the cached quarterly SPUF archive directly: Plan Information, the Basic
Drugs Formulary, the Beneficiary Cost file, the Pricing file and all parts of the Pharmacy
Networks file. A case names a plan, a proxy NDC, a days supply, a quantity in units of that NDC
with `unit: "ndc_unit"`, a channel and a phase. For each case the script reports six figures.

- `unit_cost_total` is `UNIT_COST` times the quantity, for the fill's exact days supply of 30, 60
  or 90. In this reading the unit cost already includes the fee.
- `total_lowest_fee` and `total_highest_fee` add the lowest or the highest readable
  dispensing fee to that total. The fees come from in-area retail network pharmacies of the requested
  preferred status. A selected drug uses the selected-drug fee, or the brand fee where that one
  is `.`. Other drugs use brand and generic fees, since the files do not say which one applies.
- `gross` is a value only when all three totals give the same cents. A floor price above the
  unit-cost total, or one that cannot be read, adds a fourth reading.
- `member_cost` is the initial-coverage cost sharing from the plan's tier row for that days
  supply and channel. A copay is capped at the price. Coinsurance applies to the price in cents
  and rounds half up. The case's opening state is the plan deductible met and nothing else toward TrOOP.
  Like `gross`, it is a value only when every reading agrees. A charge above 90% of the price,
  where the selected drug subsidy or the manufacturer discount could cap it, is unknown with
  `subsidy_cap_may_bind`. A charge past the out-of-pocket threshold gives
  `crosses_out_of_pocket_threshold`, and a tier row with a minimum or maximum gives
  `cost_sharing_bounds_not_modelled`. Insulin and vaccine status are taken as the case states
  them.
- `maximum_fair_price_total` is for a drug the formulary flags as selected. It is the per-unit
  maximum fair price in effect on January 2 of the contract year, times the quantity, rounded to
  the cent. The price comes from the CMS Selected Drug List and Maximum Fair Price file, passed
  with `--mfp-file`. For such a drug this total takes the place of `unit_cost_total` in the
  readings: `total_lowest_fee` and `total_highest_fee` add the fees to it, there is no reading
  without a fee, and no floor price applies. `unit_cost_total` is still reported. A drug not
  flagged as selected gets `drug_not_selected`. A selected drug with no price in effect gets
  `maximum_fair_price_not_in_effect` for every figure but `unit_cost_total`.

A missing price row, a zero or unreadable unit cost, a mail channel, a days supply other than 30,
60 or 90, or a unit other than `ndc_unit` makes every figure unknown. The reasons are
`price_days_supply_not_published`, `unit_cost_unreadable`, `unit_cost_retail_only` and
`quantity_unit_not_ndc_unit`. None of them is ever $0. When no fee can be read, or fees differ,
the fee-dependent figures are unknown with `dispensing_fee_unknown`. Evidence cites the pricing,
formulary and cost rows by member and row number, plus the fee range used.

`medicare-part-d-price-cases.json` is the fixed sample: 200 cases across 28 plans, every tier and
selected flag of each plan's formulary, and all three days supplies, plus edge cases. To rebuild
it, run the script with `--make-cases`. The reference also records each reading's member charge,
so a bounded answer can be checked at both ends.

`medicare-part-d-price.mjs` asks the estimate service for each case on a database that holds the
year's quarterly release with its pricing and dispensing-fee tables (`DATABASE_URL`). It compares
the answers with the reference through `compareApplicationAnswers` in
`medicare-part-d-price-logic.mjs`. Values and reasons must match, with a short list of reasons
the application names more precisely. A bounded answer matches only the reference's
`dispensing_fee_unknown`, and its minimum and maximum must equal the reference's lowest-fee and
highest-fee readings. The reference does not model some cases: later phases, the subsidy cap,
the out-of-pocket threshold, filed minimum and maximum cost sharing. The application also stops
on enhanced alternative plans that would pay less than the standard benefit. Those figures are
listed under `not_compared` in `reports/medicare-part-d-price-<year>.json`, and never counted as
matches. Without a database the runner writes `app_database_missing` and exits 1. `--cached`
takes the year's newest quarterly archive from the data directory instead of `--archive`. The
runner passes the cached maximum fair price file pinned in
`data/medicare-part-d/drug-lists.json` to the reference when the data directory holds it.
`tests/oracle/medicare-part-d-price.test.mjs` runs the reference on a synthetic mini-archive
against hand-worked answers and checks the bounded comparison. It must catch five planted
defects: a missing price read as $0, the nearest days supply in place of the fill's own, the
dispensing fee ignored, the plan-average unit cost used for a selected drug, and a maximum fair
price used for a drug that is not selected. `scripts/realdata.sh` runs it for 2026 with `--cached --optional`
when `OPENPLANS_PRICE_CHECK_DATABASE_URL` names a database holding that release with its pricing
and dispensing-fee tables. Loading only the sample's plans is enough. Without that database or the cached
archive it prints `SKIP` and writes no report.

`build-price-check-db.sh build` makes that database from the cache. It loads the 2026 PBP release
and cuts the newest cached quarterly archive down to the sample's plans with
`price-check-subset.py`. The subset keeps plan, cost, pricing and pharmacy network rows for those
plans only, and formulary rows for their formularies and for every NDC in the sample. The
application's own importers then load it, with pricing and dispensing-fee ranges.
Maximum fair prices come from the pinned file, not the database. Pass `--database-url` to load
an existing database. Pass `--docker-context NAME` to start, or reuse, a disposable Postgres
container in that Docker context (`openplans-price-check-2026-db`, published on 127.0.0.1 only).
`remove --docker-context NAME` deletes the container and its volume. A second build reuses the
subset and imports nothing new. The work directory (default `<data dir>/price-check/2026`)
holds `subset.json`, which gives the SHA-256 of every archive member read and the rows kept, and
`load.json`, which gives the import outcomes, the time taken and the database size. Filtering
renumbers a member's rows, so a row number in the subset is not the one in the CMS file.
`scripts/realdata.sh --with-price-check` builds the database this way, then runs the check
without `--optional`, so a missing archive fails instead of skipping. The builder's tests are in
`tests/oracle/price-check-db.test.mjs`.

`surface-sweep.mjs` calls every public read route and MCP tool on a database that holds the loaded
catalogs (`DATABASE_URL`). For each loaded state and plan year it asks about every county twice,
once by county and once by one of its ZIP codes. It also asks about New York and Vermont counties
whether or not their catalogs are loaded, and about ZIP codes outside the loaded geography. Each
location goes to `/v1/plans`, `/v1/quotes`, `/v1/premium-quotes`, `/v1/benchmark`,
`/v1/ichra/affordability`, the compatibility plan search and the MCP tools that take a location.
Each state and year also goes to `/v1/data-availability`, `get_data_status`,
`list_carriers_networks` and the drug and provider coverage tools. Requests run in process and
nothing is fetched. A response fails when it is a 5xx, when it carries `INTERNAL_HONESTY_CHECK`
or the MCP catch-all `DATA_UNAVAILABLE` (the tools' form of an internal error),
or when its list or answer is empty and it names no reason code (`issues`, `location_issues`, a
`reason`, an error code or an `x-openplans-gaps` entry). The rule lives in
`surface-sweep-logic.mjs`. `reports/surface-sweep.json` keeps every failure with its inputs,
grouped by class, and the outcomes seen on each surface. When a New York catalog is loaded, the
sweep also runs `search_plans` for New York counties through a copy of the MCP tools whose
projection reads a HIOS-shaped `plan_key` as a state plan key (control `mcpPlanKey` in
`source-controls.mjs`). That copy must produce `INTERNAL_HONESTY_CHECK`, or the sweep fails.

The sweep also covers what loads beside the catalog. Every ZIP goes to the native, MCP and
compatibility provider searches. Each loaded state and year samples NPPES identities, issuer
directory listings, one plan per issuer and RxCUIs from the loaded QHP and Part D formularies.
Each identity goes to provider detail and to participation for the sampled plans. Each drug
goes to drug search and detail and to coverage for the sampled plans. Each Medicare plan key the
searches return (`--medicare-plans`, default 400) goes to plan detail, benefits, service area,
lineage, the Part D drug list and pharmacies. The sweep serves Part D
(`OPENPLANS_MEDICARE_PART_D=on`) and keeps the drug-cost estimator and its prices off. The first
keys (`--estimator-checks`, default 25) ask for an estimate on both price bases and through the
MCP endpoint, and each request must be refused with a closed answer or an error. Records inside an
answer, such as coverage and participation results, each need their own reason when unknown. An
empty provider or drug search is a whole answer when it says its source is loaded (provider
status `available`, MCP status `ok`, `terminology_status: "available"`). A second control,
`mcpParticipation`, reports an unknown participation answer as `not_listed`, and
`check_provider_network` through that copy must produce `INTERNAL_HONESTY_CHECK`.
Each location also asks `/v1/ichra/affordability` and `check_ichra_affordability` under the
look-back safe harbor (`safe_harbors.look_back`), which prices the employer's LCSP from January of
the year before the plan year. With that catalog loaded the answer is `calculated`. Without it the
answer names `lookback_catalog_not_loaded`. `--lookback-only` asks only those two questions.
`--year`, `--state` and `--counties N` narrow a run; `--providers` and `--drugs` set the samples. `tests/oracle/surface-sweep.test.mjs`
checks the rule on synthetic responses. `scripts/realdata.sh` runs the sweep with `--optional`
when `OPENPLANS_SURFACE_SWEEP_DATABASE_URL` names a loaded database, and prints `SKIP` without
one.

Geocode bounds and disposable point controls are available in `geocode.mjs`;
`geocode-statewide-controls.mjs` exercises transaction and resume behavior with
Postgres. See the [geocode guide](../../src/ingest/geocode/README.md).

A public export also runs `raw-evidence.mjs` for the optional prepared Cigna TX
PY2026 drug/provider and TX geocode databases. It retains the sampled nullable
drug facts, full provider pair multiplicities, source SHA-256 checks and failing
PA/removed-edge/point controls. Missing optional databases print explicit SKIPs;
the check fails if present evidence disagrees with the public raw files. Use
`OPENPLANS_FORMULARY_DB`, `OPENPLANS_PROVIDER_DB` and `OPENPLANS_GEOCODE_DB` to
select prepared file databases. The defaults are `formulary-pglite-p2d`,
`provider-pglite-p3b` and `geocode-pglite-p3c` below the cache. These checks never
download or create missing databases. Results go to `reports/public-raw-evidence.json`.

Public CI and the public raw-file checks need no private data or database archive.
Offline checker tests live in `tests/oracle/`.

Source controls use `source-controls.mjs` and the shared syntax matcher in
`scripts/source-mutation.mjs`. Offline CI runs `tests/oracle/source-controls.test.mjs`
against current TypeScript and built JavaScript, with both quote styles and
different wrapping and trailing commas. A missing or duplicate target fails.
The registry covers dental family tiers, CSR income inference, the NY/VT federal
guard, filed family cells, Alaska FPL selection and ZCTA priority. CSR import
rebasing also uses parsed module specifiers. Dental requires 3/3 controls and CSR
requires 2/2.

The other controls select data rather than source text. SBE changes one parsed
rate expectation. NY/VT corpus checks select prepared JSON records, filed cells
and database rows; VT HIOS controls change disposable prepared records. Rate,
drug, provider and geocode oracles mutate parsed records or isolated database
rows. Publication-anchor checks use HTML fixtures and parsed discovery results.
These targets do not depend on TypeScript formatting.
