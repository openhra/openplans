# Changelog

Release notes for OpenPlans. Earlier releases are on the
[GitHub releases page](https://github.com/openhra/openplans/releases).

## v0.4.6

This release adds a readiness check and makes provider searches faster. While migrations are
pending, `/readyz` and the data routes answer 503 `schema_not_ready` instead of failing with a
500, and `/healthz` stays a liveness check. When a read runs past its timeout, the API now
cancels it on the database server and answers 504 `query_timeout` instead of 500. The PGlite
developer server won't start on a database with unapplied migrations.

It has one migration, 1006, which builds an index concurrently, so the old version keeps serving
while it runs. There is no backfill. See [Upgrading](#upgrading). Search results, totals and
counts don't change. Status codes change in two places: a read that times out answers 504, and
pending migrations answer 503. Both used to answer 500.

### What users notice

- **A readiness check.** `GET /readyz` answers 200 `{"status":"ready"}` once the database answers
  and every migration is applied, core and enabled plugins alike. Until then it answers 503 with
  `reason: "schema_not_ready"` and the number of `pending` files. A down database gives
  `db_down`, and a journal that can't be read gives `schema_unknown`.
- **Pending migrations answer 503, not 500.** While a migration is pending, the native and
  compatibility routes answer 503 with the code `schema_not_ready` and a `Retry-After` header.
  MCP answers 503 with a JSON-RPC error whose `data.reason` is `schema_not_ready`. The `/status`
  pages keep answering. The API reads the migration journal at most once
  every 5 seconds, so it starts serving a few seconds after the migration finishes, with no
  restart.
- **`/healthz` is a liveness check.** It still answers 200 while the process and its database
  connection are up. While migrations are pending, its body adds `"schema":"not_ready"` and the
  `pending` count. A Compose health check on `/healthz` behaves as before, so the worker can still
  start and migrate.

### Fixes

- **Timed-out reads stop on the server.** The database client's read timeout only stopped
  waiting, so a slow query kept running after its request had failed. When a read passes its
  5-second timeout, the API now cancels the statement through its separate cancellation
  connection and waits for the connection to answer before reusing it. If the cancellation fails,
  the API discards the connection. The caller gets a 504 `query_timeout`, described below.
- **The PGlite server refuses an unmigrated database.** `npm run api:pglite` used to start on a
  new database, and then every data route failed with a 500. It now exits and names
  `npm run api:pglite -- migrate`.
- **Faster provider searches.** A name search that matches up to 1,000 providers now starts from
  those providers and checks their distance with a new covering index (migration 1006). It used
  to scan every point in the radius. A common name keeps the radius scan but drops points of
  other providers early. An exact taxonomy code finds its providers through the code index. The
  API keeps the exact count of unlocated addresses per data generation and filter set, so a
  repeat search doesn't count them again. Results, totals and counts are the same as before.
- **A read that times out answers 504.** A read that runs past its 5-second limit now answers
  HTTP 504 `{"error":{"code":"query_timeout"}}` on the native and compatibility APIs. It used to
  answer 500 `INTERNAL_ERROR`. MCP tools answer the code `query_timeout` with `retryable: true`.
  When the unlocated count can't finish in time, the search answers 504 and the count keeps
  running, up to two minutes. The next search with the same filters then reads it.
- **Pricing requests read the county catalog once.** Quotes, premium estimates, the silver
  benchmark, ICHRA affordability checks and compatibility medical searches used to read the
  county's whole plan catalog again for every plan they priced, so counties with many plans were
  slow. Each request now reads the catalog once. Answers don't change.

### Development

- A geography test helper moves from `src/` to `tests/`, next to its only test. The build no
  longer compiles it into `dist/`, so the image no longer carries it.
- Ingest code opens downloaded files only through the snapshot store. A test fails when code
  under `src/ingest` or `src/worker` builds a `raw/` path itself.

### Upgrading

- Pull the new image and run the migrations. Migration 1006 builds one index on `address_point`
  with `CREATE INDEX CONCURRENTLY`, so the old version keeps serving while it builds. On a large
  provider load the build can take several minutes, and `/readyz` answers 503
  `schema_not_ready` until it finishes. If the build fails, it leaves an invalid index. Drop it
  with `DROP INDEX CONCURRENTLY address_point_npi_coordinates;` and run the migrations again.
  There is no backfill.
- The Compose database profile now sets `random_page_cost=1.1` and
  `effective_io_concurrency=200`. They take effect when the db container is recreated.
- Point readiness probes, load balancers and deploy checks at `/readyz`, and keep `/healthz` for
  liveness. A 200 from `/healthz` no longer means the schema is current.
- The bundled plugins keep their v0.4.5 versions and package hashes, so an approved plugin list
  needs no change.

## v0.4.5

This release gives a reason where provider and drug searches, and MCP coverage, network and quote
records, answered `unknown` or an empty list without one. MCP errors that the HTTP transport sends
after reading a request now carry the request's `id`.

It has no migrations and no backfill. See [Upgrading](#upgrading). Answers change only where they
used to be `unknown` or empty without a reason. The MCP output schema changes for
`search_providers`.

### Fixes

- **Coverage and network answers keep their reason over MCP.** When `check_drug_coverage`,
  `check_provider_network` or `quote_plans` answers `unknown`, the record's `gaps` now holds the
  native reason, such as `source_set_not_available`. Before, only answers from the CMS fallback
  carried it.
- **Empty provider searches say when no registry is loaded.** `GET /v1/providers` answers an empty
  identity search with `status: "unknown"` and `reason: "provider_registry_not_loaded"` when no
  NPPES release covers the ZIP's state. The MCP tool `search_providers` adds the same `reason`
  (null otherwise), and the compatibility provider search adds it to `x-openplans-gaps`.
- **Drug search says when terminology is missing.** `GET /v1/drugs` adds `terminology_status`.
  With no RxNorm release loaded it is `unknown`, with `reason: "rxnorm_terminology_unavailable"`.
  An empty list with `available` means no concept matched.
- **MCP transport errors carry the request id.** The MCP HTTP transport's own errors always
  carried `"id": null`, though JSON-RPC 2.0 asks for the request's id whenever the server can read
  it. Once the body parses as a single request, these errors now carry its string or number id: a
  missing `MCP-Protocol-Version` header, the personalized and estimate access errors,
  `AUTH_NOT_CONFIGURED`, the concurrency limit and the deadline error. Errors sent before the body
  is parsed keep `null`: the Origin and Host checks, the method check, the rate limit, content
  type, size limit and parse errors. So do batches, notifications and requests with a malformed
  id.

### Development

- `scripts/oracle/surface-sweep.mjs` also sweeps what loads beside the catalog: provider searches
  for every ZIP, sampled NPPES identities, directory listings and formulary drugs against provider
  detail, participation, drug search and coverage, and Medicare plan detail routes. Unknown records
  inside an answer need their own reason. See `scripts/oracle/README.md`.
- The test toolchain moves to Vitest 5.0.5, with Vite 8.3.5 as a dev dependency.

### Upgrading

- Pull the new image. There is no migration to run and no backfill.
- If you validate MCP output against its schema, take the new schema from `tools/list`.
  `search_providers` gains a nullable `reason`. Clients of `GET /v1/drugs` see the new
  `terminology_status` field, and clients of `GET /v1/providers` may get `status: "unknown"` with
  `provider_registry_not_loaded` where they used to get an empty list.
- The bundled plugins keep their v0.4.4 versions and package hashes, so an approved plugin list
  needs no change.

## v0.4.4

This release moves the web framework dependencies to patched versions. It fixes MCP tools that
answered territory ZIPs and Vermont ICHRA checks with an internal error, and gives a reason where
a county or Medicare search used to come back empty without one. The last config-file keys that
OpenPlans accepted but never read now take effect.

It has no migrations and no backfill. See [Upgrading](#upgrading). Answers change only where
they used to be an internal error or an empty list without a reason. The MCP output schemas
change for `search_medicare_plans` and `check_ichra_affordability`.

### Security

- Security: updated the web framework dependencies (hono, @hono/node-server) to patched versions.

### What users notice

- **Unloaded states and years say so.** A county whose state has no active catalog for the
  requested year, such as a state the service has not loaded or a plan year it does not hold, now
  gets `state_catalog_not_loaded` in `issues`, `location_issues` and `x-openplans-gaps` instead of
  an empty list with no reason.
- **Medicare search names its reason.** The MCP tool `search_medicare_plans` adds `reason`, the
  same code `GET /v1/medicare/plans` gives, such as `catalog_not_loaded` when no Medicare catalog
  is loaded. It is null otherwise.
- **Medicare search for an unknown ZIP.** `GET /v1/medicare/plans` and `search_medicare_plans`
  give reason `zip_not_in_loaded_geography` for a ZIP outside the loaded geography.

### Fixes

- MCP `lookup_geography`, `search_plans` and the other tools that list counties answered a
  Puerto Rico, Guam or other territory ZIP with an internal error, because a territory county has
  no state code. Such a county now carries its territory code (`PR`, `GU`, `VI`, `AS`, `MP`).
- MCP `check_ichra_affordability` answered every Vermont county with an internal error. The
  output check wanted HIOS plan IDs and an age, but a Vermont LCSP is a filed plan key and
  community rating has no age. `lcsps[].plan_ids` now takes plan keys too, and
  `identified_at_age` and `priced_at_age` may be null.

### Self-hosting and operations

- **The remaining config-file keys take effect.** The file can now set the database URL
  (`db.connectionString`), the response cache switch (`cache.enabled`), the public access
  switches (`public.quoting`, `public.household`, `public.compat`), the API and compatibility
  tokens (`tokens.api`, `tokens.compatKey`, `tokens.compatKeyHeader`), the trusted proxies
  (`trustProxy`), the operator manifest (`access.operatorManifest`) and the project URL
  (`access.projectUrl`). Before, the file accepted these keys and every reader ignored them.
  An environment variable that is set still wins over the file. The compatibility routes now read
  their key and header name once, when the API starts. See `docs/configuration.md`.

### Development

- `scripts/oracle/build-price-check-db.sh` builds the Part D price check database from cached
  CMS files. It cuts the quarterly archive down to the sample's plans and loads it with the
  application's own importers. `scripts/realdata.sh --with-price-check` builds it and then runs
  the check. See `scripts/oracle/README.md`.
- `scripts/oracle/surface-sweep.mjs` calls every public read route and MCP tool for every county
  of each loaded state and plan year, by county and by ZIP. A response fails on a 5xx, on
  `INTERNAL_HONESTY_CHECK`, or on an empty answer that names no reason. `scripts/realdata.sh`
  runs it when `OPENPLANS_SURFACE_SWEEP_DATABASE_URL` names a loaded database.

### Upgrading

- Pull the new image. There is no migration to run and no backfill.
- If you validate MCP output against its schema, take the new schemas from `tools/list`.
  `search_medicare_plans` gains a nullable `reason` field. In `check_ichra_affordability`, the
  `plan_ids` lists under `lcsps[]` and its `by_basis` picks accept state plan keys as well as
  HIOS IDs, and `identified_at_age` and `priced_at_age` may be null. Clients that parse `issues` or
  `location_issues` see `state_catalog_not_loaded` for more counties.
- Each bundled plugin now names the new hono version as its peer dependency, so each one has a
  new patch version and a new package hash. The status, webhook, template, S3 blob store and
  both source plugins move from 0.1.0 to 0.1.1, and Slack moves from 0.2.0 to 0.2.1. Their code
  and messages do not change. If you keep an approved plugin list, start the new image on the
  side, read each entry's version and `sha256` from `/status/operator.json` as in the release
  preflight in `docs/plugins-operations.md`, and replace the old entries. "Upgrade to Slack
  0.2.0" there gives the Slack 0.2.1 entry.
- Check your config file before upgrading. Keys from the list above that it already holds now
  take effect. For example, `tokens.compatKey` in the file now guards the compatibility routes,
  and a `public.*` switch set to `false` turns that access off. Without a config file nothing
  changes.

## v0.4.3

This release prices Part D drugs selected for Medicare price negotiation from their CMS maximum
fair price, and keeps cached API answers valid while Part D prices load in small batches. Prices
stay behind the Part D pricing setting, which is off by default. Plan lists and quotes now say
why plans were left out, and config-file switches now take effect.

It has one migration (1005), which changes triggers on the three Part D price tables, and no
backfill. See [Upgrading](#upgrading). Plan search and quote responses gain reason fields, and
two subsidy reasons get more specific codes. Statuses, prices and benchmarks stay the same on a
service that keeps `OPENPLANS_MEDICARE_DRUG_COST_PRICES` off. A config file that sets a key read
only from the environment now stops startup.

### What users notice

- **Maximum fair prices for selected drugs.** With `OPENPLANS_MEDICARE_DRUG_COST_PRICES` on, a
  drug selected for the Medicare Drug Price Negotiation Program is priced from its maximum fair
  price instead of the plan's average unit cost. The estimator takes the price per unit in effect
  on the fill date from the CMS Selected Drug List and Maximum Fair Price file, multiplies it by
  the quantity, and adds the lowest and the highest selected-drug dispensing fee. When both fees
  give the same cents, the gross cost is a `value`; otherwise it is `bounded`. CMS prices its
  worked example at exactly the maximum fair price plus the fee, and the estimator does the same.
  The answer says so in its assumptions. A selected drug with no price in effect on the fill date
  answers `unknown` with `maximum_fair_price_not_in_effect`, and the plan average is never used in
  its place. When the formulary flag and the CMS list disagree, the estimator counts both ways and
  gives a gross cost only when they agree to the cent. Otherwise it answers `unknown` with
  `maximum_fair_price_may_apply`. The `price` block gains `ingredient`, the per-unit price with
  its effective dates, and a `maximum_fair_price_total` figure, which other drugs report as
  `unknown` with `drug_not_selected`. The MCP output schema lists the new fields.
  `data/medicare-part-d/drug-lists.json` pins the CMS file and holds its prices for 2026 and 2027.
  See `docs/medicare.md`.
- **CMS worked examples priced exactly.** Five CMS worked examples use selected drugs: C7
  examples 1, 3, 4 and 5, and C12 example 1. With `price_basis: "cms_plan_average"` they are now
  priced from the maximum fair price, and every figure matches CMS to the cent over HTTP and MCP.
  C7 example 4 is no longer a range. C12 example 1 could not be reproduced from plan averages
  and now can. The independent price reference
  script reads the same CMS file with `--mfp-file` and reports `maximum_fair_price_total`.
- **Plan lists say why they may be short.** `GET /v1/plans` and `POST /v1/quotes` add
  `issues`, and the MCP tools `search_plans` and `quote_plans` add `location_issues`. Each lists
  reason codes: `zip_limited_service_area` when a county-only request leaves out plans that serve
  part of the county, `zip_not_in_loaded_geography`, `state_catalog_not_loaded`, and the New York
  template refusal code, such as `template_saved_before_submission`, when a refused issuer's plans
  are missing from the region. The list is empty when no plan is known to be missing.
- **Subsidy reasons name the gap.** A subsidy for a ZIP outside the loaded geography now has
  reason `zip_not_in_loaded_geography` instead of `unknown`. A New York or Vermont county without
  its state catalog has reason `state_catalog_not_loaded` instead of `unsupported_rating_method`.
  Statuses do not change.
- **Compatibility gaps.** Medical and dental search add the same codes to `x-openplans-gaps`. The
  compatibility README lists the mapping.

### Self-hosting and operations

- **Cached answers stay valid during a staged Part D price load.** Staged unit-cost and
  dispensing-fee batches used to move the API data generation, so the response cache recomputed
  every answer for the whole load. From migration 1005, writes to `partd_plan_unit_cost`,
  `partd_pricing_release` and `partd_dispensing_fee_range` move the generation only when a row
  belongs to a release that lists the table. Listing the tables, or withdrawing them after a
  failed check, moves it once. TRUNCATE still always moves it. `checkCatalogTriggers` reports a
  missing or disabled trigger on these tables. See `src/api/cache/README.md`.
- **Hosted release process.** The hosted service's release tool now runs scripted public checks
  after each release and records them in its receipt. The checks cover the reason fields added
  in this release. A read-only checker reports whether the service is ready for a blue/green
  release. These tools are not part of this repository.
- **Config-file switches take effect.** The config file keys for the Medicare switches
  (`medicarePartD`, `medicareDrugCost`, `medicareDrugCostPrices`), Georgia quote recovery
  (`gaQuoteRecovery`), the compatibility options (`compat.catastrophicAgeRule`,
  `compat.benefitText`) and `cmsFallback.quotes` used to be accepted and then ignored. They now
  work. An environment variable that is set still wins over the file. With neither set, every
  switch stays off.
- **Environment-only keys refused in the file.** Settings that programs read straight from the
  environment can no longer go in the config file: `compose.*`, `geocoder.*`, `runners.*`,
  `cmsFallback.apiKey` and `access.egressFile` / `access.egressSha256`. A file that sets one
  stops the API, worker, stdio server and PGlite runner at startup with one line naming the
  variable to set instead. See "Environment-only settings" in `docs/configuration.md`.
- **Data directory and egress country in the config file.** `access.dataDir` and
  `access.egressCountry` now reach every reader: the API, the worker, the import runners and the
  state check scripts. Each takes the environment variable first, then the file, then the
  default. `access.dataDir` also sets the root of the `local` blob store unless the file sets
  `blobs.root`. `scripts/smoke.sh` and `src/ingest/geocode/geocoder.sh` still read only
  `OPENPLANS_DATA_DIR`.
- **Slack plugin 0.2.0 posts rollbacks.** The Slack plugin posts `release.rolled_back` as a
  `warning`, for example `OpenPlans: Release rolled back from 1.4.0 to 1.3.2.` It names the two
  versions and never the image ID. Without an `events` option it posts rollbacks as soon as 0.2.0
  loads. With an `events` list, add `"release.rolled_back"` to get them. With `minSeverity` set
  to `error`, rollbacks are dropped. See "Upgrade to Slack 0.2.0" in
  `docs/plugins-operations.md`.

### Fixes

- The macOS CI checks run as three shards on separate runners. One macOS job ran past its
  60-minute limit, because the suite runs one file at a time and those runners take about
  twice as long as Linux. `scripts/ci.sh` runs one slice of the tests when
  `OPENPLANS_CI_SHARD` is set. The `OpenPlans / macOS` check now passes only when every shard
  passed.
- The plugin guide example test gives its nested test run an explicit timeout. On a hosted macOS
  runner, loading the example plugin with a fresh database took longer than vitest's 5-second
  default.
- MCP `search_plans` answered a New York county with an internal error, because a filed plan
  keyed by its HIOS ID did not match the state plan-key pattern. Such a plan is now returned as a
  HIOS plan.

### Docs

- `docs/medicare.md` now lists the estimate statuses, the maximum fair price reasons and the
  price check as the code has them.
- `docs/ichra.md` covers the PY2025 look-back, the reasons a quote asks for a ZIP, and the New
  York rate source override.
- `docs/configuration.md` lists every switch with its config key and environment variable.
  `.env.example` lists the two drug-cost switches.
- The API README describes the `zip_not_in_loaded_geography` and `state_catalog_not_loaded`
  benchmark reasons. `docs/migrations.md` counts migrations through 1005, and the plugin docs
  describe `release.rolled_back`.

### Development

- The Part D price check no longer compares the member cost for a selected drug with no maximum
  fair price in effect, since the independent reference stops before cost sharing there.
- Tests that plant mutated source files write each one into a fresh temporary folder, so test
  runs that share a checkout no longer overwrite each other's copies.
- The checks that run before a change merges now also check the wording of every file published
  in this repository.

### Upgrading

- Pull the new image and run `worker migrate`. Migration 1005 adds two functions and swaps the
  data-generation triggers on the three Part D price tables. It creates no table and adds no
  rows. The tables only take writes during a Part D price import, and are empty until the first
  one.
- `worker migrate --check` classes 1005 as `risky`, because the classifier has no rule that
  clears a dropped trigger. The section on 1005 in `docs/migrations.md` explains the locks it
  takes. A release runner that refuses risky files needs
  `--allow-risky-migration 1005_partd_staged_generation.sql`. Apply it before any Part D price
  load. Images from v0.4.2 keep working on the new schema.
- No backfill is needed.
- If you run the Slack plugin, replace its approved-list entry with version `0.2.0` and the
  sha256 given in "Upgrade to Slack 0.2.0" in `docs/plugins-operations.md`. Version 0.1.0 refuses
  `"release.rolled_back"` in `events`, so change that list only together with the upgrade.
- If you parse plan search or quote responses, expect the new `issues` field on REST and
  `location_issues` on MCP, and the two new subsidy reason codes. The compatibility search adds
  the codes to `x-openplans-gaps`.
- Check your config file before upgrading. If it sets `compose.*`, `geocoder.*`, `runners.*`,
  `cmsFallback.apiKey`, `access.egressFile` or `access.egressSha256`, move the value to the
  environment variable the startup error names, or the services will not start. An empty
  section, such as `"compose": {}`, is still accepted. Keys such as `medicarePartD` that the file
  already held now take effect, so review them too. Without a config file nothing changes.

## v0.4.2

This release asks for a ZIP when a part-county dental plan would set a county-only benchmark,
adds an optional New York rate source for issuers whose template was refused, and adds the first
Part D drug pricing pieces: dispensing-fee ranges, a unit-cost reader and bounded fill pricing.
The pricing pieces are off by default. It also adds the `release.rolled_back` plugin event.

It has two additive migrations (1003 and 1004) and no backfill. See [Upgrading](#upgrading).
One kind of answer changes: requests for a ZIP outside the loaded geography, such as New York
and Vermont ZIPs on a service with a CMS key, used to fail with a server error and now answer
`unknown` or `unsupported_rating_method` with a reason (see [Fixes](#fixes)). The new dental
answer applies only where a part-county dental plan would have set the benchmark, and the New
York and Part D pricing changes stay off until an operator turns them on.

### What users notice

- **County-only quotes with part-county dental plans.** For a household with a child under 19,
  the benchmark adds the pediatric dental adjustment. Without a ZIP, that step used to drop
  stand-alone dental plans that serve only part of the county, so the benchmark could use the
  wrong dental premium. Such a quote now returns `location_requires_zip` with reason
  `zip_limited_service_area`, the same answer as for part-county silver plans, and the credit
  and net premium are `null` until you send a ZIP. Quotes with a ZIP, adult-only households and
  counties without such plans do not change. In the current catalog no answer changes.
- **Plan-average drug prices in Part D estimates.** A new setting,
  `OPENPLANS_MEDICARE_DRUG_COST_PRICES`, lets drug-cost estimates accept
  `price_basis: "cms_plan_average"`. It is off by default and counts only while the estimator is
  on. With it on, each fill is priced from the plan's average unit cost and the lowest and highest
  dispensing fee, and a figure is a `value`, `bounded` or `unknown`. A `bounded` figure has
  `cents: null` with `minimum_cents` and `maximum_cents`, and the answer never picks one amount
  inside the range. Each priced fill carries a `price` block that cites its pricing row and fee range. A
  release without pricing rows or fee ranges answers `unknown` with `pricing_not_loaded` or
  `dispensing_fees_not_loaded`. `/v1/data-availability` says whether prices are loaded and the
  setting is on, and lists the basis only when both hold. The HTTP route and the MCP tool return
  the same answer, and the MCP output schema now accepts bounded figures. If you parse estimate
  figures, handle the `bounded` status. `docs/medicare.md` explains how prices are read and what
  stays unknown.

### Self-hosting and operations

- **Optional New York rate source.** When the New York template check refuses an issuer's DFS
  approved-rates template, that issuer's NY rates stay `unknown`. A new config file entry,
  `ny.rateSourceOverrides`, can name the issuer and take its family-tier rates from the CMS
  state-based exchange rate file instead. Each rate cites the publication, the file member and
  its CSV row. Preparation and import refuse the override unless that issuer's template was
  refused, and unless the CMS file agrees to the cent with every DFS approved rate it lists for
  other issuers. Plans with no row in that file stay `unknown`. It is off by default, and turning
  it on is your decision. With it off the NY artifact is byte-identical. See
  `docs/configuration.md`.
- **Part D dispensing-fee ranges.**
  `worker ingest medicare part-d import --tables dispensing_fee` reads the pharmacy networks
  file and stores, per plan, channel, in-area flag, fee type and days supply, the lowest and
  highest fee, how many pharmacies list a fee or show `.`, and the highest floor price. It keeps
  no pharmacy rows, and `.` counts as missing, never as zero. The importer accepts both spellings of the selected-drug fee header, and it can now add a
  large table to a release that is already loaded.
- **Part D unit costs in a compact table.** Plan average unit costs now go into
  `partd_plan_unit_cost` (migration 1004), whose rows carry a two-byte release key in place of
  the snapshot id. Answers still name the full snapshot. Pricing imported before 1004 reads as
  not loaded; import it again with `--tables pricing`.
- **Part D fill pricing with bounds.** A reader returns a plan's unit cost only for an exact row
  (30, 60 or 90 days at retail), and `unknown` with a reason otherwise. The estimate engine can
  price a fill from that unit cost and the lowest and highest dispensing fee. When the fee range
  moves the result, the answer gives the gross cost, patient pay and TrOOP increment as a range.
  Missing fees, floors that could bind and missing prices stay `unknown`. The new
  `OPENPLANS_MEDICARE_DRUG_COST_PRICES` setting, described above, turns it on.
- **New event `release.rolled_back`.** The plugin event catalog gains `release.rolled_back`
  (`version`, `imageId`, `fromVersion`), emitted after a hard-release rollback. The webhook plugin
  posts it when its `events` list names it. The Slack plugin does not post it.
- **Hosted release process.** The hosted service's release tooling gained a blue/green mode with
  a time limit on checks after a switch, recorded rollbacks and a fix for a rollback that held
  the release lock. It can also add states to a plan year that is already served, and a load that
  fails a later check is taken out of service again. These tools are not part of this repository.
- **Part D prices load in small batches.** The importer can stage the unit-cost and
  dispensing-fee rows of an imported quarterly release in transactions of a few thousand rows,
  without listing them for the release, and a rerun resumes from the rows already stored. The
  one-transaction import refuses to add a table that is staged.
- **Hosted Part D price load.** The hosted release tool gained an optional
  `--load-partd-prices <year>` step. It needs a free-disk margin before it starts, loads the price
  and dispensing-fee data in small batches, and keeps the data unserved until row counts and
  checksums match the reviewed release. A failed check takes the data back out of service. The
  step does not turn on the price basis.
- **Part D price check in the real-data script.** `scripts/realdata.sh` now checks 2026
  plan-average prices against its own reading of the cached quarterly archive when
  `OPENPLANS_PRICE_CHECK_DATABASE_URL` names a database with that release's pricing and
  dispensing-fee tables. Without one, the step prints `SKIP`. The C7 and C12 CMS worked examples
  also run over HTTP and MCP through plan-average prices.

### Fixes

- **No more server errors for unloaded ZIPs.** Request routes read the database in a read-only
  transaction. For a ZIP outside the loaded geography, the CMS county lookup tried to reserve
  its daily budget and record the attempt, Postgres refused both writes, and `/v1/benchmark`,
  the quote and premium-quote routes and the MCP search and quote tools returned
  `INTERNAL_ERROR`. This happened whenever a CMS key was set. In a read-only request the lookup
  now uses cached rows only. The benchmark then answers `unknown` with
  `zip_not_in_loaded_geography`. New York and Vermont rates come from a state catalog. When
  none is loaded for the year, they answer `unsupported_rating_method` with
  `state_catalog_not_loaded`.
- The macOS CI job gets 60 minutes. A run hit the 45-minute limit.
- The MCP tools-list negative controls give each mutated server its own file name, so two test
  runs in one checkout no longer load each other's half-written copy.

### Upgrading

- Pull the new image and run `worker migrate`. Migrations 1003 (the dispensing-fee range table)
  and 1004 (the release key and keyed unit-cost tables) create new empty tables and add a few
  literal metadata rows. They are additive and pass `migrate --check` when size evidence shows
  the metadata tables are small.
- No backfill is needed. If you imported Part D pricing before, import it again with
  `worker ingest medicare part-d import --kind quarterly --tables pricing` if you want unit costs
  available to the reader.
- `partd_unit_cost` from migration 950 is no longer read or written. A later migration drops it.

## v0.4.1

This release fixes county-only quotes that left part-county silver plans out of the benchmark,
refuses New York rate templates saved before their filing was submitted, and adds PY2025 pricing
rules and plan data for ICHRA look-back. It calculates the EHB portion for plans whose EHB
percentage has up to 15 decimal places, stores availability counts at import so the status page
and `/v1/data-availability` stop recounting rate rows, and makes Part D drug-cost estimate answers
much smaller. It also fixes how Compose passes plugin settings, adds a restore step for backups,
and adds a plugin template and guides for plugin authors and operators.

It has two additive migrations (993 and 994) and one backfill to run after migrating. See
[Upgrading](#upgrading). Answers change where the fixes below say so: county-only quotes in
part-county areas, New York 2026 benchmarks, and EHB-portion figures with long EHB fractions.

### What users notice

- **County-only quotes in part-county areas.** In a county where an on-exchange silver plan
  serves only part of the county, a quote without a ZIP used to leave that plan out of the
  second-lowest silver benchmark and still report an estimated credit. It now returns
  `location_requires_zip` with reason `zip_limited_service_area`, as the ICHRA check already did.
  The credit and net premium are `null` until you send a ZIP, and gross premiums do not change.
  This covers native quotes, `/v1/benchmark`, the compatibility search and the MCP quote tool,
  whose output schema now lists the status. If you quote by county alone, handle this status by
  asking for a ZIP.
- **New York rate templates checked against their filing.** Before using a DFS approved-rates
  template, the state importer compares the workbook's earliest saved date with the filing's
  submission date, read from the same filing's final exhibits. A template saved before the
  submission, or one without usable date evidence, is refused and recorded with a reason code
  such as `template_saved_before_submission`. That insurer's NY 2026 rates are `unknown`. So is
  the NY benchmark in every rating region where one of its plans could be silver and rank, with
  the refusal and the plans in `provenance.refused_templates`. A plan is ruled out only when the
  CMS Plan Attributes give it one non-silver metal level. In the 2026 data one insurer is refused
  and it lists a possible silver plan in all eight regions, so every NY 2026 benchmark is
  `unknown` until approved rates for it are available. Other answers stay as they were.
- **PY2025 pricing rules.** `data/rating-rules/2025.json` covers the 31 states in the PY2025
  Exchange PUF: the 2026 set plus Illinois. Each state prices per member on its filed rate rows
  and cites its own row of the CMS state rating table. New York and Vermont are not in that PUF
  and stay unsupported for 2025. `worker ingest geo` accepts `--year 2025`.
- **PY2025 plan data for ICHRA look-back.** A past plan year can be added to a running catalog
  through the same rating-rule, PUF catalog and geography steps the bootstrap uses, and a rerun
  resumes where the last one stopped. The hosted service loads 2025 during a release with
  `hard-release --load-plan-year 2025`. Bootstrap geography for federal years now registers each
  state's reviewed CMS county spellings, which Illinois needs in 2025.
- **Rating areas for past plan years.** The CMS rating-area pages carry no plan-year version. For
  a plan year earlier than the snapshot's fetch year, the geography importer now uses the table
  only if the page's "Page Last Modified" date falls before that year began, and reports
  `ratingAreaBasis` as `cms_table_unmodified_since`. Otherwise the import fails and that state's
  geography stays `unknown`. South Dakota's page changed in March 2026, so its 2025 geography is
  `unknown`.
- **More EHB portions calculated.** Some PUF files give `EHBPercentTotalPremium` with 13 to 15
  decimal places. The premium split stopped at 12 places and answered `unknown` for those plans.
  It now reads up to 15 places as an exact decimal, with the same cents rounding as before. Values
  with 16 or more places, or outside 0 to 1, still answer `unknown`. On the cached PY2027 Plan
  Attributes file this turns 713 individual medical plan rows in AL, FL, LA, NC, OH, SC, TX and WI
  from `unknown` to a calculated EHB portion, and some PY2027 benchmark answers on the EHB basis
  change from `unknown` to calculated too. PY2026 has no such values and does not change. The
  ICHRA raw-file reading follows the same 15-place limit.
- **Smaller Part D estimate answers.** When all of a plan's county rows hold the same raw value in
  the cited fields, the answer now lists them once as a `source_rows` evidence item. It carries
  the snapshot, table, fields, every row number and the shared values. A figure that cites every
  row of the group cites the group's id. A single row, a missing cell or any differing raw cell
  (spacing counts) keeps the rows listed one by one. Figures do not change, and each still cites
  the same sources once groups are expanded. The largest answer we measured fell from about
  179 KB to 27 KB for 2026. Single-fill answers that used to go past the MCP size limit now fit,
  and the HTTP route and the MCP tool still return the same data.
- **Stricter evidence checks.** The service refuses an answer with duplicate evidence ids, an
  empty or misordered group, a group without its shared values, or a figure whose cited row or
  rule is missing. If you parse `evidence`, handle the new `source_rows` kind. Estimates stay off
  by default (`OPENPLANS_MEDICARE_DRUG_COST`).
- **Faster status page and data availability.** A catalog import now stores each rate file's
  per-plan rate-row counts (migration 993), and `/v1/data-availability` reads those instead of
  counting rate rows for every manifest entry, which took seconds on a national catalog. Catalogs
  imported earlier need a one-time `worker backfill rate-plan-count`. Until then they fall back to
  counting. Responses are the same either way. The status host also keeps its availability
  summary in memory, keyed by the response cache's data generation, so repeat reads of
  `/status.json` and `/status/operator.json` take milliseconds. The first read after new data is
  published computes it again. With the response cache off nothing is kept.

### Self-hosting and operations

- **Migration preflight records size evidence.** `worker migrate --size-evidence` prints capped
  exact row counts, total bytes and planner estimates, read in one read-only transaction.
  `worker migrate --check` classifies with that evidence, includes it as `sizeEvidence`, and
  names the size rule that cleared each file in `sizeRules`. Planner estimates show up in the
  reasons but never clear a statement. The hosted release tool rechecks every rule and keeps the
  evidence in its receipt.
- **Failed CMS API attempts record their source.** Migration 994 adds a trigger so a
  `cms_api_attempt` row with no snapshot says `openplans`, slug `cache:cms-api-attempt`, instead
  of `unknown`, as failed ZIP lookups already did. Attempts logged before the migration keep
  `unknown`.
- **Plugin settings reach every Compose service.** `compose.yml` now passes `OPENPLANS_PLUGINS`
  and `OPENPLANS_CONFIG` to the API, worker and scheduler, with empty defaults. Compose mounts the
  config file read-only at its own path through a top-level `configs:` entry. Before, only the API
  got the plugin list and no service got the config path, so you needed a local override.
- **Empty `OPENPLANS_PLUGINS` counts as unset.** Compose always passes the variable, and an empty
  value used to replace the config file's plugin list with nothing, so plugin options never
  applied. Now the file's list is used. To turn one plugin off, set `"enabled": false` in the
  file. An empty value no longer forces zero plugins.
- **Slack notification runbook.** The self-host docs walk through turning on
  `@openplans/plugin-slack`: the webhook URL and host settings, the access manifest, the
  approved-plugins entry, a preflight check that never prints the webhook, and an optional test
  message. Turning it off is documented too.
- **Scheduler profile.** The Compose `scheduler` profile delivers queued events and runs the
  status plugin's health probe each minute. Worker health on `/status` is live, and the status
  plugin can send worker down and recovered messages. `down` now stops the scheduler too.
- **Backup restore step.** Backups leave out the short-lived pass-through answer tables. After
  restoring one, run `worker backup-restored --manifest <file>` before starting the API. It reads
  the excluded tables from the backup's manifest and marks every pass-through source whose answers
  are gone: it records an `answers_excluded_from_backup` quality issue and quarantines the active
  receipt. It runs in one transaction, and a second run changes nothing. It refuses a manifest
  that lists only some of a source's tables.
- **Backups keep their input list.** Each backup saves `inputs.json` next to the dump and records
  its SHA-256 in the backup receipt. After a restore, audit against that file, not today's source
  list. Backups made before this release have none.
- **Open geocoder extracts use the snapshot store.** The open geocoder's download and prepare
  steps read and write through the configured blob store, so they work with S3-compatible
  storage. With the local store nothing changes. The downloader needs an access manifest that
  admits its host, and none ships.

### Plugins and documentation

- New `plugins/template`, a starting point for your own plugin. It has one public route, one MCP
  tool, one worker command and one event handler, plus tests that use the test kit, load it
  through the worker and check that a broken route fails.
- New `docs/plugins.md`, a guide for self-hosters and plugin authors. It covers enabling plugins,
  the first-party plugins, feed and pass-through sources, cache levels, budgets, events and
  delivery, schedules, status views, migrations and `tablePrefix`, storage providers, and a worked
  example with the test kit. It also lists the load order, refusal and reason codes,
  capabilities, registration rules, an approval checklist, and the versioning policy: what counts
  as a breaking API change, and how plugin versions relate to approved-list entries.
- New `docs/plugins-operations.md` for operators: the config file, the status page and operator
  token, Slack and the signed webhook, the scheduler, pass-through cache levels, the approved
  plugin list, and backups and restores.
- CI builds and runs the guide's example plugin, so the guide stays in step with the SDK.
- `docs/medicare.md` describes the new estimate evidence shape and its checks.
- `docs/configuration.md`, `docs/self-host.md` and `.env.example` list the plugin settings. The
  SDK README corrects its setup database note and lists API changes.

### Fixes

- The Vermont metal-level check applied migrations in string order, so a plugin migration ran
  before one it depends on and the check failed. It now sorts them by number, as `worker migrate`
  does. This affected the check only, not the product.
- The all-states check now loads geography through the worker's importer, which knows the
  reviewed CMS county spellings. It failed on Illinois before.
- Plugin worker tests use their own temporary data directory and never read `OPENPLANS_DATA_DIR`
  from the environment.
- The status availability test fixture had a timeout too short for slow hosts. It now has
  90 seconds.
- The Linux CI job gets 45 minutes. The suite runs close to 20 minutes there, and a run was
  cancelled at the old limit.

### Upgrading

- Pull the new image, run the two steps below with it, then recreate the API and worker. Their
  configuration changed (new empty plugin and config settings), so Compose recreates them even
  at the same image. Expect a short API gap.
- Run `worker migrate`. Migrations 993 (a new empty `rate_plan_count` table) and 994 (a
  function, a trigger and a comment) are additive and pass `migrate --check` without size
  evidence.
- Then run `worker backfill rate-plan-count` once. It stores counts for catalogs imported before
  993, one rate file per transaction, skips files that already have counts, and can be rerun.
  Until it finishes, availability counts rate rows on each read.
- If you restore from a backup, run `worker backup-restored` before starting the API.
- If you set `OPENPLANS_PLUGINS=""` to force no plugins while a config file lists some, mark them
  `"enabled": false` in the file instead.
