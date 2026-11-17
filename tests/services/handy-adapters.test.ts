import { afterAll, beforeAll, expect, it } from "vitest";
import { setup, TOKEN } from "../compat/v1/helpers.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { post } from "../mcp/transport-helpers.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { createApp } from "../../src/api/app.js";
import { householdHandy } from "../../src/services/handy.js";
import { quotePlans } from "../../src/services/quotes.js";
import {
  countyPlans,
  exchangeAttributeRows,
} from "../../src/api/repository.js";
import { familyOffer } from "../../src/services/coverage-family.js";
import { benchmarkSilver } from "../../src/services/catalog.js";
import {
  callBenchmarkTool,
  callLowestTool,
  callMarketSummaryTool,
} from "../../src/mcp/handy.js";
import { connect } from "../mcp/client.js";
import type { HandyMember } from "../../src/services/handy.js";
import type { SqlSession } from "../../src/db/database.js";

// Anonymous synthetic household inputs; plan, rate and geography evidence is hash-checked public cuts.
let h: Awaited<ReturnType<typeof setup>>;
const scope = { zip: "77002", county: "48201", year: 2026 };
const members: HandyMember[] = [
  { age: 40, relationship: "subscriber", tobacco: false },
  { age: 35, relationship: "spouse", tobacco: true },
  ...[8, 20, 15, 18, 21].map((age) => ({
    age,
    relationship: "child" as const,
    tobacco: false,
  })),
];
const deps = (db: SqlSession = h.db) => ({
  db,
  lowestPremiums: true,
  principal: { id: "synthetic" },
  policy: { canEstimate: () => true },
});
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
async function rollback(run: (db: SqlSession) => Promise<void>) {
  const done = new Error("SYNTHETIC adapter rollback");
  await expect(
    h.db.transaction(async (tx) => {
      await run(tx);
      throw done;
    }),
  ).rejects.toBe(done);
}
async function population(
  db: SqlSession,
  household: HandyMember[],
  metal: string,
) {
  const plans = (
    await countyPlans(db, scope.county, scope.year, scope.zip)
  ).filter((p) => p.on_exchange && p.metal.toLowerCase() === metal);
  const quotes = new Map<string, number>();
  let page: number | null = 1;
  while (page !== null) {
    const result = await quotePlans(db, { ...scope, members: household, page });
    for (const q of result.quotes)
      if (q.status === "rated" && "total_cents" in q)
        quotes.set(q.plan_id, q.total_cents!);
    page = result.next_page;
  }
  const expected = [];
  for (const p of plans) {
    const attrs = (
      await exchangeAttributeRows(db, p.snapshot_id, p.base_plan_id)
    ).rows;
    const eligible = familyOffer(
      attrs,
      household.some((m) => m.age >= 21),
      household.some((m) => m.age < 21),
    );
    if (eligible === false) continue;
    expect(eligible).toBe(true);
    expect(quotes.has(p.base_plan_id)).toBe(true);
    expected.push({
      id: p.base_plan_id,
      cents: quotes.get(p.base_plan_id)!,
      issuer: p.issuer_id,
    });
  }
  return expected.sort((a, b) => a.cents - b.cents || a.id.localeCompare(b.id));
}
function assertMinimum(
  actual: Awaited<ReturnType<typeof householdHandy>>,
  expected: { id: string; cents: number }[],
) {
  if (!("lowest" in actual)) throw new Error("missing minimum");
  const ties = expected
    .filter((p) => p.cents === expected[0]?.cents)
    .map((p) => p.id);
  expect(actual.lowest, "full_household_minimum").toEqual({
    plan_id: ties[0] ?? null,
    monthly_cents: expected[0]?.cents ?? null,
    tied_plan_count: expected.length ? ties.length : null,
  });
  expect(actual.candidate_count).toBe(expected.length);
  expect(actual.ties).toEqual(ties.slice(0, 50));
}
it("household POSTs equal independent full quote enumeration, with source evidence", async () => {
  const app = createApp(h.db, { lowestPremiums: true, premiumToken: TOKEN });
  for (const household of [members, members.slice(0, 2), [members[0]!]]) {
    for (const metal of ["silver", "gold", "bronze", "expanded bronze"]) {
      const input = { ...scope, members: household, metal };
      const expected = await population(h.db, household, metal);
      const response = await app.request("/v1/lowest-premiums", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-cache")).toBe("bypass");
      const actual = await householdHandy(h.db, input);
      expect(await response.text()).toBe(JSON.stringify(actual));
      assertMinimum(actual, expected);
      for (const c of actual.provenance.candidates)
        expect(actual.provenance.evidence[c.evidence_ref]).toBeDefined();
      const rangeResponse = await app.request("/v1/market-summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(input),
      });
      const summary = await householdHandy(h.db, input, true);
      expect(await rangeResponse.text()).toBe(JSON.stringify(summary));
      if (!("by_metal" in summary)) throw new Error("missing market summary");
      expect(summary.by_metal[0]).toMatchObject({
        plan_count: expected.length,
        carrier_count: new Set(expected.map((p) => p.issuer)).size,
        minimum_monthly_cents: expected[0]?.cents ?? null,
        maximum_monthly_cents: expected.at(-1)?.cents ?? null,
      });
    }
  }
});
it("households are request-only; a cached household fails the same population assertion", async () => {
  const first = await householdHandy(h.db, {
    ...scope,
    members: [members[0]!],
  });
  const input = { ...scope, members };
  const expected = await population(h.db, members, "silver");
  assertMinimum(await householdHandy(h.db, input), expected);
  expect(() => assertMinimum(first, expected)).toThrow(
    "full_household_minimum",
  );
});
it("rejects employer-age substitution, independent minima, and one-cent mutants", async () => {
  await rollback(async (tx) => {
    const plans = (
      await countyPlans(tx, scope.county, scope.year, scope.zip)
    ).filter((p) => p.on_exchange && p.metal.toLowerCase() === "silver");
    for (const [i, p] of plans.entries())
      await tx.query(
        "UPDATE rate SET individual_rate_cents=CASE WHEN age_band='40' THEN $2::bigint ELSE $3::bigint END WHERE base_plan_id=$1",
        [p.base_plan_id, i === 0 ? 10000 : 90000, i === 0 ? 90000 : 10000],
      );
    const household = [
      members[0]!,
      { age: 10, relationship: "child" as const, tobacco: false },
    ];
    const expected = await population(tx, household, "silver");
    const actual = await householdHandy(tx, { ...scope, members: household });
    assertMinimum(actual, expected);
    if (!("lowest" in actual)) throw new Error("missing minimum");
    const individual = await Promise.all(
      household.map((m) => householdHandy(tx, { ...scope, members: [m] })),
    );
    const summed = structuredClone(actual);
    summed.lowest.monthly_cents = individual.reduce(
      (sum, r) => sum + ("lowest" in r ? r.lowest.monthly_cents! : 0),
      0,
    );
    expect(() => assertMinimum(summed, expected)).toThrow(
      "full_household_minimum",
    );
    const selfOnly = await householdHandy(tx, {
      ...scope,
      members: [members[0]!],
    });
    const selfExpected = await population(tx, [members[0]!], "silver");
    const lowestBand = await householdHandy(tx, {
      ...scope,
      members: [{ ...members[0]!, age: 0 }],
    });
    if (!("lowest" in selfOnly) || !("lowest" in lowestBand))
      throw new Error("Missing age selection");
    const employer = structuredClone(selfOnly);
    employer.lowest.plan_id = lowestBand.lowest.plan_id;
    employer.lowest.monthly_cents = selfExpected.find(
      (p) => p.id === employer.lowest.plan_id,
    )!.cents;
    expect(() => assertMinimum(employer, selfExpected)).toThrow(
      "full_household_minimum",
    );
    const penny = structuredClone(actual);
    penny.lowest.monthly_cents!++;
    expect(() => assertMinimum(penny, expected)).toThrow(
      "full_household_minimum",
    );
  });
});
it("switches and household admission apply to both POSTs; malformed and private fields are refused", async () => {
  for (const path of ["/v1/lowest-premiums", "/v1/market-summary"]) {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...scope, members }),
    };
    expect(
      (await createApp(h.db, { lowestPremiums: false }).request(path, init))
        .status,
    ).toBe(404);
    expect(
      (
        await createApp(h.db, {
          lowestPremiums: true,
          premiumToken: TOKEN,
        }).request(path, init)
      ).status,
    ).toBe(401);
    expect(
      (
        await createApp(h.db, {
          lowestPremiums: true,
          publicHousehold: false,
        }).request(path, init)
      ).status,
    ).toBe(503);
    const app = createApp(h.db, { lowestPremiums: true, premiumToken: TOKEN });
    for (const patch of [
      { age: 40 },
      { household_income_annual: 100 },
      { employer_age: 21 },
      { preset: "family-40-40-10-8-v1" },
      { members: Array(11).fill(members[0]) },
      { coverage_start: "2027-01-01" },
    ]) {
      expect(
        (
          await app.request(path, {
            ...init,
            headers: { ...init.headers, authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ ...scope, members, ...patch }),
          })
        ).status,
      ).toBe(400);
    }
  }
});
it("MCP household adapters match their service results and require the household grant", async () => {
  const input = { ...scope, members: members.slice(0, 2) };
  const minimum = await callLowestTool(deps(), input);
  expect(
    "isError" in minimum && minimum.isError,
    JSON.stringify(minimum),
  ).not.toBe(true);
  expect(minimum.structuredContent).toEqual({
    ...(await householdHandy(h.db, input)),
    next_cursor: null,
  });
  const summary = await callMarketSummaryTool(deps(), input);
  expect("isError" in summary && summary.isError).not.toBe(true);
  expect(summary.structuredContent).toEqual(
    await householdHandy(h.db, input, true),
  );
  expect(summary.structuredContent).toHaveProperty("by_metal");
  if (!("by_metal" in summary.structuredContent))
    throw new Error("Missing household metals");
  expect(summary.structuredContent.by_metal.map((g) => g.metal)).toEqual([
    "bronze",
    "expanded bronze",
    "silver",
    "gold",
    "platinum",
  ]);
  expect(
    (await callLowestTool({ db: h.db, lowestPremiums: true }, input))
      .structuredContent,
  ).toHaveProperty("error");
  expect(
    (await callMarketSummaryTool({ db: h.db, lowestPremiums: true }, input))
      .structuredContent,
  ).toHaveProperty("error");
  expect(
    (await callLowestTool(deps(), { ...input, age: 40 })).structuredContent,
  ).toHaveProperty("error");
  const client = await connect(deps());
  try {
    const result = await client.client.callTool({
      name: "get_lowest_premiums",
      arguments: input,
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toEqual(minimum.structuredContent);
    const listed = await client.client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("get_benchmark");
  } finally {
    await client.close();
  }
});
it("benchmark adds only its basis to the existing exact response; gross-as-SLCSP fails", async () => {
  for (const ages of [[40], [40, 10], [40, 35, 20, 18, 15, 8]]) {
    const expected = await benchmarkSilver(h.db, {
      zip: scope.zip,
      county: scope.county,
      year: String(scope.year),
      ages: ages.join(","),
    });
    const projected = await callBenchmarkTool(deps(), {
      year: scope.year,
      location: { zip: scope.zip, county: scope.county },
      ages,
    });
    expect("isError" in projected && projected.isError).not.toBe(true);
    if (!("basis" in projected.structuredContent))
      throw new Error("Missing benchmark basis");
    const { basis, ...native } = projected.structuredContent;
    expect(basis).toMatchObject({
      ages,
      tobacco_rating: "excluded",
      premium_basis: "ehb_plus_pediatric_dental",
    });
    expect(JSON.stringify(native)).toBe(JSON.stringify(expected));
    if (expected.status === "calculated") {
      const mutant = structuredClone(native);
      mutant.slcsp_monthly_cents = Math.max(
        ...expected.lowest_silver_plans.map((p) => p.gross_monthly_cents),
      );
      expect(() => expect(mutant).toEqual(expected)).toThrow();
    }
  }
  await rollback(async (tx) => {
    await tx.exec("UPDATE plan_attribute SET raw=raw-'EHBPercentTotalPremium'");
    const input = {
      year: scope.year,
      location: { zip: scope.zip },
      ages: [40],
    };
    const result = await callBenchmarkTool(deps(tx), input);
    expect(result.structuredContent).toMatchObject({
      status: "requires_benchmark_adjustments",
      slcsp_monthly_cents: null,
    });
  });
});
it("benchmark discovery is additive only when enabled and authorized; default/off bytes match", async () => {
  const absent = await connect({ db: h.db });
  const off = await connect({
    ...deps(),
    lowestPremiums: false,
    principal: undefined,
  });
  try {
    expect(JSON.stringify(await off.client.listTools())).toBe(
      JSON.stringify(await absent.client.listTools()),
    );
  } finally {
    await off.close();
    await absent.close();
  }
  expect(
    (
      await callBenchmarkTool(
        { ...deps(), lowestPremiums: false },
        { year: 2026, location: { zip: "77002" }, ages: [40] },
      )
    ).structuredContent,
  ).toHaveProperty("error");
  expect(
    (
      await callBenchmarkTool(
        { db: h.db, lowestPremiums: true },
        { year: 2026, location: { zip: "77002" }, ages: [40] },
      )
    ).structuredContent,
  ).toHaveProperty("error");
});

it("household HTTP and MCP bypass shared caches, enforce grants and retain cancellation", async () => {
  const store = new MemoryCache(1024 * 1024);
  const app = createApp(
    h.db,
    { lowestPremiums: true, premiumToken: TOKEN },
    { store },
  );
  for (const path of ["/v1/lowest-premiums", "/v1/market-summary"]) {
    const cancelled = new AbortController();
    cancelled.abort();
    const response = await app.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ ...scope, members }),
        signal: cancelled.signal,
      }),
    );
    expect(response.status).toBe(504);
  }
  const transport = createMcpHttp(h.db, {
    env: { OPENPLANS_LOWEST_PREMIUMS: "on", OPENPLANS_MCP_TOKEN: TOKEN },
    log: () => {},
  });
  for (const [name, args] of [
    ["get_benchmark", { year: 2026, location: { zip: "77002" }, ages: [40] }],
    ["get_lowest_premiums", { ...scope, members: members.slice(0, 2) }],
    ["get_market_summary", { ...scope, members: members.slice(0, 2) }],
  ] as const) {
    const denied = await transport.fetch(
      post("tools/call", { name, arguments: args }),
    );
    expect(denied.status).toBe(401);
    await denied.text();
    const allowed = await transport.fetch(
      post(
        "tools/call",
        { name, arguments: args },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await allowed.json();
    expect(body).toHaveProperty("result.structuredContent");
    expect(body).not.toHaveProperty("result.isError", true);
  }
  expect(store.keys()).toEqual([]);
});
it("benchmark keeps distinct tied silver plans and exactly preserves missing-EHB refusals", async () => {
  await rollback(async (tx) => {
    // SYNTHETIC equal filed cells in this disposable database, with explicit EHB fractions.
    await tx.exec("UPDATE rate SET individual_rate_cents=50000");
    await tx.exec(
      `UPDATE plan_attribute SET raw=raw || '{"EHBPercentTotalPremium":"1"}'::jsonb`,
    );
    const expected = await benchmarkSilver(tx, {
      zip: "77002",
      county: "48201",
      year: "2026",
      ages: "40",
    });
    expect(expected.status).toBe("calculated");
    expect(expected.slcsp_monthly_cents).toBe(50000);
    expect(
      new Set(expected.lowest_silver_plans.map((p) => p.plan_id)).size,
    ).toBe(2);
    const answer = await callBenchmarkTool(deps(tx), {
      year: 2026,
      location: { zip: "77002", county: "48201" },
      ages: [40],
    });
    if (!("basis" in answer.structuredContent))
      throw new Error("Missing benchmark projection");
    const { basis: _basis, ...native } = answer.structuredContent;
    expect(JSON.stringify(native)).toBe(JSON.stringify(expected));
  });
});
it("benchmark retries a publication and refuses repeated generation changes", async () => {
  for (const always of [false, true]) {
    await rollback(async (tx) => {
      let changes = 0;
      const publishing: SqlSession = {
        exec: (sql) => tx.exec(sql),
        async query<Row extends Record<string, unknown>>(
          sql: string,
          parameters?: unknown[],
        ) {
          const result = await tx.query<Row>(sql, parameters);
          if (
            sql.includes("FROM api_data_generation") &&
            (always || changes === 0)
          ) {
            await tx.exec(
              "UPDATE api_data_generation SET revision=revision+1 WHERE table_name='rate'",
            );
            changes++;
          }
          return result;
        },
      };
      const result = await callBenchmarkTool(deps(publishing), {
        year: 2026,
        location: { zip: "77002" },
        ages: [40],
      });
      if (always)
        expect(result.structuredContent).toHaveProperty(
          "error.code",
          "DATA_CHANGED",
        );
      else {
        expect(result.structuredContent).toHaveProperty("slcsp_monthly_cents");
        expect(changes).toBe(1);
      }
    });
  }
});

it("new household POSTs share the existing benchmark admission bucket", async () => {
  const app = createApp(h.db, {
    lowestPremiums: true,
    publicHousehold: true,
    now: () => 0,
  });
  for (let index = 0; index < 30; index++) {
    const path = index % 2 ? "/v1/lowest-premiums" : "/v1/market-summary";
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  }
  const response = await app.request(
    "/v1/benchmark?zip=77002&year=2026&ages=40",
  );
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBeTruthy();
});
