# Lowest Silver by ZIP

This feature is off by default. An operator can enable `lowestPremiums: true` for a reviewed installation. With the default `full` scope, enabling it also registers market summaries, household minimums and MCP `get_benchmark`. For a public ZIP launch, set `lowestPremiumsScope: "single_age_silver"` as well. That scope admits non-tobacco Silver minimums and unpriced market counts only. It omits household POSTs and MCP benchmark and rejects excluded inputs at the API boundary. See [configuration](configuration.md) for access settings.

Start with a five-digit ZIP, an explicit plan year and the person's age. Ask `GET /v1/zip-counties?zip=77002` for the county choices. If more than one county matches, ask the visitor to choose. Never select the first county for them.

Then request the gross, non-tobacco Silver minimum:

```sh
curl --get http://127.0.0.1:3000/v1/lowest-premiums \
  --data-urlencode zip=77002 --data-urlencode county=48201 \
  --data-urlencode year=2026 --data-urlencode age=40 \
  --data-urlencode metal=silver --data-urlencode tobacco=false
```

The request reads a built cell. HTTP 404 with `error.code: "lowest_not_built"` means the county/year/age cell is unpublished or expired. It does not establish whether plans cover the location. MCP returns the same code as a tool error. Keep the amount unknown and let the visitor try a published input.

Display an amount only when `status` is `calculated`. Divide `lowest.monthly_cents` by 100 for dollars. Show the year, age, county, January 1 coverage basis, `candidate_count`, tied-plan count and source retrieval dates from `provenance.snapshots`. Link to the full JSON result so the visitor can inspect the source hashes, rate rows and completeness. Paginate evidence with `evidence_page`; it does not change the winner.

A filed zero is a price. A null amount is unknown. Missing pricing for a potentially cheaper eligible plan makes the minimum unknown. `no_plans` means no matching offers in a loaded scope; it does not mean the catalog is missing. Preserve `ambiguous`, `location_requires_zip` and every unknown reason. Do not replace a refused answer with a zero or a price from another year.

The amount is a gross on-exchange individual medical premium. It excludes subsidies, uses non-tobacco rating and covers January 1 of the selected year. It is not a bindable quote. It is also separate from the second-lowest-cost Silver benchmark, which applies EHB and pediatric dental adjustments.

## Related requests

`GET /v1/market-summary` accepts the same geography and year. Without an age it returns base-plan and issuer counts. With an age it adds gross ranges for supported metals. Bronze and expanded bronze remain separate. Counts alone do not establish that every offer has a known price.

`POST /v1/lowest-premiums` and `POST /v1/market-summary` accept one to ten explicit members under the existing household admission policy. Each member needs age, relationship and tobacco. These requests rate the whole household, including filed family tiers where supported. They do not sum each member's cheapest plan. Household results remain uncached. Their evidence pages contain two detail rows plus the selected minimum and maximum evidence. Follow `next_evidence_page` for the rest. In household rating evidence, each member's `rate_row_refs` indexes that rating's complete `rate_rows_used` array. Shared rows keep their source snapshots and row numbers.

MCP adds `get_lowest_premiums`, `get_market_summary` and `get_benchmark`. The first two follow public quoting; member inputs and the benchmark also require household access. Results must fit the 128 KiB transport budget. An oversized household, benchmark or summary result refuses with `RESULT_TOO_LARGE`. Single-age minimums mark omitted detail rows and provide evidence pagination.

## Source scope

Use the installation's `/v1/data-availability` response for the actual served geography and years. Loaded public CMS and state files differ by year. A website coverage count does not certify a complete minimum for every ZIP. New York and Vermont need their separate admitted family-tier sources. Alaska and ZIP-limited service areas need ZIP-level evidence. Published cells in unloaded, incomplete or unsupported scopes report their evidence gaps.

Sources are public CMS Exchange files, state-filed rates and Census geography, with the snapshot citations returned by each answer. No live source fetch or CMS credential is needed for these calculations.

## Prepare published cells

The county publication format replaces older derived cells. Run a prebuild after migrating.

Mount the admitted national Census relationship snapshot at its recorded raw path. State-scoped lookup tables alone do not contain every county. The default prebuild refuses a missing or corrupt snapshot.

Run `worker prebuild lowest-premiums --years 2026,2027 --dry-run` to count one cell per county, year and age from 0 through 64 in the loaded geography. Remove `--dry-run` to build them. ZIP inputs resolve to these counties at request time. Ambiguous ZIPs still require a county choice. Ages 64 and over use the filed 64+ cell or the admitted state community-rating rule; missing rules stay unknown.

The worker rates Silver, non-tobacco, January 1 inputs. Each cell stores the winner and a shared evidence reference. One lossless binary dictionary per county/year holds complete source evidence across ages. Compact rows refer to its plan, issuer, metal and snapshot strings; the row also records pricing generation and expiry. Results retain the requested age and location. A county with ZIP-limited offers or sub-county rating areas returns `location_requires_zip` with no price, including when a ZIP was supplied, because a county cell cannot certify a ZIP-specific minimum.

Publications must fit the 1 GiB payload and 2 GiB total storage limits. To publish a bounded set, pass `--inventory /absolute/path/cells.json`. The file is a JSON array of request objects. ZIP forms and ages above 64 normalize to county cells:

```json
[{ "zip": "77002", "county": "48201", "year": 2026, "age": 40 }]
```

Use `--max-cells 1000` to limit new builds in one invocation. Rerun the same command to resume; fresh cells are reused. Partial runs exit 2 and have no completion digest. A complete run audits stored cells and reports counts, an inventory hash, a result digest, elapsed time, uncompressed binary dictionary and cell bytes, stored payload bytes and database bytes. Two unchanged runs must produce the same digest. Retain that report with the release evidence.

Build again after any pricing snapshot, geography, rating rule or algorithm change, and before the earlier of the cell's one-day expiry and its source snapshot expiry. Record policies can shorten that lifetime. A failed or partial prebuild does not certify the inventory. Keep the switch off until the intended set passes its audit. Requests for other inputs return `lowest_not_built` without running a calculation.

## Audit a disposable catalog

After building the application, run `node scripts/oracle/lowest-public.mjs --disposable --report /tmp/lowest-public.json` with `DATABASE_URL` pointing to a local PostgreSQL clone whose database name ends in `_lowest_public`. The command refuses other database names and remote hosts. It runs migrations and builds derived cells only on that clone. Set `OPENPLANS_DATA_DIR` to the admitted public-data cache; Texas checks read the pinned raw files without fetching them.

Add `--public-scope` to time only the restricted launch paths. The report separates correctness from performance. It checks both plan years, dense and sparse markets, whole-household totals, source checksums and missing-rate refusals. Timings use 200 requests per path at concurrency four. Initial per-path observations follow correctness checks and do not measure a cold deployment. A missed latency target makes the command fail. The HTTP timing uses the in-process application with a real PostgreSQL connection; release acceptance must also check the candidate image and edge.
