import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import {
  BASE,
  headers,
  searchBody,
  setup,
  TOKEN,
} from "../compat/v1/helpers.js";

// Each request reads the county catalog a fixed number of times, however many plans it rates.
// The plans added below are SYNTHETIC copies of one real silver plan, with the same rows under
// new IDs. A transaction that always rolls back holds them, so they never leave this test.
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const CATALOG_READ = /FROM puf_active_catalog a\b[\s\S]*service_area_county/;
const COST_SHARING_READ =
  /FROM plan_variant WHERE snapshot_id=\$1 AND base_plan_id=\$2 AND plan_year=\$3/;
const COPIES = 9;
const SOURCE = "87226TX0100011";
const copyId = (n: number) => `${SOURCE.slice(0, 7)}${9_000_000 + n}`;
const bearer = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};
const member = { age: 40, tobacco: false, relationship: "subscriber" };

interface Count {
  catalog: number;
  costSharing: number;
}
type Call = (
  app: ReturnType<typeof createApp>,
  ids: string[],
) => Response | Promise<Response>;

const post = (body: unknown, extra: Record<string, string> = bearer) => ({
  method: "POST",
  headers: extra,
  body: JSON.stringify(body),
});
const paths: Record<string, Call> = {
  "native estimates with a subsidy": (app, ids) =>
    app.request(
      "/v1/premium-quotes",
      post({
        plan_ids: ids,
        zip: "77002",
        coverage_start: "2026-01-01",
        members: [member],
        household_income_annual: 31_300,
        household_size: 1,
        tax_filing: "single",
      }),
    ),
  "public quotes": (app, ids) =>
    app.request(
      "/v1/quotes",
      post(
        {
          year: 2026,
          zip: "77002",
          county: "48201",
          members: [{ age: 35 }],
          plan_ids: ids,
        },
        { "content-type": "application/json" },
      ),
    ),
  "silver benchmark": (app) =>
    app.request("/v1/benchmark?zip=77002&year=2026&ages=40", {
      headers: bearer,
    }),
  "silver benchmark without a ZIP": (app) =>
    app.request("/v1/benchmark?county=48201&year=2026&ages=40", {
      headers: bearer,
    }),
  "ICHRA affordability": (app) =>
    app.request(
      "/v1/ichra/affordability",
      post({
        plan_start: "2026-01-01",
        employee: { date_of_birth: "1985-10-01" },
        residence: { zip: "77002" },
        hra: { self_only_annual_cents: 300_000 },
        income: [
          { measure: "household", annual_cents: 4_118_000 },
          { measure: "rate_of_pay_hourly", hourly_cents: 2_000 },
        ],
      }),
    ),
  "compat medical search with a subsidy": (app) =>
    app.request(
      BASE + "/plans/medical/search",
      post(
        searchBody({ household_size: 1, household_income: 20_000 }),
        headers,
      ),
    ),
  "native plan search": (app) =>
    app.request("/v1/plans?zip=77002&year=2026", { headers: bearer }),
};

/** Copy every row of SOURCE that rating reads, under COPIES new plan IDs. */
async function addCopies(tx: SqlSession) {
  const tables = {
    plan: ["base_plan_id"],
    plan_attribute: ["base_plan_id", "published_plan_id"],
    plan_variant: ["base_plan_id", "variant_plan_id"],
    plan_benefit: ["base_plan_id", "published_plan_id"],
    rate: ["base_plan_id"],
  } as const;
  for (const [table, ids] of Object.entries(tables)) {
    const { rows } = await tx.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    );
    const columns = rows.map((r) => r.column_name);
    const select = columns.map((column) => {
      if ((ids as readonly string[]).includes(column))
        return `left(${column},7) || (9000000+n)::text || substr(${column},15)`;
      if (column === "source_row") return "source_row + n*1000000";
      return column;
    });
    await tx.exec(
      `INSERT INTO ${table} (${columns.join(",")})
        SELECT ${select.join(",")} FROM ${table} CROSS JOIN generate_series(1,${COPIES}) n
        WHERE base_plan_id='${SOURCE}'`,
    );
  }
}

function counting(db: SqlSession) {
  const count: Count = { catalog: 0, costSharing: 0 };
  const session: SqlSession = {
    ...db,
    query: (sql, parameters) => {
      if (CATALOG_READ.test(sql)) count.catalog++;
      if (COST_SHARING_READ.test(sql)) count.costSharing++;
      return db.query(sql, parameters);
    },
  };
  return { count, session };
}

async function measure(db: SqlSession, call: Call, ids: string[]) {
  const { count, session } = counting(db);
  const app = createApp(session, { premiumToken: TOKEN });
  const response = await call(app, ids);
  expect(response.status, await response.clone().text()).toBe(200);
  await response.arrayBuffer();
  return { ...count };
}

async function withCopies(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("roll back the synthetic plan copies");
  await expect(
    h.db.transaction(async (tx) => {
      await addCopies(tx);
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

describe("county catalog reads per request", () => {
  for (const [name, call] of Object.entries(paths))
    it(`${name}: the same reads with ${COPIES} more silver plans`, async () => {
      const before = await measure(h.db, call, [SOURCE]);
      let after: Count | undefined;
      await withCopies(async (tx) => {
        after = await measure(tx, call, [
          SOURCE,
          ...Array.from({ length: COPIES }, (_, i) => copyId(i + 1)),
        ]);
      });
      expect(after!.catalog, "catalog reads must not grow with the plans").toBe(
        before.catalog,
      );
      expect(before.catalog, "catalog reads per request").toBeLessThanOrEqual(
        2,
      );
      // Rating a plan and describing it share one cost-sharing read.
      expect(
        after!.costSharing - before.costSharing,
        "cost-sharing reads per added plan",
      ).toBeLessThanOrEqual(COPIES);
    });
});
