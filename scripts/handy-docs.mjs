#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { lowestInputSchema } from "../dist/api/handy.js";

export const start = "<!-- lowest-premiums:generated -->";
export const end = "<!-- /lowest-premiums:generated -->";
export function handyDocs() {
  return `${start}
## Lowest silver premium

Enable \`OPENPLANS_LOWEST_PREMIUMS=on\` or \`lowestPremiums: true\` in the config file.
The default is off. This route and \`get_lowest_premiums\` follow the public quoting switch
and admission limits. Responses use \`Cache-Control: no-store\`; MCP pricing is uncached.

\`GET /v1/lowest-premiums?zip=77002&county=48201&year=2026&age=40\` returns the lowest
gross on-exchange silver premium for one person. Both year and age are required.
Only individual medical plans, non-tobacco prices and January 1 coverage are supported.
The answer does not evaluate subsidies and is not a bindable quote.

Accepted fields: ${[...Object.keys(lowestInputSchema.shape), "evidence_page"]
    .map((key) => `\`${key}\``)
    .join(", ")}.
Unknown fields are rejected. An ambiguous ZIP requires a county selection.
Missing catalog or candidate pricing evidence returns an unknown result with no minimum.
County-only requests refuse when ZIP-specific offers or rating areas require a ZIP.
Tied plan IDs are sorted and paged at 50. MCP tie pages use a generation-bound cursor. Candidate and evidence details use \`evidence_page\`, with 10 candidates per page. Every page keeps the winner, exact integer cents, total tie count, completeness and source references. The MCP response has a 64 KiB byte limit. It marks omitted rows with \`truncated\` and \`omitted\`. REST defaults to the first tie and evidence pages; use \`page\` and \`evidence_page\` to read more. The premium basis is gross and separate from SLCSP.

Build an exact location/age cell with
\`worker build lowest-premiums --year 2026 --age 40 --zip 77002 --county 48201\`.
This command requires migrated tables and admitted imported data. Successful ingest commands
rebuild previously registered cells while the switch is on. Other cells use full enumeration.
A stale, expired, incomplete or absent build also uses full enumeration. Failed rebuilds leave
that fallback available. Derived payloads are bounded to 1 GiB, reserving the rest of the
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
