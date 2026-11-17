#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  lowestInputSchema,
  marketSummaryInputSchema,
} from "../dist/api/handy.js";

export const start = "<!-- lowest-premiums:generated -->";
export const end = "<!-- /lowest-premiums:generated -->";
export function handyDocs() {
  return `${start}
## Lowest premiums and market summary

Enable \`OPENPLANS_LOWEST_PREMIUMS=on\` or \`lowestPremiums: true\` in the config file.
The default is off. Set \`lowestPremiumsScope: "single_age_silver"\` to admit only ZIP-based non-tobacco Silver minimums and unpriced market counts. This scope omits household POSTs and MCP benchmark; direct calls reject the excluded inputs. The default \`full\` scope retains the contracts below.
For a ZIP visitor flow, see [Lowest Silver by ZIP](https://github.com/openhra/openplans/blob/main/docs/lowest-silver.md).
The GET routes and single-age MCP tools follow the public quoting switch and admission
limits. Responses use \`Cache-Control: no-store\`; MCP pricing is uncached.

\`GET /v1/lowest-premiums?zip=77002&county=48201&year=2026&age=40\` returns the lowest
gross on-exchange premium for one person. Send both year and age. It supports silver,
bronze, expanded bronze and gold, tobacco selection, individual medical plans and January 1 coverage.
The answer does not evaluate subsidies and is not a bindable quote.

Accepted fields: ${[...Object.keys(lowestInputSchema.shape), "evidence_page"]
    .map((key) => `\`${key}\``)
    .join(", ")}.
The route rejects unknown fields. Select a county when a ZIP spans several.
Missing catalog or candidate pricing evidence returns an unknown result with no minimum.
Send a ZIP when offers or rating areas cover only part of a county.
Tied plan IDs are sorted and paged at 50. MCP tie pages use a generation-bound cursor. Candidate and evidence details use \`evidence_page\`, with 10 candidates per page. Every page keeps the winner, exact integer cents, total tie count, completeness and source references. The MCP response has a 128 KiB byte limit. It marks omitted rows with \`truncated\` and \`omitted\`. REST defaults to the first tie and evidence pages; use \`page\` and \`evidence_page\` to read more. The result is a gross premium, separate from SLCSP.

\`GET /v1/market-summary?zip=77002&county=48201&year=2026\` and MCP \`get_market_summary\`
report distinct on-exchange base-plan and issuer counts by metal. Add \`age\` to request gross minimum
and maximum prices. Tobacco can be set only with an age. Counts keep bronze and expanded bronze
separate. Missing catalog data stays unknown, and a ZIP that spans counties needs an explicit county.
Platinum and catastrophic counts are available, but their price ranges are not supported.

Market summary fields: ${[...Object.keys(marketSummaryInputSchema.shape)].map((key) => `\`${key}\``).join(", ")}.

Household requests use \`POST /v1/lowest-premiums\` or \`POST /v1/market-summary\` at the same paths.
Send \`year\`, a \`zip\` or \`county\`, and 1 to 10 \`members\`. Each member supplies an integer
\`age\`, \`relationship\` and boolean \`tobacco\`. Relationships are \`subscriber\`, \`spouse\`,
\`child\` or \`other\`. Optional \`coverage_start\` defaults to January 1 of the requested year.
The minimum defaults to silver. The summary covers supported metals unless \`metal\` is selected.
Household routes use the existing household token or public-household policy. They rate every
eligible plan for the complete household, including child charging limits and filed family tiers.
They accept no income, names, birth dates or preset households and never cache household results.
MCP \`get_lowest_premiums\` and \`get_market_summary\` also accept members, with the household grant.
Household evidence pages contain two detail rows plus the selected minimum/maximum evidence. Follow \`next_evidence_page\` to inspect the remaining rows. Member \`rate_row_refs\` index the complete \`rating.rate_rows_used\` table within that evidence record.
Supply either a single age or members. Household tie pages contain 50 IDs; candidate evidence uses
\`evidence_page\` with 10 rows per page plus the selected extremes. Evidence references resolve within each page.
An oversized MCP result returns \`RESULT_TOO_LARGE\` rather than dropping required evidence.

MCP \`get_benchmark\` takes \`year\`, \`location: {zip, county}\` and 1 to 100 integer \`ages\`.
It follows household access rules and the same feature switch. Its result preserves the existing
\`GET /v1/benchmark\` answer and adds a basis describing January 1, non-tobacco pricing,
EHB allocation and pediatric dental adjustment. Missing adjustment evidence stays unknown.
The existing REST benchmark and ICHRA calculations keep their current contracts.

Build an exact location/age cell with
\`worker build lowest-premiums --year 2026 --age 40 --zip 77002 --county 48201\`.
This command requires migrated tables and admitted imported data. Successful imports
rebuild registered cells while the switch is on. Other cells rate the full candidate list.
A stale, expired, incomplete or absent build also rates the full list. This fallback
remains available if a rebuild fails. Derived payloads are bounded to 1 GiB, reserving the rest of the
2 GiB allowance for manifests and indexes; one cell may use at most 2 MiB.
${end}`;
}
const path = new URL("../src/api/README.md", import.meta.url);
const text = await readFile(path, "utf8");
const block = handyDocs();
const updatedRaw = text.includes(start)
  ? text.slice(0, text.indexOf(start)) +
    block +
    text.slice(text.indexOf(end) + end.length)
  : text.trimEnd() + `\n\n${block}\n`;
const updated = await format(updatedRaw, { parser: "markdown" });
if (process.argv.includes("--check")) {
  if (updated !== text) throw new Error("Run node scripts/handy-docs.mjs");
} else await writeFile(path, updated);
