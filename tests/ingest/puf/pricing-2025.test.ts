import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureFiles as geoFiles } from "../geo/helpers.js";
import { migrate } from "../../../src/db/migrate.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import type { PufImportReport } from "../../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import type { ImportFile } from "../../../src/ingest/puf/import-source.js";
import {
  ingestRatingRules,
  ratingRule,
} from "../../../src/ingest/rating-rules/index.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { runGeo } from "../../../src/ingest/geo/command.js";
import { estimatePremium } from "../../../src/api/premiums.js";
import { findPlan } from "../../../src/api/repository.js";
import { premiumRequest } from "../../../src/api/validation.js";

const rules = (year: number) =>
  fileURLToPath(
    new URL(`../../../data/rating-rules/${year}.json`, import.meta.url),
  );
const db = testDatabase(new PGlite());
let directory: string,
  core: Awaited<ReturnType<typeof coreMigrations>>,
  py2025: PufImportReport,
  py2026: PufImportReport;

// SYNTHETIC: the real PY2026 fixture cuts relabelled 2025, with every filed rate raised by
// $1.11 so that a PY2026 row used for PY2025 cannot pass. No PY2025 premium is claimed.
function synthetic2025(kind: string, text: string) {
  const relabelled = text.replaceAll("2026", "2025");
  if (kind !== "rate") return relabelled;
  const [header, ...lines] = relabelled.split("\n");
  const columns = header!.split(",");
  const money = ["IndividualRate", "IndividualTobaccoRate"].map((c) =>
    columns.indexOf(c),
  );
  return [
    header,
    ...lines.map((line) => {
      if (!line) return line;
      const cells = line.split(",");
      for (const at of money)
        if (cells[at]) cells[at] = (Number(cells[at]) + 1.11).toFixed(2);
      return cells.join(",");
    }),
  ].join("\n");
}
async function catalog(year: 2025 | 2026) {
  const files: ImportFile[] = await Promise.all(
    IMPORT_KINDS.map(async (kind) => {
      const source = await readFile(
        new URL(`../../fixtures/puf/import/${kind}.csv`, import.meta.url),
        "utf8",
      );
      const data = Buffer.from(
        year === 2025 ? synthetic2025(kind, source) : source,
      );
      const path = join(directory, `${year}-${kind}.csv`);
      await writeFile(path, data);
      return {
        kind,
        path,
        format: "csv" as const,
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
        retrievedAt: "2026-11-10T17:10:00Z",
        url: `https://synthetic.example/${year}/${kind}.csv`,
      };
    }),
  );
  return importPufs(db, { year, state: "TX", files, dataDir: directory });
}
/** The TX fixture page with a "Page Last Modified" line, as the full CMS pages carry. */
async function gra(modified: string, edit = (html: string) => html) {
  const files = await geoFiles();
  const html = edit(await readFile(files.ratingAreas.path, "utf8"));
  const path = join(directory, `tx-gra-${modified.replaceAll("/", "")}.html`);
  await writeFile(
    path,
    `${html}\n<div>Page Last Modified: ${modified} 06:11 PM</div>\n`,
  );
  return geoFiles({ ratingAreas: path });
}
async function rawCents(year: number, plan: string, area: string, age: string) {
  const text = await readFile(join(directory, `${year}-rate.csv`), "utf8");
  const [header, ...lines] = text.trim().split("\n");
  const columns = header!.split(",");
  const at = (name: string) => columns.indexOf(name);
  const row = lines
    .map((line) => line.split(","))
    .find(
      (cells) =>
        cells[at("PlanId")] === plan &&
        cells[at("RatingAreaId")] === area &&
        cells[at("Age")] === age,
    );
  return row ? Math.round(Number(row[at("IndividualRate")]) * 100) : null;
}
async function txPlan() {
  const { base_plan_id } = (
    await db.query<{ base_plan_id: string }>(
      "SELECT base_plan_id FROM plan WHERE snapshot_id=$1 AND issuer_id='11718' ORDER BY base_plan_id LIMIT 1",
      [`${py2025.import_id}:plan-attributes`],
    )
  ).rows[0]!;
  const found = (await findPlan(db, base_plan_id, 2025))!;
  const { rating_area_id } = (
    await db.query<{ rating_area_id: string }>(
      "SELECT rating_area_id FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 LIMIT 1",
      [`${py2025.import_id}:rate`, base_plan_id],
    )
  ).rows[0]!;
  return { id: base_plan_id, found, area: rating_area_id };
}
/** Harris County's area, read from the published CMS page rather than from the database. */
async function harrisArea() {
  const html = await readFile((await geoFiles()).ratingAreas.path, "utf8");
  const match =
    /(Rating Area \d+)(?:<\/span>)*<\/td>\s*<td[^>]*>(?:<span>)*Harris</.exec(
      html,
    );
  return match![1]!;
}
async function price(id: string, found: unknown, county: string, age: number) {
  const request = premiumRequest({
    plan_ids: [id],
    coverage_start: "2025-01-01",
    county,
    members: [{ age, tobacco: false, relationship: "subscriber" }],
  });
  return estimatePremium(
    db,
    found as Parameters<typeof estimatePremium>[1],
    id,
    request,
    { status: "available" as const, county, counties: [] },
  ) as Promise<Record<string, unknown>>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-py2025-pricing-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  py2026 = await catalog(2026);
  py2025 = await catalog(2025);
  expect([py2025.status, py2026.status]).toEqual(["ACTIVE", "ACTIVE"]);
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("negative control: PY2026 rules and geography never price a PY2025 plan", async () => {
  await ingestRatingRules(db, rules(2026));
  await ingestGeo(db, { files: await gra("09/10/2024"), planYear: 2026 });
  expect(await ratingRule(db, "TX", 2025, "Individual")).toBeNull();
  const plan = await txPlan();
  expect(await price(plan.id, plan.found, "48201", 40)).toMatchObject({
    status: "unsupported_rating_method",
  });
});

it("lists every PY2025 Exchange PUF state with cited PY2025 rules and keeps NY/VT unsupported", async () => {
  const document = JSON.parse(await readFile(rules(2025), "utf8"));
  expect(document.plan_year).toBe(2025);
  const perMember = document.rules.filter(
    (r: { method: string }) => r.method === "per_member",
  );
  expect(perMember.map((r: { state: string }) => r.state)).toEqual(
    "AK AL AR AZ DE FL HI IA IL IN KS LA MI MO MS MT NC ND NE NH OH OK OR SC SD TN TX UT WI WV WY".split(
      " ",
    ),
  );
  for (const rule of document.rules) {
    expect(rule.citation).not.toContain("PY2026");
    expect(rule.citation).not.toContain("PY2027");
  }
  for (const rule of perMember)
    expect(rule.citation).toContain("reviewed for PY2025");
  const result = await ingestRatingRules(db, rules(2025));
  expect(result).toMatchObject({ plan_year: 2025, rules: 33 });
  for (const state of ["NY", "VT"])
    expect(await ratingRule(db, state, 2025, "individual")).toMatchObject({
      method: "unsupported",
    });
  // Loading PY2025 leaves the PY2026 rule set in place.
  expect(await ratingRule(db, "TX", 2026, "individual")).toMatchObject({
    method: "per_member",
    citation: expect.stringContaining("PY2026"),
  });
});

it("negative control: a CMS table modified during or after PY2025 leaves PY2025 geography unknown", async () => {
  for (const modified of ["03/13/2026", "01/01/2025"])
    await expect(
      ingestGeo(db, { files: await gra(modified), planYear: 2025 }),
    ).rejects.toThrow("unchanged since before PY2025");
  const files = await geoFiles();
  await expect(ingestGeo(db, { files, planYear: 2025 })).rejects.toThrow(
    "unchanged since before PY2025",
  );
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM rating_area WHERE plan_year=2025",
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  // The fetch year keeps the existing behaviour, whatever the page date.
  expect(
    await ingestGeo(db, { files: await gra("03/13/2026"), planYear: 2026 }),
  ).toMatchObject({ ratingAreaBasis: "current_cms_table" });
});

it("prices PY2025 at ages 21, 40 and 64 from the PY2025 filed rows only, to the cent", async () => {
  await ingestRatingRules(db, rules(2025));
  expect(
    await ingestGeo(db, { files: await gra("09/10/2024"), planYear: 2025 }),
  ).toMatchObject({
    ratingAreaBasis: "cms_table_unmodified_since",
    ratingAreaTableModified: "2024-09-10",
  });
  const plan = await txPlan();
  const county = "48201";
  expect(plan.area).toBe(await harrisArea());
  for (const age of [21, 40, 64]) {
    const band = age === 64 ? "64 and over" : String(age);
    const want = await rawCents(2025, plan.id, plan.area, band);
    const previous = await rawCents(2026, plan.id, plan.area, band);
    expect(want).not.toBeNull();
    const result = await price(plan.id, plan.found, county, age);
    expect(result).toMatchObject({
      status: "rated",
      rating_area_id: plan.area,
      total_cents: want,
    });
    // A PY2026 row in place of the PY2025 row would be $1.11 lower.
    expect(result.total_cents).not.toBe(previous);
  }
});

it("negative control: a county moved to another rating area no longer matches the filed area", async () => {
  const plan = await txPlan();
  const county = "48201";
  const other =
    plan.area === "Rating Area 1" ? "Rating Area 2" : "Rating Area 1";
  const geo = await ingestGeo(db, {
    files: await gra("09/10/2024", (html) =>
      html.replaceAll(`>${plan.area}<`, `>${other}<`),
    ),
    planYear: 2025,
  });
  expect(geo.ratingAreaBasis).toBe("cms_table_unmodified_since");
  const result = await price(plan.id, plan.found, county, 40);
  expect(result.rating_area_id).not.toBe(plan.area);
  expect(result.status).not.toBe("rated");
  // Restore the published table for any later case.
  await ingestGeo(db, { files: await gra("09/10/2024"), planYear: 2025 });
});

it("admits --year 2025 on the geography command", async () => {
  const errors: string[] = [];
  let opened = false;
  const code = await runGeo(
    ["--year", "2025", "--state", "TX"],
    () => {
      opened = true;
      throw new Error("synthetic database failure after argument validation");
    },
    { out: () => {}, error: (line) => errors.push(line) },
    core.directory,
  );
  expect([code, opened]).toEqual([1, true]);
  expect(errors[0]).not.toContain("Usage");
});
