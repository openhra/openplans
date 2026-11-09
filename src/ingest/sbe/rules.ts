import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestRatingRules } from "../rating-rules/index.js";
import type { Database } from "../../db/database.js";
import { CA_INDIVIDUAL_TOBACCO_POLICY } from "../../domain/rating/medical-policy.js";

export const supportedSbeStates = [
  "CA",
  "CO",
  "CT",
  "DC",
  "GA",
  "ID",
  "IL",
  "KY",
  "ME",
  "MD",
  "MA",
  "MN",
  "NV",
  "NJ",
  "NM",
  "PA",
  "RI",
  "VA",
  "WA",
];
/** Complete year document: adding SBE authorization never drops federal rules. */
export async function sbeRulesFile(
  dataDir: string,
  year: number,
): Promise<string> {
  const original = fileURLToPath(
    new URL(`../../../data/rating-rules/${year}.json`, import.meta.url),
  );
  if (year !== 2026) return original;
  const document = JSON.parse(await readFile(original, "utf8"));
  for (const state of supportedSbeStates)
    if (!document.rules.some((r: { state: string }) => r.state === state))
      document.rules.push({
        state,
        market: "individual",
        method: "per_member",
        citation:
          state === CA_INDIVIDUAL_TOBACCO_POLICY.state
            ? CA_INDIVIDUAL_TOBACCO_POLICY.provenance.citation
            : `${state}: CMS Market Rating Reforms individual-market state row; 45 CFR 147.102(c)(1), (d), (e), current through 2026-11-05; PY2026 reviewed 2026-11-08. Use each filed age/area/date/tobacco row verbatim, never an inferred curve. Family tiers and composite rows require a separate adapter.`,
        references: [
          "https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating",
          "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.102",
        ],
        member_rate_basis: "filed_rate_rows",
        child_rule: "three_oldest_covered_children_under_21",
      });
  document.reviewed_on = "2026-11-08";
  document.notes = [
    ...(document.notes ?? []),
    "Extended with the CMS PY2026 SBE publication-listed individual medical states. Only filed per-member rows are authorized; no dental or SHOP policy is inferred. NY/VT keep their separate cited filed-tier path.",
  ];
  const directory = join(dataDir, "derived", "sbe");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rating-rules-${year}.json`);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  // Content is deterministic; immutable snapshot identity remains its SHA-256.
  if ((await readFile(path, "utf8").catch(() => null)) !== bytes)
    await writeFile(path, bytes);
  return path;
}
export async function activateSbeRules(
  db: Database,
  dataDir: string,
  year: number,
) {
  return ingestRatingRules(db, await sbeRulesFile(dataDir, year));
}
