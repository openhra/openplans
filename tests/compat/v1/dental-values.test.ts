import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { migrate } from "../../../src/db/migrate.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { countyPlans } from "../../../src/api/repository.js";
import type { SqlSession } from "../../../src/db/database.js";
import { fixtureFiles } from "../../api/helpers.js";
import { fixtureFiles as geoFiles } from "../../ingest/geo/helpers.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

const db = testDatabase(new PGlite());
const token = "synthetic-dental-values-token";
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = token;
  directory = await mkdtemp(join(tmpdir(), "openplans-dental-values-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files: await fixtureFiles(directory),
        dataDir: directory,
      })
    ).status,
  ).toBe("ACTIVE");
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});
interface DentalSearch {
  meta: { total: number };
  plans: { id: string; premium: number | null; stand_alone: boolean }[];
}
async function search(tx: SqlSession, extra: Record<string, unknown> = {}) {
  const response = await createApp(tx).request(
    "/compat/v1/plans/dental/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": token },
      body: JSON.stringify({
        fips_code: "48201",
        zip_code: "77002",
        market: "individual",
        enrollment_date: "2026-01-01",
        applicants: [{ age: 35 }],
        per_page: 100,
        ...extra,
      }),
    },
  );
  assert.equal(response.status, 200);
  return {
    body: (await response.json()) as DentalSearch,
    gaps: response.headers.get("x-openplans-gaps") ?? "",
  };
}
function retainedOffering(body: DentalSearch, ids: string[]) {
  assert.equal(body.meta.total, ids.length);
  assert.deepEqual(body.plans.map((plan) => plan.id).sort(), [...ids].sort());
  assert.ok(body.plans.every((plan) => plan.stand_alone));
}
it("keeps every publicly offered SADP when a household price or eligibility rule is unknown", async () => {
  const offered = await countyPlans(db, "48201", 2026, "77002", "dental");
  const ids = offered.map((plan) => plan.base_plan_id);
  expect(ids).toContain("12846TX0270005");
  const result = await search(db);
  retainedOffering(result.body, ids);
  // The real cut contains Area 1 rates only; Harris is Area 10. Missing prices do not remove an offering.
  expect(
    result.body.plans.find((plan) => plan.id === "12846TX0270005")!.premium,
  ).toBeNull();
  expect(result.gaps).toContain("premium_missing");
  const marker = new Error("rollback synthetic missing dental rule");
  await expect(
    db.transaction(async (tx) => {
      await tx.exec("DELETE FROM business_rule WHERE dental_only");
      retainedOffering((await search(tx)).body, ids);
      throw marker;
    }),
  ).rejects.toBe(marker);
});
it("counts the filtered public dental catalog before paging, including unknown prices", async () => {
  const offered = await countyPlans(db, "48201", 2026, "77002", "dental");
  const id = offered[0]!.base_plan_id;
  const first = (await search(db, { per_page: 1 })).body;
  const beyond = (await search(db, { per_page: 1, page: offered.length + 1 }))
    .body;
  expect(first.meta.total).toBe(offered.length);
  expect(first.plans).toHaveLength(1);
  expect(beyond.meta.total).toBe(offered.length);
  expect(beyond.plans).toEqual([]);
  const filtered = (await search(db, { ids: [id, id] })).body;
  retainedOffering(filtered, [id]);
  const absent = (await search(db, { ids: ["99999TX0010001"] })).body;
  expect(absent).toEqual({ meta: { total: 0 }, plans: [] });
});
it("negative control rejects a dental plan removed without public offering or filter evidence", async () => {
  const ids = (await countyPlans(db, "48201", 2026, "77002", "dental")).map(
    (plan) => plan.base_plan_id,
  );
  const result = (await search(db)).body;
  retainedOffering(result, ids);
  const mutant = structuredClone(result);
  mutant.plans.splice(0, 1);
  mutant.meta.total = mutant.plans.length;
  expect(() => retainedOffering(mutant, ids)).toThrow();
  const totalMutant = structuredClone(result);
  totalMutant.meta.total = 0;
  expect(() => retainedOffering(totalMutant, ids)).toThrow();
});

it("excludes an evidenced child-only offering for adults before totals and paging, but keeps it for children", async () => {
  const id = "12846TX0270005";
  const offered = await countyPlans(db, "48201", 2026, "77002", "dental");
  const ids = offered.map((plan) => plan.base_plan_id);
  const marker = new Error("rollback synthetic child-only attribute");
  await expect(
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=jsonb_set(raw,'{ChildOnlyOffering}','"Allows Child-Only"')
       WHERE base_plan_id=$1`,
        [id],
      );
      const adults = await search(tx);
      retainedOffering(
        adults.body,
        ids.filter((value) => value !== id),
      );
      expect(adults.gaps).toContain(`dental_child_only_excluded:${id}`);
      const mutant = structuredClone(adults.body);
      mutant.plans.push({ id, premium: null, stand_alone: true });
      mutant.meta.total++;
      expect(() =>
        retainedOffering(
          mutant,
          ids.filter((value) => value !== id),
        ),
      ).toThrow();
      retainedOffering(
        (
          await search(tx, {
            applicants: [{ age: 35 }, { age: 10, child: true }],
          })
        ).body,
        ids,
      );
      retainedOffering(
        (await search(tx, { applicants: [{ age: 20 }] })).body,
        ids,
      );
      expect(
        (await search(tx, { applicants: [{ age: 21 }], ids: [id] })).body,
      ).toEqual({ meta: { total: 0 }, plans: [] });
      const page = await search(tx, { per_page: 1, page: 100 });
      expect(page.body.meta.total).toBe(ids.length - 1);
      expect(page.body.plans).toEqual([]);
      // Missing source evidence keeps the offering even if its price remains unsupported.
      await tx.query(
        "UPDATE plan_attribute SET raw=raw-'ChildOnlyOffering' WHERE base_plan_id=$1",
        [id],
      );
      retainedOffering((await search(tx)).body, ids);
      throw marker;
    }),
  ).rejects.toBe(marker);
});
