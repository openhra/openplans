# Changelog

Release notes for OpenPlans. Earlier releases are on the
[GitHub releases page](https://github.com/openhra/openplans/releases).

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
