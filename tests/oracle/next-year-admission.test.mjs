import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/index.js";
import { admitNextYear } from "../../scripts/oracle/admission.mjs";
import { setup } from "../compat/v1/helpers.js";

// The CMS fixture is plan year 2026. On this date 2026 is next year, as 2027 is for a real run.
const now = new Date("2025-11-19T00:00:00Z");
let h;
let base;
beforeAll(async () => {
  h = await setup();
  base = (
    await h.db.query(
      `SELECT base_plan_id FROM plan WHERE snapshot_id=$1 AND lower(metal)='silver'
        AND NOT dental_only ORDER BY base_plan_id LIMIT 1`,
      [`${h.report.import_id}:plan-attributes`],
    )
  ).rows[0].base_plan_id;
});
afterAll(() => h?.close());
afterEach(async () => {
  vi.useRealTimers();
  await h.db.exec("DELETE FROM annual_data_admission");
});

// The request the CSR oracle makes for every silver base plan.
async function detail() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const app = createApp(h.db, {}, { config: loadConfig({}) });
  const response = await app.request(`/v1/plans/${base}?year=2026`);
  vi.useRealTimers();
  return { status: response.status, body: await response.json() };
}

it("the oracle's next-year request fails without an admission and passes with one", async () => {
  const refused = await detail();
  expect(refused.status).toBe(404);
  expect(refused.body.error).toMatchObject({
    code: "not_loaded",
    reason: "outside_serving_window",
    required_year: 2026,
    domain: "individual",
  });

  const admitted = await admitNextYear(h.db, "individual", 2026, now);
  expect(admitted).toEqual([
    {
      domain: "individual",
      coverage_year: 2026,
      manifest: {
        schema_version: 1,
        releases: [
          { kind: "puf", snapshot_id: h.report.import_id, contract_year: 2026 },
        ],
      },
    },
  ]);
  const served = await detail();
  expect(served.status).toBe(200);
  expect(served.body.variant_ids.length).toBeGreaterThan(0);
  // A second run over the same database publishes nothing new.
  await admitNextYear(h.db, "individual", 2026, now);
  expect(
    (await h.db.query("SELECT count(*)::int AS n FROM annual_data_admission"))
      .rows[0].n,
  ).toBe(1);
});

it("writes nothing for prior or current years", async () => {
  expect(await admitNextYear(h.db, "individual", 2025, now)).toEqual([]);
  expect(await admitNextYear(h.db, "individual", 2026, new Date())).toEqual([]);
  expect(
    (await h.db.query("SELECT count(*)::int AS n FROM annual_data_admission"))
      .rows[0].n,
  ).toBe(0);
});

it("refuses a year or domain with nothing ACTIVE to admit", async () => {
  const later = new Date("2024-11-19T00:00:00Z");
  await expect(admitNextYear(h.db, "individual", 2025, later)).rejects.toThrow(
    "No ACTIVE individual release to admit for 2025",
  );
  await expect(admitNextYear(h.db, "medicare", 2026, now)).rejects.toThrow(
    "No ACTIVE medicare release to admit for 2026",
  );
});

// Each oracle that reads next year from its own database admits it before the first read.
it.each([
  ["csr.mjs", 'admitNextYear(db, "individual", year)', "app.request("],
  ["medicare.mjs", 'admitNextYear(db, "medicare", year)', "createApp(db"],
  ["medicare-cost.mjs", 'admitNextYear(db, "medicare", year)', "createApp("],
  [
    "medicare-part-d.mjs",
    'admitNextYear(db, "medicare", year)',
    "readActual(db",
  ],
  [
    "handy.mjs",
    'admitNextYear(db, "individual", Number(year))',
    "lowestPremiums(",
  ],
  [
    "handy-household.mjs",
    'admitNextYear(db, "individual", year)',
    "checkHouseholdEnumeration(db, input)",
  ],
])("%s admits next year before reading it", async (name, admit, read) => {
  const source = await readFile(
    new URL(`../../scripts/oracle/${name}`, import.meta.url),
    "utf8",
  );
  expect(source).toContain('import { admitNextYear } from "./admission.mjs";');
  const at = source.indexOf(admit);
  expect(at).toBeGreaterThan(0);
  expect(source.indexOf(read)).toBeGreaterThan(at);
});
