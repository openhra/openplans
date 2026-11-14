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
import { withCrosswalk } from "./synthetic-crosswalk.js";

// Each request reads the county catalog a fixed number of times, however many plans it rates,
// and its other queries grow by at most a small fixed number per added plan.
// The plans added below are SYNTHETIC copies of one real silver plan, with the same rows under
// new IDs. A transaction that always rolls back holds them, so they never leave this test.
// The fixture has no child dental benefits and no dental plans, so the household with a child
// gets SYNTHETIC ones in the same kind of transaction: see withChildDental.
// The fixture serves no plan ID crosswalk either, so every path also runs with a SYNTHETIC one
// that covers every plan (withCrosswalk).
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const CATALOG_READ = /FROM puf_active_catalog a\b[\s\S]*service_area_county/;
// One plan's variants, or several plans' at once.
const COST_SHARING_READ =
  /FROM plan_variant WHERE snapshot_id=\$1 AND base_plan_id(=\$2| = ANY\(\$2::text\[\]\)) AND plan_year=\$3/;
// One plan's prior-year IDs, or several plans' at once.
const LINEAGE_READ = /WITH RECURSIVE chain\b/;
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
  lineage: number;
  total: number;
}
// Most queries each added plan may add to a request. Plans named by ID are looked up together,
// and their variants, benefits, rates, attributes, child dental rows and prior-year IDs are read
// for all plans at once, so every path measured 0 per added plan, with or without a crosswalk.
const QUERIES_PER_ADDED_PLAN: Record<string, number> = {
  "native estimates with a subsidy": 0,
  "native estimates by variant ID": 0,
  "public quotes": 0,
  "public quotes by variant ID": 0,
  "silver benchmark": 0,
  "silver benchmark without a ZIP": 0,
  "ICHRA affordability": 0,
  "compat medical search with a subsidy": 0,
  "compat medical search by variant ID": 0,
  "native plan search": 0,
  "silver benchmark with a child and separate dental": 0,
};
// Paths that describe plans, so a served crosswalk makes them read prior-year IDs.
const DESCRIBES_PLANS = new Set([
  "compat medical search with a subsidy",
  "compat medical search by variant ID",
  "native plan search",
]);
// The fixture cut publishes each plan's -00 variant only.
const variantIds = (ids: string[]) => ids.map((id) => `${id}-00`);
type Call = (
  app: ReturnType<typeof createApp>,
  ids: string[],
) => Response | Promise<Response>;

const post = (body: unknown, extra: Record<string, string> = bearer) => ({
  method: "POST",
  headers: extra,
  body: JSON.stringify(body),
});
const estimates: Call = (app, ids) =>
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
  );
const quotes: Call = (app, ids) =>
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
  );
const paths: Record<string, Call> = {
  "native estimates with a subsidy": estimates,
  "native estimates by variant ID": (app, ids) =>
    estimates(app, variantIds(ids)),
  "public quotes": quotes,
  "public quotes by variant ID": (app, ids) => quotes(app, variantIds(ids)),
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
  "compat medical search by variant ID": (app, ids) =>
    app.request(
      BASE + "/plans/medical/search",
      post(searchBody({ ids: variantIds(ids) }), headers),
    ),
  "native plan search": (app) =>
    app.request("/v1/plans?zip=77002&year=2026", { headers: bearer }),
  "silver benchmark with a child and separate dental": (app) =>
    app.request("/v1/benchmark?zip=77002&year=2026&ages=40,10", {
      headers: bearer,
    }),
};
/** Paths that need synthetic rows before they read anything; given the number of copies. */
const SETUP: Record<string, (tx: SqlSession, copies: number) => Promise<void>> =
  {
    "silver benchmark with a child and separate dental": (tx, copies) =>
      withChildDental(tx, copies),
  };

async function columnsOf(tx: SqlSession, table: string) {
  const { rows } = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

/**
 * Copy SOURCE's rows in `tables` once for each n in `series`, with the plan ID's last seven
 * digits set to `first + n` and its source rows moved up by `rows + n` million. `change`
 * replaces other columns, by table.
 */
async function copySource(
  tx: SqlSession,
  tables: Record<string, readonly string[]>,
  first: number,
  rows: number,
  series: string,
  change: Record<string, Record<string, string>> = {},
) {
  for (const [table, ids] of Object.entries(tables)) {
    const columns = await columnsOf(tx, table);
    const select = columns.map((column) => {
      if (ids.includes(column))
        return `left(${column},7) || (${first}+n)::text || substr(${column},15)`;
      if (column === "source_row") return `source_row + (${rows}+n)*1000000`;
      return change[table]?.[column] ?? column;
    });
    await tx.exec(
      `INSERT INTO ${table} (${columns.join(",")})
        SELECT ${select.join(",")} FROM ${table} CROSS JOIN ${series} n
        WHERE base_plan_id='${SOURCE}'`,
    );
  }
}

/** Copy every row of SOURCE that rating reads, under COPIES new plan IDs. */
async function addCopies(tx: SqlSession) {
  await copySource(
    tx,
    {
      plan: ["base_plan_id"],
      plan_attribute: ["base_plan_id", "published_plan_id"],
      plan_variant: ["base_plan_id", "variant_plan_id"],
      plan_benefit: ["base_plan_id", "published_plan_id"],
      rate: ["base_plan_id"],
    },
    9_000_000,
    0,
    `generate_series(1,${COPIES})`,
  );
}

const CHILD_DENTAL = [
  "Dental Check-Up for Children",
  "Basic Dental Care - Child",
  "Major Dental Care - Child",
  "Orthodontia - Child",
];
/**
 * SYNTHETIC rows for a household with a child: one published variant of every medical plan gets
 * the four child dental benefits as EHB but not covered, so the benchmark prices separate dental.
 * The dental plans are 1 + `copies` copies of SOURCE's plan, attribute and rate rows marked
 * dental-only, in SOURCE's service area, with SOURCE's EHB share as the pediatric dental share
 * and SOURCE's rates.
 */
async function withChildDental(tx: SqlSession, copies: number) {
  const columns = await columnsOf(tx, "plan_benefit");
  const select = columns.map((column) => {
    if (column === "source_row")
      return "90000000 + (row_number() OVER (ORDER BY b.base_plan_id, n.i))::integer";
    if (column === "benefit_name") return "n.name";
    if (column === "raw")
      return `b.raw || jsonb_build_object('BenefitName', n.name, 'IsEHB', 'Yes', 'IsCovered', 'Not Covered')`;
    return `b.${column}`;
  });
  await tx.query(
    `INSERT INTO plan_benefit (${columns.join(",")})
      SELECT ${select.join(",")} FROM
        (SELECT DISTINCT ON (base_plan_id) * FROM plan_benefit
          ORDER BY base_plan_id, source_row) b
        CROSS JOIN unnest($1::text[]) WITH ORDINALITY n(name, i)`,
    [CHILD_DENTAL],
  );
  const moved: Record<string, string> = {
    dental_only: "true",
    source_row: "s.source_row + 90000000",
  };
  for (const table of ["service_area", "service_area_county"]) {
    const area = await columnsOf(tx, table);
    await tx.exec(
      `INSERT INTO ${table} (${area.join(",")})
        SELECT ${area.map((c) => moved[c] ?? `s.${c}`).join(",")}
        FROM ${table} s JOIN plan p ON p.base_plan_id='${SOURCE}'
          AND s.issuer_id=p.issuer_id AND s.service_area_id=p.service_area_id
          AND s.market=p.market AND NOT s.dental_only`,
    );
  }
  await copySource(
    tx,
    {
      plan: ["base_plan_id"],
      plan_attribute: ["base_plan_id", "published_plan_id"],
      rate: ["base_plan_id"],
    },
    8_000_000,
    200,
    `generate_series(0,${copies})`,
    {
      plan: { dental_only: "true" },
      plan_attribute: {
        dental_only: "true",
        raw: `raw || jsonb_build_object('EHBPediatricDentalApportionmentQuantity', raw->'EHBPercentTotalPremium')`,
      },
      // Rate rows carry their plan ID in raw, so each copy gets its own.
      rate: {
        raw: `raw || jsonb_build_object('PlanId', left(base_plan_id,7) || (8000000+n)::text)`,
      },
    },
  );
}

function counting(db: SqlSession) {
  const count: Count = { catalog: 0, costSharing: 0, lineage: 0, total: 0 };
  const session: SqlSession = {
    ...db,
    query: (sql, parameters) => {
      count.total++;
      if (CATALOG_READ.test(sql)) count.catalog++;
      if (COST_SHARING_READ.test(sql)) count.costSharing++;
      if (LINEAGE_READ.test(sql)) count.lineage++;
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

async function rolledBack(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("roll back the synthetic rows");
  await expect(
    h.db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

const scenarios = [
  ["", async () => {}],
  [" and a crosswalk", withCrosswalk],
] as const;

describe("county catalog reads and queries per request", () => {
  for (const [name, call] of Object.entries(paths))
    for (const [scenario, crosswalk] of scenarios)
      it(`${name}${scenario}: the same reads with ${COPIES} more silver plans`, async () => {
        const setup = async (tx: SqlSession, copies: number) => {
          await SETUP[name]?.(tx, copies);
          await crosswalk(tx);
        };
        let before: Count | undefined, after: Count | undefined;
        await rolledBack(async (tx) => {
          await setup(tx, 0);
          before = await measure(tx, call, [SOURCE]);
        });
        await rolledBack(async (tx) => {
          await addCopies(tx);
          await setup(tx, COPIES);
          after = await measure(tx, call, [
            SOURCE,
            ...Array.from({ length: COPIES }, (_, i) => copyId(i + 1)),
          ]);
        });
        expect(
          after!.catalog,
          "catalog reads must not grow with the plans",
        ).toBe(before!.catalog);
        expect(
          before!.catalog,
          "catalog reads per request",
        ).toBeLessThanOrEqual(2);
        // Rating plans and describing them share one variant read for all of them.
        expect(
          after!.costSharing - before!.costSharing,
          "cost-sharing reads for the added plans",
        ).toBe(0);
        // Without a crosswalk the coverage check stops the lineage read. With one, the plans a
        // request describes share one read.
        const lineage = scenario && DESCRIBES_PLANS.has(name) ? 1 : 0;
        expect(before!.lineage, "lineage reads").toBe(lineage);
        expect(after!.lineage, "lineage reads for the added plans").toBe(
          lineage,
        );
        expect(
          after!.total - before!.total,
          `queries for ${COPIES} added plans`,
        ).toBeLessThanOrEqual(QUERIES_PER_ADDED_PLAN[name]! * COPIES);
      });
});
