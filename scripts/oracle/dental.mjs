#!/usr/bin/env node
import { mutateSource, sourceControls } from "./source-controls.mjs";
import { homedir } from "node:os";
/** npm run build && node scripts/oracle/dental.mjs (cache only; owns its P5e DB). */
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { database, portableMigrations } from "./negative-controls.mjs";
import { migrate } from "../../dist/db/migrate.js";
import { importPufs } from "../../dist/ingest/puf/import.js";
import { cachedImportFiles } from "../../dist/ingest/puf/import-source.js";
import { ingestGeo } from "../../dist/ingest/geo/index.js";
import { storedRate } from "../../dist/api/premiums.js";
import { createApp } from "../../dist/api/app.js";
import { dentalPremium, parseRateRow } from "../../dist/domain/rating/index.js";
import {
  checkDentalRow,
  familyMembers,
  household,
  unsupportedMembership,
} from "./dental-logic.mjs";
const cache =
  process.env.OPENPLANS_DATA_DIR ||
  join(homedir(), ".local", "share", "openplans");
if (!isAbsolute(cache)) throw new Error("Absolute OPENPLANS_DATA_DIR required");
const reports = join(cache, "reports");
await mkdir(reports, { recursive: true });
const scratch = await mkdtemp(join(reports, ".p5e-dental-"));
const report = {
  passed: false,
  generated_at: new Date().toISOString(),
  state: "TX",
  year: 2026,
  comparisons: 0,
  checked_rate_rows: 0,
  mismatches: [],
  household_comparisons: 0,
  family_option_comparisons: 0,
  negative_controls: [],
  harris_examples: [],
  failures: [],
};
const check = (condition, message) => {
  if (!condition) report.failures.push(message);
};
let db;
try {
  const acquired = await cachedImportFiles(cache, 2026);
  const expectedPath = join(scratch, "expected.jsonl"),
    rawPath = join(scratch, "raw.json");
  console.log("dental oracle: independent raw CSV/Decimal expectations");
  await new Promise((resolve, reject) => {
    const p = spawn(
      "python3",
      [
        fileURLToPath(new URL("./dental-reference.py", import.meta.url)),
        "--cache",
        cache,
        "--manifest",
        acquired.manifestPath,
        "--output",
        expectedPath,
        "--summary",
        rawPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Independent CSV oracle exited ${code}`)),
    );
  });
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  report.sources = raw.sources;
  report.raw_counts = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key.includes("rows")),
  );
  db = database(new PGlite(join(cache, "puf-pglite-p5e-dental")));
  await migrate(db, await portableMigrations(join(scratch, "migrations")));
  let active = (
    await db.query(
      "SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
    )
  ).rows[0];
  if (active) {
    const saved = (
      await db.query(
        "SELECT f.kind,s.sha256 FROM puf_import_file f JOIN snapshot s ON s.snapshot_id=f.snapshot_id WHERE f.import_id=$1",
        [active.import_id],
      )
    ).rows;
    if (
      saved.length !== acquired.files.length ||
      acquired.files.some(
        (f) => !saved.some((s) => s.kind === f.kind && s.sha256 === f.sha256),
      )
    )
      active = undefined;
  }
  if (!active) {
    console.log(
      "dental oracle: importing acquired TX catalog into isolated P5e database",
    );
    const imported = await importPufs(db, {
      year: 2026,
      state: "TX",
      dataDir: cache,
      files: acquired.files,
      manifestPath: acquired.manifestPath,
    });
    if (!imported.passed)
      throw new Error(`Catalog quarantined: ${imported.report_json}`);
    active = { import_id: imported.import_id };
  }
  report.import_id = active.import_id;
  const files = Object.fromEntries(
    (
      await db.query(
        "SELECT kind,snapshot_id FROM puf_import_file WHERE import_id=$1",
        [active.import_id],
      )
    ).rows.map((r) => [r.kind, r.snapshot_id]),
  );
  const stored = (
    await db.query(
      `SELECT r.*,r.effective_date::text AS effective_date,r.expiration_date::text AS expiration_date FROM rate r
    JOIN plan p ON p.base_plan_id=r.base_plan_id AND p.snapshot_id=$1 AND p.dental_only WHERE r.snapshot_id=$2`,
      [files["plan-attributes"], files.rate],
    )
  ).rows;
  const groups = new Map();
  const key = (plan, area) => JSON.stringify([plan, area]);
  for (const row of stored) {
    const k = key(row.base_plan_id, row.rating_area_id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(storedRate(row));
  }
  const rules = new Map();
  for (const row of (
    await db.query(
      "SELECT base_plan_id,raw,source_row FROM business_rule WHERE snapshot_id=$1 AND dental_only",
      [files["business-rules"]],
    )
  ).rows) {
    if (!rules.has(row.base_plan_id)) rules.set(row.base_plan_id, []);
    rules.get(row.base_plan_id).push(row);
  }
  check(
    stored.length === raw.tx_rate_rows,
    `SADP row count ${stored.length} != raw ${raw.tx_rate_rows}`,
  );
  console.log(`dental oracle: comparing all ${stored.length} TX SADP rows`);
  let familySample;
  for await (const line of createInterface({
    input: createReadStream(expectedPath),
    crlfDelay: Infinity,
  })) {
    const expected = JSON.parse(line),
      isTx = expected.state === "TX";
    const rows = isTx
      ? (groups.get(key(expected.plan, expected.area)) ?? [])
      : [
          parseRateRow(expected.raw, {
            snapshotId: `sha256:${raw.sources.rate.sha256}`,
            sourceFile: "rate",
            sourceRowNumber: expected.source_row,
          }),
        ];
    const br = isTx ? (rules.get(expected.plan) ?? []) : expected.business;
    const result = checkDentalRow(expected, rows, br);
    report.comparisons += result.comparisons;
    if (isTx) report.checked_rate_rows++;
    else report.family_option_comparisons += result.comparisons;
    report.mismatches.push(...result.mismatches);
    if (
      !familySample &&
      expected.age === "Family Option" &&
      !unsupportedMembership(expected, familyMembers(2), br) &&
      expected.prices.PrimarySubscriberAndTwoDependents !== null &&
      expected.prices.PrimarySubscriberAndThreeOrMoreDependents !== null &&
      expected.prices.PrimarySubscriberAndTwoDependents !==
        expected.prices.PrimarySubscriberAndThreeOrMoreDependents
    )
      familySample = { expected, rows, br };
  }
  check(
    report.checked_rate_rows === raw.tx_rate_rows,
    "Not every raw TX SADP row was checked",
  );
  for (const expected of raw.household_cases) {
    const result = dentalPremium(
      groups.get(key(expected.plan, expected.area)) ?? [],
      expected.plan,
      expected.area,
      household(expected.members, expected.effective),
      expected.state,
      rules.get(expected.plan) ?? [],
      expected.market,
    );
    const unsupported = unsupportedMembership(
      expected,
      expected.members,
      rules.get(expected.plan) ?? [],
    );
    if (
      result.status !== (unsupported ? "unsupported_rating_method" : "rated") ||
      result.totalCents !== (unsupported ? null : expected.expected_cents) ||
      (!unsupported &&
        JSON.stringify(
          result.members.filter((m) => m.charged).map((m) => m.memberId),
        ) !== JSON.stringify(expected.charged_ids))
    ) {
      report.mismatches.push({
        kind: "mixed_household",
        ...expected,
        actual_status: result.status,
        actual_cents: result.totalCents,
      });
    }
    report.household_comparisons++;
  }
  if (!familySample)
    throw new Error(
      "No distinct published two-/three-dependent family control found",
    );
  const mutantDir = join(scratch, "mutant");
  await cp(
    fileURLToPath(new URL("../../dist/domain/rating/", import.meta.url)),
    mutantDir,
    { recursive: true },
  );
  await writeFile(join(scratch, "package.json"), '{"type":"module"}');
  const source = await readFile(join(mutantDir, "dental.js"), "utf8");
  await writeFile(
    join(mutantDir, "dental.js"),
    mutateSource(source, sourceControls.dental),
  );
  const mutant = (
    await import(pathToFileURL(join(mutantDir, "dental.js")).href)
  ).dentalPremium;
  const baseline = checkDentalRow(
    familySample.expected,
    familySample.rows,
    familySample.br,
  );
  const broken = checkDentalRow(
    familySample.expected,
    familySample.rows,
    familySample.br,
    mutant,
  );
  report.negative_controls.push({
    name: "two_dependents_mapped_to_three_or_more",
    passed: baseline.mismatches.length === 0 && broken.mismatches.length > 0,
    plan: familySample.expected.plan,
    source_row: familySample.expected.source_row,
    baseline_mismatches: baseline.mismatches.length,
    mutant_mismatches: broken.mismatches.length,
    example: broken.mismatches[0],
    scope:
      "temporary compiled source copy; unmodified published non-TX Family Option row",
  });
  for (const state of ["NY", "VT"]) {
    const r = familySample.rows.map((r) => ({ ...r, stateCode: state })),
      e = { ...familySample.expected, state };
    const result = dentalPremium(
      r,
      e.plan,
      e.area,
      household(familyMembers(2), e.effective),
      state,
      familySample.br,
    );
    report.negative_controls.push({
      name: `${state}_dental_no_federal_math`,
      passed:
        result.status === "unsupported_rating_method" &&
        result.totalCents === null,
      status: result.status,
      total_cents: result.totalCents,
      scope: "synthetic state relabelling of raw federal rows",
    });
  }
  console.log("dental oracle: Harris HTTP examples");
  if (
    !(
      await db.query(
        "SELECT 1 FROM geo_import WHERE state='TX' AND plan_year=2026",
      )
    ).rows.length
  )
    await ingestGeo(db, { dataDir: cache, state: "TX", planYear: 2026 });
  const token = "synthetic-oracle-request-token",
    app = createApp(db, { premiumToken: token });
  const examplePlan = raw.harris_ids.find(
    (id) =>
      raw.household_cases.filter(
        (c) => c.plan === id && c.area === "Rating Area 10",
      ).length === 5 &&
      raw.plans[id].attributes.every(
        (a) => a.raw.ChildOnlyOffering === "Allows Adult and Child-Only",
      ) &&
      raw.household_cases
        .filter((c) => c.plan === id && c.area === "Rating Area 10")
        .slice(0, 3)
        .every(
          (c) => !unsupportedMembership(c, c.members, rules.get(id) ?? []),
        ),
  );
  if (!examplePlan) throw new Error("No eligible raw Harris example plan");
  for (const expected of raw.household_cases
    .filter((c) => c.plan === examplePlan && c.area === "Rating Area 10")
    .slice(0, 3)) {
    const response = await app.request("/v1/premium-quotes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        plan_ids: [examplePlan],
        county: "48201",
        coverage_start: expected.effective,
        members: expected.members.map(({ age, relationship, tobaccoUse }) => ({
          age,
          relationship,
          tobacco: tobaccoUse,
        })),
      }),
    });
    const body = await response.json(),
      actual = body.quotes?.[0];
    const passed =
      response.status === 200 &&
      actual?.coverage === "dental" &&
      actual.status === "rated" &&
      actual.total_cents === expected.expected_cents &&
      actual.bindable_quote === false &&
      actual.pediatric_ehb.monthly_cents === expected.pediatric_ehb_cents;
    report.harris_examples.push({ passed, expected, response: actual ?? body });
  }
  check(
    report.harris_examples.length === 3 &&
      report.harris_examples.every((e) => e.passed),
    "Harris HTTP examples differ from independent raw arithmetic",
  );
  check(
    report.negative_controls.length === 3 &&
      report.negative_controls.every((c) => c.passed),
    "Negative control failed to detect defect",
  );
  check(
    report.mismatches.length === 0,
    `${report.mismatches.length} independent oracle mismatches`,
  );
} catch (error) {
  report.failures.push(error.stack ?? String(error));
} finally {
  await db?.close();
  report.passed = !report.failures.length;
  await writeFile(
    join(reports, "p5e-dental.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  const exampleLines = report.harris_examples.map(
    (e, i) =>
      `${i + 1}. ${e.expected.plan}, Rating Area 10, ages ${e.expected.members.map((m) => m.age).join(", ")}: gross ${e.response.total_cents} cents, pediatric EHB ${e.response.pediatric_ehb?.monthly_cents} cents; ${e.passed ? "PASS" : "FAIL"}.`,
  );
  await writeFile(
    join(reports, "p5e-dental.md"),
    `# P5e dental — ${report.passed ? "PASS" : "FAIL"}\n\nGenerated ${report.generated_at}.\n\n` +
      `Raw TX SADP rows: ${report.raw_counts?.tx_rate_rows}; checked ${report.checked_rate_rows}. Comparisons: ${report.comparisons}; mixed households: ${report.household_comparisons}; non-TX Family Option comparisons: ${report.family_option_comparisons}; mismatches: ${report.mismatches.length}.\n\n` +
      `All raw SADP rows are checked, including explicit unsupported SHOP rows. TX has ${report.raw_counts?.tx_family_option_rows} Family Option rows. The oracle also checks every published non-TX SADP Family Option row.\n\n` +
      `Finite equivalence basis: every 0–63 age, 64/65/80/120 terminal-band probes, both tobacco flags, both effective/expiration boundaries; all eight family columns with three and four dependents; five mixed-age households per age-rate group. Arbitrarily large households are not literally enumerated: additive member selection and child-cap composition are checked separately.\n\n` +
      `## Harris examples (county 48201)\n\n${exampleLines.join("\n")}\n\n## Negative controls\n\n${report.negative_controls.map((c) => `- ${c.name}: ${c.passed ? "detected / PASS" : "FAIL"}`).join("\n")}\n\n` +
      `## Scope and assumptions\n\nIndividual SADPs in explicitly listed federal PUF state/year scopes only; SHOP, NY/VT dental, unproved relationships/cohabitation, dependent age extensions, conflicting evidence and unknown family membership are unsupported. Filed age rows use the plan's Business Rules maximum underage-dependent count; medical Part 147 policy does not authorize dental. No inferred age curve or fabricated premium. No Preference uses IndividualRate for either tobacco input. Family totals are not split among members; pediatric EHB is unknown without a supported allocation.\n\n` +
      `The HTTP examples use real imported rates and Plan Attributes apportionment, not synthetic rates. The method is a nonbinding estimate, not enrollment eligibility or a Marketplace application. Subsidy allocation between medical and dental enrollment is not implemented by this task.\n\n` +
      `## Sources\n\n${Object.entries(report.sources ?? {})
        .map(([kind, s]) => `- ${kind}: ${s.url}; SHA-256 ${s.sha256}`)
        .join(
          "\n",
        )}\n\nMethod citations: see openplans/data/rating-rules/dental-method.md.\n\n` +
      `## Failures\n\n${report.failures.length ? report.failures.join("\n") : "None."}\n`,
  );
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  `${report.passed ? "PASS" : "FAIL"}: dental ${report.checked_rate_rows} TX rows; ${report.comparisons} comparisons; ${report.household_comparisons} households; ${report.mismatches.length} mismatches; controls ${report.negative_controls.filter((c) => c.passed).length}/3`,
);
if (!report.passed) process.exitCode = 1;
