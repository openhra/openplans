# Individual offer distribution

`@openplans/plugin-compare` 0.1.4 shows gross monthly premiums across individual medical plans for one exact age or an explicitly aged household. The package is opt-in; library defaults do not load it. This preparation does not enable a public deployment.

## Public configuration

An operator can load the public surface with this config. Keep both TPA switches off:

```json
{
  "version": 1,
  "public": { "quoting": true },
  "tpa": { "enabled": false, "privateIngress": false },
  "plugins": [{ "package": "@openplans/plugin-compare", "enabled": true }]
}
```

This registers three public routes and one read-only MCP tool:

| Surface                    | Use                                                       |
| -------------------------- | --------------------------------------------------------- |
| `GET /compare/v1`          | Browser forms for one age or up to ten household members. |
| `GET /compare/v1/market`   | JSON distribution and paged evidence.                     |
| `POST /compare/v1/print`   | Printable HTML from JSON or a browser form.               |
| MCP `compare_market_costs` | The same distribution as the JSON route.                  |

Start at `/compare/v1`. The form links to loaded-data status and county lookup; results link back to the form, JSON evidence and the next printable evidence page. Use the browser's Print command for Letter or A4. The form needs no JavaScript or operator credentials.

With either TPA switch off, `/compare/v1/employer` and `/compare/v1/employer-print` do not register. There is no public group quote or census tool. Both private routes require the TPA switches and operator authentication in a private installation; their workflow is outside this public launch.

## Requests

One age:

```sh
curl 'http://127.0.0.1:3000/compare/v1/market?zip=77002&county=48201&year=2026&age=40'
```

A household print sheet:

```sh
curl -X POST 'http://127.0.0.1:3000/compare/v1/print' \
  -H 'Content-Type: application/json' \
  -d '{"zip":"77002","county":"48201","year":2026,"members":[{"age":40,"relationship":"subscriber"},{"age":40,"relationship":"spouse"},{"age":10,"relationship":"child"},{"age":8,"relationship":"child"}]}'
```

For MCP, call `compare_market_costs` with either request's JSON fields. For household GET requests, encode the `members` JSON array as a query value. Each member supplies an integer age and a relationship: `subscriber`, `spouse`, `child` or `other`. JSON accepts up to 100 members; the browser form offers ten rows. Supply either `age` or `members`, never both.

Year and location are required. Age is an integer from 0 to 120. Defaults are January 1, non-tobacco, individual medical, on-exchange Silver and gross premiums. Select `bronze`, `expanded bronze`, `silver` or `gold` with `metal`; each result covers one metal. A ZIP that spans counties needs an explicit five-digit county FIPS. County-only requests need a ZIP when service areas or rating areas cover part of the county.

Tobacco rating, other dates, other metals, private fields and plan shortlists are refused. Public input containing employer contributions, group renewals, group quotes or census fields is invalid on REST, print and MCP. The form parser also rejects unknown fields and duplicate values. No premiums are invented to fill a gap.

## Counts and prices

The candidate count is distinct on-exchange medical base plans in the selected metal at the resolved location, including counted family exclusions and unresolved candidates. Family-ineligible offers are excluded from prices and counted separately with source rows. CSR variants do not add offers. Eligible plans are rated for the entire household using filed rating rules, including child charging limits and supported state family tiers. Operator catalog annotations do not narrow this public universe.

The headline is unknown if a potentially eligible plan cannot be classified or rated. Counts stay null when the universe cannot be established. A complete empty cohort has count zero and null amounts. A filed zero premium stays zero. Median and mean retain exact reduced ratios in cents, with half-up display rounding. P25 and P75 use one-based nearest ranks, `ceil(p × n)`. Prices are unweighted across plans. Fewer than four rated plans carries `small_offer_set`.

Completeness describes admitted local sources, not every plan sold. Check `/v1/data-availability` for the loaded geography, plan year, publishers and gaps. Prices come from admitted CMS or state-filed public source rows; source URLs, hashes, row references and available source dates accompany the result. An unloaded year or unresolved rating method stays unknown. No nationwide or future-year coverage is promised by enabling the plugin.

## Evidence and print

The scan examines the full cohort before paging evidence. Each page contains up to two rated candidates, two exclusions and two unknowns. Send `evidence_page` and the returned `data_generation` for later pages. The token pins the data revision and calculation manifest for both age and household results. Changed or incomplete tokens refuse the page; start again at page one. Every page repeats full-cohort counts and statistics.

The printed appendix identifies its evidence page and any remaining pages. It preserves source hashes, rows, exact statistics and generation; it is not the complete appendix until all pages are inspected or printed. The sheet labels public group costs unavailable. It computes no employer budget, subsidy, affordability decision or group saving. An individual plan distribution is not a coverage comparison or a bindable quote.

## Host limits and checks

Public quoting must be enabled. All three routes declare 30 requests per minute, two active requests per source and four total. MCP uses the host transport's admission, cancellation and 64 KiB output limit; an oversized answer refuses rather than dropping required evidence. Responses use `Cache-Control: no-store`, calculations use the request's read-only database and abort signal, and inputs are not retained.

`CalculationHost.enumerateHouseholdOffers` reuses core offer enumeration and rating. It grants no database pool, outbound fallback or persistence. No new calculation framework or census engine is added by this plugin.

The offline suite covers the public route inventory, actual MCP calls, household eligibility, exact statistics, missing prices, stale evidence pins, browser forms and print output. `tests/fixtures/plugins/response-digests-compare-on.json` records only the enabled surface, separately from frozen disabled-state recordings. Its synthetic request identities and fixed clocks wrap the existing public-source fixture cuts. To intentionally record this fixture after an approved enabled-contract change, run `OPENPLANS_RECORD_COMPARE_DIGESTS=1 npm test -- plugins/compare/tests/public-launch.test.ts` after building. Never use that command to update disabled-state fixtures.

Deployment approval still requires testing the approved package and public edge with representative cached data, release latency/concurrency checks, and a visitor smoke test.
