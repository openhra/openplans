import { afterAll, beforeAll, expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { dataAvailability } from "../../src/services/availability.js";
import { backfillRatePlanCounts } from "../../src/ingest/puf/import-repository.js";
import { quoteFixture } from "../api/quote-fixture.js";

let fixture: Awaited<ReturnType<typeof quoteFixture>>;
beforeAll(async () => {
  fixture = await quoteFixture();
});
afterAll(async () => fixture?.close());

/** Counts per-entry rate-row queries; `rewrite` plants a change in the kept-count statement. */
function watched(rewrite?: (sql: string) => string) {
  const seen = { perEntry: 0, counted: 0 };
  const db: SqlSession = {
    query(sql, parameters) {
      if (sql.includes("count(r.base_plan_id)")) seen.perEntry++;
      if (sql.includes("rate_plan_count c")) {
        seen.counted++;
        if (rewrite) sql = rewrite(sql);
      }
      return fixture.db.query(sql, parameters);
    },
    exec: (sql) => fixture.db.exec(sql),
  };
  return { db, seen };
}

async function publicBody() {
  // No response cache: kept counts carry no generation trigger, so a cache would hide a change.
  const app = createApp(fixture.db, {}, { store: new MemoryCache(0) });
  const response = await app.request("/v1/data-availability");
  expect(response.status).toBe(200);
  return response.text();
}

it("kept rate counts give the same availability bytes as counting rate rows", async () => {
  const kept = await fixture.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM rate_plan_count",
  );
  expect(kept.rows[0]!.n).toBe(1);

  const fast = watched();
  const counted = await dataAvailability(fast.db);
  const countedBody = await publicBody();
  expect(fast.seen).toEqual({ perEntry: 0, counted: 1 });
  const rated = counted.filter((row) => row.rate_snapshot_id !== undefined);
  expect(rated.some((row) => Number(row.rate_rows) > 0)).toBe(true);

  // Without kept counts every entry is counted from the rate rows, as before.
  await fixture.db.query("DELETE FROM rate_plan_count");
  const slow = watched();
  const recounted = await dataAvailability(slow.db);
  expect(slow.seen.perEntry).toBe(rated.length);
  expect(JSON.stringify(recounted)).toBe(JSON.stringify(counted));
  expect(await publicBody()).toBe(countedBody);

  // The backfill restores the same counts and the fast path.
  expect(await backfillRatePlanCounts(fixture.db)).toBe(1);
  expect(await backfillRatePlanCounts(fixture.db)).toBe(0);
  const again = watched();
  expect(JSON.stringify(await dataAvailability(again.db))).toBe(
    JSON.stringify(counted),
  );
  expect(again.seen.perEntry).toBe(0);
  expect(await publicBody()).toBe(countedBody);
});

it("planted mutants in the kept-count path change the result", async () => {
  const baseline = JSON.stringify(await dataAvailability(watched().db));
  // A statement that counts plans instead of their kept rate rows.
  const plans = watched((sql) =>
    sql.replace(
      "coalesce(sum((c.plan_rows->>p.base_plan_id)::bigint),0)::int",
      "count(p.base_plan_id)::int",
    ),
  );
  const planCounts = JSON.stringify(await dataAvailability(plans.db));
  expect(plans.seen.counted).toBe(1);
  expect(planCounts).not.toBe(baseline);
  // A stale kept count (one extra row for one plan) shows in the output.
  const { rows } = await fixture.db.query<{ plan: string }>(
    `SELECT k AS plan FROM rate_plan_count c CROSS JOIN jsonb_object_keys(c.plan_rows) k
      JOIN plan p ON p.base_plan_id=k AND NOT p.dental_only ORDER BY 1 LIMIT 1`,
  );
  await fixture.db.query(
    `UPDATE rate_plan_count SET plan_rows=jsonb_set(plan_rows,ARRAY[$1],to_jsonb((plan_rows->>$1)::int+1)),
      rate_rows=rate_rows+1`,
    [rows[0]!.plan],
  );
  try {
    expect(JSON.stringify(await dataAvailability(watched().db))).not.toBe(
      baseline,
    );
  } finally {
    await fixture.db.query("DELETE FROM rate_plan_count");
    await backfillRatePlanCounts(fixture.db);
  }
  expect(JSON.stringify(await dataAvailability(watched().db))).toBe(baseline);
});
