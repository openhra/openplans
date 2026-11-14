import { afterAll, beforeAll, expect, it } from "vitest";
import type { Plan } from "../../src/api/repository.js";
import {
  childDentalBenefits,
  dentalBenchmarkRates,
  findPlan,
  findPlans,
  planCostSharing,
  requestedPlansExist,
  snapshots,
  variantExists,
} from "../../src/api/repository.js";
import type { SqlSession } from "../../src/db/database.js";
import { planLineage } from "../../src/ingest/puf/import-repository.js";
import { requestReads } from "../../src/services/request-reads.js";
import { setup } from "../compat/v1/helpers.js";
import { withCrosswalk } from "./synthetic-crosswalk.js";

// A request reads many plans' rows with one query. Each plan must still get exactly the rows,
// in the same order, that its own query returns. Every plan in the real fixture cut is checked.
let h: Awaited<ReturnType<typeof setup>>;
let plans: Plan[];
beforeAll(async () => {
  h = await setup();
  plans = (await h.db.query<Plan>("SELECT * FROM plan ORDER BY base_plan_id"))
    .rows;
  expect(plans.length).toBeGreaterThan(20);
});
afterAll(async () => {
  await h?.close();
});

function counting(db: SqlSession) {
  const seen = { total: 0 };
  const session: SqlSession = {
    ...db,
    query: (sql, parameters) => {
      seen.total++;
      return db.query(sql, parameters);
    },
  };
  return { seen, session };
}
const same = (a: unknown, b: unknown) =>
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));

// The fixture cut publishes each plan's -00 variant only, so the default -01 finds no rows.
it.each([
  ["the standard variant", {}],
  ["an explicit variant", { csrVariant: "00" }],
  ["every variant's benefits", { allBenefits: true }],
])("cost sharing for %s matches each plan's own read", async (_, options) => {
  const { seen, session } = counting(h.db);
  const reads = requestReads(session);
  reads.plan(plans);
  const batched = await Promise.all(
    plans.map((plan) => reads.costSharing(plan, options)),
  );
  // Snapshot files, variants and benefits: one query each for the whole list.
  expect(seen.total).toBeLessThanOrEqual(3);
  for (const [index, plan] of plans.entries())
    same(batched[index], await planCostSharing(h.db, plan, options));
  if (Object.keys(options).length)
    expect(
      JSON.stringify(batched).split('"benefit_name"').length,
    ).toBeGreaterThan(plans.length);
});

it("benefit rows by name match each plan's own read, in its order", async () => {
  // The fixture has no child dental benefits; the read does not care which names it gets.
  const names = ["Generic Drugs", "Chiropractic Care", "Specialist Visit"];
  const { seen, session } = counting(h.db);
  const reads = requestReads(session);
  reads.plan(plans);
  let found = 0;
  for (const plan of plans) {
    const files = await snapshots(h.db, plan);
    const own = await childDentalBenefits(
      h.db,
      files["benefits-and-cost-sharing"],
      plan.base_plan_id,
      names,
    );
    same(
      (
        await reads.childDentalBenefits(
          files["benefits-and-cost-sharing"],
          plan.base_plan_id,
          names,
        )
      ).rows,
      own.rows,
    );
    found += own.rows.length;
  }
  expect(found).toBeGreaterThan(plans.length);
  expect(seen.total).toBe(1);
});

it("rate rows by age band match each plan's own read, in its order", async () => {
  const { rows: areas } = await h.db.query<{ rating_area_id: string }>(
    "SELECT DISTINCT rating_area_id FROM rate ORDER BY 1",
  );
  const bands = ["0-14", "15", "18", "40"];
  const { seen, session } = counting(h.db);
  const reads = requestReads(session);
  reads.plan(plans);
  let found = 0;
  for (const { rating_area_id: area } of areas)
    for (const plan of plans) {
      const files = await snapshots(h.db, plan);
      const own = await dentalBenchmarkRates(
        h.db,
        files.rate,
        plan.base_plan_id,
        area,
        bands,
      );
      same(
        (
          await reads.dentalBenchmarkRates(
            files.rate,
            plan.base_plan_id,
            area,
            bands,
          )
        ).rows,
        own.rows,
      );
      found += own.rows.length;
    }
  expect(found).toBeGreaterThan(plans.length);
  expect(seen.total).toBe(areas.length);
});

it("finds requested plans with one query, as if each were found alone", async () => {
  const ids = [
    plans[3]!.base_plan_id,
    "99999TX0100001",
    plans[0]!.base_plan_id,
    plans[3]!.base_plan_id,
  ];
  const { seen, session } = counting(h.db);
  const found = await findPlans(session, ids, 2026);
  // One catalog query, plus the state catalog lookup findPlan makes for the unknown ID.
  expect(seen.total).toBe(2);
  for (const [index, id] of ids.entries())
    same(found[index], await findPlan(h.db, id, 2026));
  // A repeated ID gets its own object.
  expect(found[0]).not.toBe(found[3]);
  expect(await findPlans(session, [], 2026)).toEqual([]);
});

it("prior-year IDs match each plan's own read, in its order", async () => {
  const marker = new Error("roll back the synthetic crosswalk");
  await expect(
    h.db.transaction(async (tx) => {
      await withCrosswalk(tx);
      const { seen, session } = counting(tx);
      const reads = requestReads(session);
      reads.plan(plans);
      const batched = await Promise.all(
        plans.map((plan) => reads.lineage(plan)),
      );
      // The coverage check and the prior-year IDs: one query each for the whole list.
      expect(seen.total).toBe(2);
      let found = 0;
      for (const [index, plan] of plans.entries()) {
        const own = await planLineage(
          tx,
          plan.base_plan_id,
          plan.plan_year,
          plan.state,
        );
        same(batched[index], own);
        found += own.ancestors.length;
      }
      expect(found).toBe(plans.length * 4);
      // A plan never named is read alone, and a state no crosswalk covers stays unknown.
      const other = { ...plans[0]!, base_plan_id: "99999TX0000002" };
      same(
        await reads.lineage(other),
        await planLineage(tx, other.base_plan_id, 2026, "TX"),
      );
      same(await reads.lineage({ ...plans[0]!, state: "CA" }), {
        status: "unknown",
        ancestors: [],
      });
      throw marker;
    }),
  ).rejects.toBe(marker);
});

it("checks requested variants with one query, as if each were checked alone", async () => {
  const requested = [
    ...plans.map((plan) => ({
      plan,
      variant: "00",
      full: `${plan.base_plan_id}-00`,
    })),
    // The fixture cut publishes no -01 variant.
    { plan: plans[1]!, variant: "01", full: `${plans[1]!.base_plan_id}-01` },
    { plan: plans[2]!, variant: null, full: plans[2]!.base_plan_id },
    { plan: null, variant: "00", full: "99999TX0100001-00" },
    { plan: plans[0]!, variant: "00", full: `${plans[0]!.base_plan_id}-00` },
  ];
  const { seen, session } = counting(h.db);
  const found = await requestedPlansExist(session, requested);
  expect(seen.total).toBe(1);
  const own = [];
  for (const { plan, variant, full } of requested)
    own.push(
      !!plan && (variant === null || (await variantExists(h.db, plan, full))),
    );
  same(found, own);
  expect(own.filter(Boolean).length).toBe(plans.length + 2);
  expect(await requestedPlansExist(session, [])).toEqual([]);
  expect(seen.total).toBe(1);
});
