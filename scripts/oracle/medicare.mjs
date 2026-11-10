#!/usr/bin/env node
/**
 * Cache-only Medicare oracle. Imports the cached CMS archives into a disposable PGlite database,
 * then compares every county listing and every plan's service area served by /v1/medicare with an
 * independent Python reading of the raw files. Planted mutants must each be caught.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate, migrationsDirectory } from "../../dist/db/migrate.js";
import { createApp } from "../../dist/api/app.js";
import {
  cachedArchives,
  dataDirectory,
} from "../../dist/ingest/medicare/acquire.js";
import { importMedicare } from "../../dist/ingest/medicare/command.js";

const args = process.argv.slice(2);
const year = args[0] === "--year" ? Number(args[1]) : 2026;
const dataDir = dataDirectory();
const newest = async (family, match = () => true) =>
  (await cachedArchives(family, dataDir)).find(match);
const landscape = await newest("landscape", (e) => e.archive.year === year);
const pbp = await newest("pbp", (e) => e.archive.year === year);
const pdp = await newest("service_area", (e) =>
  e.archive.label.startsWith("pdp-"),
);
const ma = await newest("service_area", (e) =>
  e.archive.label.startsWith("ma-"),
);
if (!landscape || !pbp || !pdp || !ma) {
  console.log(`SKIP medicare ${year}: Medicare archives are not in the cache`);
  process.exit(0);
}

const reference = spawnSync(
  "python3",
  [
    "-I",
    fileURLToPath(new URL("medicare-reference.py", import.meta.url)),
    landscape.path,
    pdp.path,
    ma.path,
    pbp.path,
    String(year),
  ],
  { encoding: "utf8", maxBuffer: 1024 ** 3 },
);
assert.equal(reference.status, 0, reference.stderr);
const expected = JSON.parse(reference.stdout);

const migrations = await mkdtemp(join(tmpdir(), "medicare-oracle-migrations-"));
for (const name of await readdir(migrationsDirectory))
  if (name.endsWith(".sql") && name !== "002_postgis.sql")
    await cp(join(migrationsDirectory, name), join(migrations, name));
const pg = new PGlite();
const db = {
  query: (sql, parameters) => pg.query(sql, parameters),
  exec: async (sql) => void (await pg.exec(sql)),
  close: () => pg.close(),
  transaction: (run) =>
    pg.transaction((tx) =>
      run({
        query: (s, p) => tx.query(s, p),
        exec: async (s) => void (await tx.exec(s)),
      }),
    ),
};
const started = Date.now();
await migrate(db, migrations);
const imports = await importMedicare(db, { year }, dataDir);
const app = createApp(db, { premiumToken: undefined });
const get = async (path) => {
  const response = await app.request(path);
  assert.equal(response.status, 200, path);
  return response.json();
};

// 1. Every county listing: plan set, premiums, deductible, MOOP, stars, LIPS.
const actualCounties = {};
const actualSegments = {};
const fipsList = Object.keys(expected.counties).filter(
  (k) => !k.startsWith("ALL:"),
);
// States filed only as "All Counties" (some territories) get one county from the code map.
const prefixOf = { AS: "60", GU: "66", MP: "69", PR: "72", VI: "78" };
for (const [state, prefix] of Object.entries(
  await import("../../dist/ingest/geo/states.js").then((m) => m.STATE_FIPS),
))
  prefixOf[state] ??= prefix;
for (const key of Object.keys(expected.counties)) {
  if (!key.startsWith("ALL:")) continue;
  const prefix = prefixOf[key.slice(4)];
  if (!prefix || fipsList.some((f) => f.startsWith(prefix))) continue;
  const fips = Object.values(expected.ssa_map)
    .flat()
    .sort()
    .find((f) => f.startsWith(prefix));
  if (fips) fipsList.push(fips);
}
for (const fips of fipsList) {
  let page = 1;
  actualCounties[fips] = [];
  for (;;) {
    const body = await get(
      `/v1/medicare/plans?county_fips=${fips}&year=${year}&page=${page}`,
    );
    for (const plan of body.plans) {
      actualCounties[fips].push([
        plan.plan_key,
        plan.part_d.low_income_premium_subsidy.cents,
      ]);
      actualSegments[plan.plan_key] ??= plan;
    }
    if (!body.next_page) break;
    page = body.next_page;
  }
}
const moneyByStatus = { value: null, not_applicable: "n/a" };
const money = (cell) =>
  cell.status === "value" ? cell.cents : (moneyByStatus[cell.status] ?? null);
const star = (cell) =>
  cell.status === "rated"
    ? cell.stars
    : ({
        too_new: "Plan Too New To Be Measured",
        not_enough_data: "Not Enough Data Available",
        not_applicable: "Not Applicable",
      }[cell.status] ?? null);
function servedSegment(plan) {
  return {
    money: {
      "Part C Premium": money(plan.premiums_monthly.part_c),
      "Part D Basic Premium": money(plan.premiums_monthly.part_d_basic),
      "Part D Supplemental Premium": money(
        plan.premiums_monthly.part_d_supplemental,
      ),
      "Part D Total Premium": money(plan.premiums_monthly.part_d_total),
      "Monthly Consolidated Premium (Part C + D)": money(
        plan.premiums_monthly.consolidated,
      ),
      "Annual Part D Deductible Amount": money(plan.part_d.deductible),
      "Part D Out-of-Pocket (OOP) Threshold": money(plan.part_d.oop_threshold),
      "In-Network Maximum Out-of-Pocket (MOOP) Amount": money(
        plan.moop_in_network,
      ),
    },
    stars: {
      "Overall Star Rating": star(plan.stars.overall),
      "Part C Summary Star Rating": star(plan.stars.part_c_summary),
      "Part D Summary Star Rating": star(plan.stars.part_d_summary),
    },
    category: plan.contract_category,
    name: plan.name,
  };
}
function expectedCounty(fips, state) {
  const rows = (expected.counties[fips] ?? []).map(([key, lips]) => [
    key,
    lips === "n/a" ? null : lips,
  ]);
  for (const [key, lips] of expected.counties[`ALL:${state}`] ?? [])
    rows.push([key, lips === "n/a" ? null : lips]);
  return rows;
}
const stateOf = {};
for (const [state, prefix] of Object.entries(
  await import("../../dist/ingest/geo/states.js").then((m) => m.STATE_FIPS),
))
  stateOf[prefix] = state;
Object.assign(stateOf, { 60: "AS", 66: "GU", 69: "MP", 72: "PR", 78: "VI" });

function compare(segments, counties, areas) {
  const problems = [];
  for (const fips of fipsList) {
    const want = expectedCounty(fips, stateOf[fips.slice(0, 2)])
      .map(([k, l]) => `${k}:${l}`)
      .sort();
    const got = (counties[fips] ?? []).map(([k, l]) => `${k}:${l}`).sort();
    if (JSON.stringify(want) !== JSON.stringify(got))
      problems.push(`county ${fips}`);
  }
  for (const [key, plan] of Object.entries(segments))
    if (JSON.stringify(plan) !== JSON.stringify(expected.segments[key]))
      problems.push(`segment ${key}`);
  for (const [key, ssa] of Object.entries(areas))
    if (JSON.stringify(ssa) !== JSON.stringify(expected.areas[key] ?? []))
      problems.push(`area ${key}`);
  return problems;
}
const served = Object.fromEntries(
  Object.entries(actualSegments).map(([k, p]) => [k, servedSegment(p)]),
);

// 2. Every plan's PlanArea SSA set and its FIPS mapping.
const actualAreas = {};
for (const key of Object.keys(expected.areas)) {
  const body = await app.request(
    `/v1/medicare/plans/${key}/service-area?year=${year}`,
  );
  if (body.status === 404) {
    actualAreas[key] = [];
    continue;
  }
  const json = await body.json();
  const areas = json.plan_benefit_package.areas.filter(
    (a) => a.source === "plan_area",
  );
  actualAreas[key] = [...new Set(areas.map((a) => a.ssa_county_code))].sort();
  for (const area of areas)
    if (
      JSON.stringify(area.county_fips) !==
      JSON.stringify(expected.ssa_map[area.ssa_county_code] ?? null)
    )
      actualAreas[key] = ["fips-mismatch", area.ssa_county_code];
}
// PlanArea keys absent from Landscape are not served by plan detail; compare only Landscape plans.
for (const key of Object.keys(actualAreas))
  if (!expected.segments[key]) delete actualAreas[key];

const problems = compare(served, actualCounties, actualAreas);

// 3. Planted mutants: each must be caught by the same comparison.
const clone = (value) => JSON.parse(JSON.stringify(value));
const firstPriced = Object.keys(served).find(
  (k) =>
    typeof served[k].money["Monthly Consolidated Premium (Part C + D)"] ===
    "number",
);
const firstRated = Object.keys(served).find(
  (k) => served[k].stars["Overall Star Rating"] === 3.5,
);
const negative = Object.keys(served).find(
  (k) => served[k].money["Part D Basic Premium"] < 0,
);
const busy = fipsList.find((f) => (actualCounties[f] ?? []).length > 1);
const twoAreas = Object.keys(actualAreas)
  .filter((k) => actualAreas[k].length > 0)
  .slice(0, 2);
const mutants = {
  premium_plus_one_cent: () => {
    const s = clone(served);
    s[firstPriced].money["Monthly Consolidated Premium (Part C + D)"] += 1;
    return compare(s, actualCounties, actualAreas);
  },
  county_dropped: () => {
    const c = clone(actualCounties);
    c[busy].pop();
    return compare(served, c, actualAreas);
  },
  ssa_codes_swapped: () => {
    const a = clone(actualAreas);
    const [x, y] = twoAreas;
    [a[x][0], a[y][0]] = [a[y][0], a[x][0]];
    return compare(served, actualCounties, a);
  },
  star_35_to_40: () => {
    const s = clone(served);
    s[firstRated].stars["Overall Star Rating"] = 4;
    return compare(s, actualCounties, actualAreas);
  },
  negative_parsed_positive: () => {
    const s = clone(served);
    s[negative].money["Part D Basic Premium"] *= -1;
    return compare(s, actualCounties, actualAreas);
  },
};
const controls = Object.fromEntries(
  Object.entries(mutants).map(([name, run]) => [name, run().length > 0]),
);

const report = {
  year,
  checked_at: new Date().toISOString(),
  elapsed_ms: Date.now() - started,
  imports: imports.map((r) => ({
    family: r.family,
    as_of_label: r.as_of_label,
    snapshot_id: r.snapshot_id,
    counts: r.counts,
  })),
  raw_rows: expected.rows,
  counties_checked: fipsList.length,
  segments_checked: Object.keys(served).length,
  segments_expected: Object.keys(expected.segments).length,
  plan_areas_checked: Object.keys(actualAreas).length,
  problems: problems.slice(0, 50),
  problem_count: problems.length,
  negative_controls: controls,
};
await mkdir(join(dataDir, "reports"), { recursive: true });
await writeFile(
  join(dataDir, "reports", `medicare-oracle-${year}.json`),
  JSON.stringify(report, null, 2) + "\n",
);
await db.close();
await rm(migrations, { recursive: true, force: true });
console.log(
  JSON.stringify({
    ...report,
    imports: undefined,
    problems: report.problems.slice(0, 5),
  }),
);
assert.equal(
  problems.length,
  0,
  `medicare ${year}: ${problems.length} mismatches`,
);
assert.equal(
  report.segments_checked,
  report.segments_expected,
  "every Landscape segment served",
);
for (const [name, caught] of Object.entries(controls))
  assert.ok(caught, `negative control ${name} was not caught`);
console.log(`PASS medicare ${year}`);
