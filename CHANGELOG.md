# Changelog

Release notes for OpenPlans. Earlier releases are on the
[GitHub releases page](https://github.com/openhra/openplans/releases).

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
