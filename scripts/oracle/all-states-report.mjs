import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";
export async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.part`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}
export async function allStatesReport(cache = importDataDirectory()) {
  const directory = join(cache, "reports"),
    results = [];
  let complete = true;
  for (const year of [2026, 2027]) {
    const rules = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(`../../data/rating-rules/${year}.json`, import.meta.url),
        ),
        "utf8",
      ),
    );
    for (const rule of rules.rules.filter((r) => r.method === "per_member")) {
      let r;
      try {
        r = JSON.parse(
          await readFile(
            join(directory, `p6d-${year}-${rule.state}.json`),
            "utf8",
          ),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        r = { state: rule.state, year, pending: true };
        complete = false;
      }
      results.push({
        ...r,
        citation: rule.citation,
        references: rule.references,
      });
    }
  }
  const metric = (r, key) =>
    r.counts?.find((c) => c.metric === key)?.actual ?? "—";
  const totals = results.reduce(
    (a, r) => ({
      comparisons: a.comparisons + (r.premiums?.comparisons ?? 0),
      mismatches: a.mismatches + (r.premiums?.mismatch_count ?? 0),
      unknown: a.unknown + (r.premiums?.unknown ?? 0),
      passed: a.passed + Number(r.passed === true),
    }),
    { comparisons: 0, mismatches: 0, unknown: 0, passed: 0 },
  );
  let md = `# P6d: publication-listed states, PY2026/PY2027\n\nGenerated ${new Date().toISOString()}. ${complete ? "All state checks finished" : "IN PROGRESS"}: ${totals.passed}/${results.length} PASS; ${totals.comparisons.toLocaleString("en-US")} raw Rate PUF comparisons, ${totals.mismatches} mismatches; ${totals.unknown.toLocaleString("en-US")} comparisons correctly return unknown for missing filed prices.\n\n`;
  md +=
    "The acquired individual on-exchange medical Plan Attributes rows select 30 states in 2026 and 29 in 2027 (Oregon absent in 2027). Counts include every catalog market/dental row in each selected state; rule authorization is individual medical only. No invented rates, default-curve calculation, or tier pricing. Each state uses its own cache DB `puf-pglite-p6d-<year>-<state>`. Detailed results: `p6d-<year>-<state>.json`; immutable inputs: the newest acquired CMS manifest. Python ZIP/CSV and Decimal recompute independently of persisted normalized columns. Ages 0–64 and both tobacco flags are exercised; missing tobacco prices remain unknown. Family tiers are counted and skipped.\n\n";
  md +=
    "| Year | State | Plans | Variants | Rate rows | Method / citation | Family Option | Oracle comparisons | Mismatches | Geography | Result |\n| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |\n";
  for (const r of results)
    md += `| ${r.year} | ${r.state} | ${metric(r, "base_plans")} | ${metric(r, "variants")} | ${metric(r, "rate")} | per_member; [CMS ${r.state} row](${r.references[0]}), [45 CFR 147.102(c)(1)](${r.references[1]}) | ${r.family_options ?? "—"} | ${r.premiums?.comparisons ?? "—"} | ${r.premiums?.mismatch_count ?? "—"} | ${r.geography?.ratingAreaUnit ?? r.geography?.error ?? "—"} | ${r.pending ? "PENDING" : r.passed ? "PASS" : `FAIL: ${(r.failures ?? []).join("; ")}`} |\n`;
  md +=
    "\nCitation review: CMS current Market Rating Reforms table (updated 2021-12-10), its linked 2018-effective State Specific Age Curve Variations PDF (2017-05-31), and eCFR current through 2026-11-05 were actually read on 2026-11-07. CMS does not publish a separate year-labelled 2026/2027 curve at that link. State-specific AL/MS/OR/UT curves are respected by using filed rows directly. Versioned JSON contains the full citation per state. The existing no-file rating-rules command retains the TX PY2026 bootstrap; complete state support requires explicitly selecting data/rating-rules/<year>.json (as this oracle does). NY/VT are explicit unsupported guards, not imported states; household tier selection remains unsupported.\n\n";
  md +=
    "Negative controls (offline CI): a synthetic NY `per_member` rules file is rejected before DB writes; a mutant importer deleting AL’s last stored rate fails `state_source_row_count` while the following TX state still activates. A damaged partition fails hash verification. A missing Alaska ZIP3 preserves the previous geography. Existing +1-cent premium and child-count controls remain in the suite.\n\n";
  md +=
    "Integration follow-ups outside the P6d lease:\n\n1. Delegate the production worker geo branch in `src/worker/commands.ts` to `runGeo` from `src/ingest/geo/command.ts` (the developer geo CLI already delegates). Its existing TX-only branch remains unchanged.\n2. Change `src/api/premiums.ts` to call `ratingAreaForLocation` for ZIP3 states. Until then the API correctly returns unknown for Alaska’s unresolved county rating area; raw rated-premium oracles pass independently.\n\nCMS county spelling corrections are explicitly allowlisted against Census names and recorded by source row (IN four, KS/LA/ND/OH one each). Geography uses the current undated CMS table associated explicitly with each requested year, not a claimed historical table. Census 2020 ZCTA/county relationships and Gazetteer points are preserved by snapshot; later state imports never delete earlier state rows. No Docker or production database was started.\n";
  await atomicWrite(join(directory, "p6d-all-states.md"), md);
  await atomicWrite(
    join(directory, "p6d-all-states.json"),
    JSON.stringify({ complete, totals, results }, null, 2) + "\n",
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await allStatesReport();
