import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureFiles as geoFiles } from "../geo/helpers.js";
import { migrate } from "../../../src/db/migrate.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import type {
  ImportFile,
  PufImportReport,
} from "../../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import {
  PY2027_ATTRIBUTE_COLUMNS,
  validateImportHeader,
} from "../../../src/ingest/puf/import-parse.js";
import {
  ingestRatingRules,
  ratingRule,
} from "../../../src/ingest/rating-rules/index.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { estimatePremium } from "../../../src/api/premiums.js";
import { findPlan } from "../../../src/api/repository.js";
import { premiumRequest } from "../../../src/api/validation.js";

const fixtures = fileURLToPath(
  new URL("../../fixtures/puf/import-2027/", import.meta.url),
);
const db = testDatabase(new PGlite());
let directory: string,
  core: Awaited<ReturnType<typeof coreMigrations>>,
  files: ImportFile[],
  baseline: PufImportReport;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-py2027-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const provenance = JSON.parse(
    await readFile(join(fixtures, "provenance.json"), "utf8"),
  );
  files = await Promise.all(
    IMPORT_KINDS.map(async (kind) => {
      const path = join(fixtures, `${kind}.csv`),
        data = await readFile(path);
      return {
        kind,
        path,
        format: "csv" as const,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        retrievedAt: "2026-11-07T07:33:40.115Z",
        url: provenance.files.find((f: { kind: string }) => f.kind === kind)
          .url,
      };
    }),
  );
  baseline = await importPufs(db, {
    year: 2027,
    state: "TX",
    files,
    dataDir: directory,
  });
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("records all eight header diffs and explicitly retains both new PY2027 attribute fields", async () => {
  const audit = JSON.parse(
    await readFile(
      new URL("../../fixtures/puf/headers-2026-2027.json", import.meta.url),
      "utf8",
    ),
  );
  expect(Object.keys(audit.files)).toHaveLength(8);
  expect(audit.files["plan-attributes"].added).toEqual(
    PY2027_ATTRIBUTE_COLUMNS,
  );
  expect(audit.files["plan-attributes"].removed).toEqual([]);
  for (const kind of IMPORT_KINDS.filter((k) => k !== "plan-attributes")) {
    expect(audit.files[kind].added).toEqual([]);
    expect(audit.files[kind].removed).toEqual([]);
  }
  expect(baseline.status, JSON.stringify(baseline)).toBe("ACTIVE");
  const rows = (
    await db.query("SELECT raw FROM plan_attribute WHERE snapshot_id=$1", [
      `${baseline.import_id}:plan-attributes`,
    ])
  ).rows;
  expect(rows).toHaveLength(3);
  for (const row of rows)
    for (const key of PY2027_ATTRIBUTE_COLUMNS)
      expect(row.raw).toHaveProperty(key);
  expect((await db.query("SELECT DISTINCT plan_year FROM rate")).rows).toEqual([
    { plan_year: 2027 },
  ]);
});

it("negative control: a renamed required 2027 column quarantines and names the missing column", async () => {
  const source = files.find((f) => f.kind === "rate")!;
  const data = Buffer.from(
    (await readFile(source.path, "utf8")).replace(
      "IndividualRate,",
      "RenamedIndividualRate,",
    ),
  );
  const path = join(directory, "synthetic-renamed-2027-rate.csv");
  await writeFile(path, data);
  const mutant = files.map((f) =>
    f === source
      ? {
          ...f,
          path,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        }
      : f,
  );
  const report = await importPufs(db, {
    year: 2027,
    state: "TX",
    files: mutant,
    dataDir: directory,
  });
  expect(report.status).toBe("QUARANTINED");
  expect(report.files.find((f) => f.kind === "rate")?.error).toContain(
    "IndividualRate",
  );
  const issues = (
    await db.query(
      "SELECT explanation FROM quality_issue WHERE snapshot_id=$1",
      [`${report.import_id}:rate`],
    )
  ).rows;
  expect(JSON.stringify(issues)).toContain("IndividualRate");
  expect(
    (
      await db.query(
        "SELECT import_id FROM puf_active_catalog WHERE plan_year=2027",
      )
    ).rows[0]!.import_id,
  ).toBe(baseline.import_id);
  for (const key of PY2027_ATTRIBUTE_COLUMNS) {
    const columns = auditColumns();
    delete columns[key];
    expect(() =>
      validateImportHeader("plan-attributes", columns, 2027),
    ).toThrow(key);
  }
});
function auditColumns() {
  // The real-cut header is read by the import above. Build a schema-only mutant, no invented data.
  const keys = [
    "BusinessYear",
    "StateCode",
    "IssuerId",
    "StandardComponentId",
    "PlanId",
    "MarketCoverage",
    "DentalOnlyPlan",
    "MetalLevel",
    "NetworkId",
    "ServiceAreaId",
    "PlanMarketingName",
    "IssuerMarketPlaceMarketingName",
    "QHPNonQHPTypeId",
    ...PY2027_ATTRIBUTE_COLUMNS,
  ];
  return Object.fromEntries(keys.map((k) => [k, ""]));
}

it("negative control: a 2027 premium is unsupported until its own cited rules exist, then uses filed rates", async () => {
  const rulesPath = join(directory, "2027.json");
  await expect(ingestRatingRules(db, rulesPath)).rejects.toThrow("ENOENT");
  expect(await ratingRule(db, "TX", 2027, "Individual")).toBeNull();
  await ingestRatingRules(db); // PY2026 support must not leak into PY2027.
  const plan = (
    await db.query<{ base_plan_id: string }>(
      "SELECT base_plan_id FROM plan WHERE snapshot_id=$1 AND issuer_id='11718'",
      [`${baseline.import_id}:plan-attributes`],
    )
  ).rows[0]!;
  const found = (await findPlan(db, plan.base_plan_id, 2027))!;
  const request = premiumRequest({
    plan_ids: [plan.base_plan_id],
    coverage_start: "2027-01-01",
    county: "48201",
    members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
  });
  const location = {
    status: "available" as const,
    county: "48201",
    counties: [],
  };
  expect(
    await estimatePremium(db, found, plan.base_plan_id, request, location),
  ).toMatchObject({ status: "unsupported_rating_method" });
  await writeFile(
    rulesPath,
    await readFile(
      new URL("../../../data/rating-rules/2027.json", import.meta.url),
    ),
  );
  await ingestRatingRules(db, rulesPath);
  await ingestGeo(db, { files: await geoFiles(), planYear: 2027 });
  expect(await ratingRule(db, "TX", 2027, "Individual")).toMatchObject({
    method: "per_member",
    citation: expect.stringContaining("retrieved 2026-11-07"),
  });
  // The small rate cut retains one area per plan, which need not be Harris; use its published area.
  const area = (
    await db.query<{ rating_area_id: string }>(
      "SELECT rating_area_id FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 LIMIT 1",
      [`${baseline.import_id}:rate`, plan.base_plan_id],
    )
  ).rows[0]!;
  const county = (
    await db.query<{ county_fips: string }>(
      `SELECT r.county_fips FROM rating_area r JOIN service_area_county s ON s.county_fips=r.county_fips
      WHERE r.plan_year=2027 AND r.rating_area_id=$1 AND s.snapshot_id=$2 AND s.issuer_id=$3 AND s.service_area_id=$4 LIMIT 1`,
      [
        area.rating_area_id,
        `${baseline.import_id}:service-area`,
        found.issuer_id,
        found.service_area_id,
      ],
    )
  ).rows[0]!.county_fips;
  const result = await estimatePremium(db, found, plan.base_plan_id, request, {
    ...location,
    county,
  });
  expect(result).toMatchObject({
    status: "rated",
    rating_area_id: area.rating_area_id,
  });
});
