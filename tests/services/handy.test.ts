import { afterAll, beforeAll, expect, it } from "vitest";
import { setup } from "../compat/v1/helpers.js";
import {
  lowestInput,
  lowestQuery,
  marketSummaryQuery,
} from "../../src/api/handy.js";
import {
  enumerateLowest,
  getMarketSummary,
  lowestPremiums,
  isLowestCell,
} from "../../src/services/handy.js";
import {
  handyManifest,
  readLowestCell,
  digest,
} from "../../src/db/handy-repository.js";
import { buildLowestPremiums } from "../../src/worker/handy-build.js";
import { countyPlans, resolveLocation } from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import { ratePremium } from "../../src/services/premiums.js";
import { familyOffer } from "../../src/services/coverage-family.js";
import { exchangeAttributeRows } from "../../src/api/repository.js";
import type { SqlSession, QueryOptions } from "../../src/db/database.js";
import { createApp } from "../../src/api/app.js";
import { connect } from "../mcp/client.js";
import {
  boundLowestResult,
  callLowestTool,
  MARKET_SUMMARY_TOOL,
  LOWEST_TOOL,
} from "../../src/mcp/handy.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { loadConfig } from "../../src/config/index.js";

// Real CMS/Census cuts, hash checked by setup. Mutations below are SYNTHETIC and rolled back.
let h: Awaited<ReturnType<typeof setup>>;
const input = lowestInput({
  zip: "77002",
  county: "48201",
  year: 2026,
  age: 40,
});
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const done = new Error("rollback synthetic mutant");
  try {
    await h.db.transaction(async (tx) => {
      await run(tx);
      throw done;
    });
  } catch (error) {
    if (error !== done) throw error;
  }
}

// Independent orchestration: each public candidate goes directly through ratePremium.
// It does not call the handy aggregate, builder or batched request reads.
async function slow(
  db: SqlSession,
  age: number,
  filters: { metal?: string; tobacco?: boolean } = {},
) {
  const location = await resolveLocation(db, input);
  const plans = (await countyPlans(db, "48201", 2026, "77002"))
    .filter(
      (p) =>
        p.on_exchange && p.metal.toLowerCase() === (filters.metal ?? "silver"),
    )
    .sort((a, b) => a.base_plan_id.localeCompare(b.base_plan_id));
  const candidates = [];
  for (const plan of plans) {
    const attrs = (
      await exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id)
    ).rows;
    const eligible = familyOffer(attrs, age >= 21, age < 21);
    if (eligible === false) continue;
    expect(eligible).toBe(true);
    const request = premiumRequest({
      plan_ids: [plan.base_plan_id],
      zip: "77002",
      county: "48201",
      coverage_start: "2026-01-01",
      members: [
        { age, tobacco: filters.tobacco ?? false, relationship: "subscriber" },
      ],
    });
    const { estimate } = await ratePremium(
      db,
      plan,
      plan.base_plan_id,
      request,
      location,
    );
    expect(estimate.status).toBe("rated");
    if (!("total_cents" in estimate)) throw new Error("Missing price");
    candidates.push({
      id: plan.base_plan_id,
      cents: estimate.total_cents!,
      provenance: estimate.provenance,
      rows: estimate.rate_rows_used,
      area:
        "rating_area_provenance" in estimate
          ? estimate.rating_area_provenance
          : null,
    });
  }
  const cents = Math.min(...candidates.map((p) => p.cents));
  return {
    candidates,
    cents,
    ties: candidates.filter((p) => p.cents === cents).map((p) => p.id),
  };
}

it("matches full direct rating enumeration at exact age-cell endpoints, including ordered evidence", async () => {
  for (const age of [0, 14, 15, 20, 21, 40, 63, 64, 120]) {
    const request = lowestInput({ ...input, age });
    const expected = await slow(h.db, age);
    expect(["active", "current"]).toContain(
      (await buildLowestPremiums(h.db, request)).status,
    );
    const fast = await lowestPremiums(h.db, request),
      fallback = await lowestPremiums(h.db, request, { slow: true });
    expect(JSON.stringify(fast)).toBe(JSON.stringify(fallback));
    expect(fast.lowest.monthly_cents).toBe(expected.cents);
    expect(fast.lowest.plan_id).toBe(expected.ties[0]);
    expect(fast.ties).toEqual(expected.ties.slice(0, 50));
    expect(fast.lowest.tied_plan_count).toBe(expected.ties.length);
    expect(fast.candidate_count).toBe(expected.candidates.length);
    expect(fast.provenance.candidates.length).toBeLessThanOrEqual(10);
    for (const [index, candidate] of expected.candidates
      .slice(0, 10)
      .entries()) {
      expect(fast.provenance.candidates[index]).toMatchObject({
        plan_id: candidate.id,
        monthly_cents: candidate.cents,
        rate_rows_used: candidate.rows,
      });
      expect(
        fast.provenance.evidence[
          Number(fast.provenance.candidates[index]!.evidence_ref)
        ],
      ).toEqual(candidate.provenance);
      expect(
        fast.provenance.evidence[
          Number(fast.provenance.candidates[index]!.rating_area_ref)
        ],
      ).toEqual(candidate.area);
    }
  }
});

it("rejects inputs outside the supported minimum contract and requires both year and age", () => {
  for (const patch of [
    { age: undefined },
    { year: undefined },
    { age: 121 },
    { age: -1 },
    { age: 1.5 },
    { premium_basis: "ehb" },
    { market_segment: "off_exchange" },
    { coverage_start: "2026-02-01" },
    { coverage_start: "" },
    { income: 100 },
  ])
    expect(() => lowestInput({ ...input, ...patch })).toThrow();
  expect(lowestInput({ ...input, tobacco: true }).tobacco).toBe(true);
  expect(lowestInput({ ...input, metal: "gold" }).metal).toBe("gold");
  expect(() => lowestQuery({ zip: "77002", year: "2026", age: "" })).toThrow();
  expect(() =>
    lowestQuery({
      zip: "77002",
      year: "2026",
      age: "40",
      evidence_page: "100001",
    }),
  ).toThrow();
});

it("refuses unresolved geography and unloaded years identically on both paths", async () => {
  for (const request of [
    lowestInput({ ...input, year: 2025, coverage_start: undefined }),
    lowestInput({ ...input, zip: "00000", county: undefined }),
  ]) {
    const fast = await lowestPremiums(h.db, request),
      fallback = await lowestPremiums(h.db, request, { slow: true });
    expect(JSON.stringify(fast)).toBe(JSON.stringify(fallback));
    expect(fast.status).toBe("unknown");
    expect(fast.lowest.monthly_cents).toBeNull();
  }
});

it("rejects stale sources and missing cheaper rates rather than certifying an observed winner", async () => {
  await buildLowestPremiums(h.db, input);
  const initial = await lowestPremiums(h.db, input);
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
      initial.lowest.plan_id,
    ]);
    expect(
      await readLowestCell(tx, input, await handyManifest(tx)),
    ).toBeUndefined();
    const answer = await lowestPremiums(tx, input);
    expect(answer.status).toBe("unknown");
    expect(answer.reason).toBe("rate_rows_missing");
    expect(answer.lowest.monthly_cents).toBeNull();
  });
  await rollback(async (tx) => {
    await tx.query(
      "UPDATE state_rating_rule SET method='unsupported' WHERE state='TX'",
    );
    expect(
      await readLowestCell(tx, input, await handyManifest(tx)),
    ).toBeUndefined();
    expect((await lowestPremiums(tx, input)).reason).toBe(
      "unsupported_rating_method",
    );
  });
});

it("rejects expired rows, partial builds, corrupt payloads and the wrong county offer set", async () => {
  await buildLowestPremiums(h.db, input);
  for (const sql of [
    "UPDATE handy_lowest_build SET expires_at=now()-interval '1 second'",
    "UPDATE handy_lowest_build SET expired_at=now()-interval '1 second'",
    "UPDATE handy_lowest_build SET written_partitions=0,complete=false",
    "UPDATE handy_lowest_build SET payload=payload||' '",
    "UPDATE handy_lowest_build SET request_json=replace(request_json,'48201','48203')",
  ])
    await rollback(async (tx) => {
      await tx.exec(sql);
      expect(
        await readLowestCell(tx, input, await handyManifest(tx)),
      ).toBeUndefined();
      expect(JSON.stringify(await lowestPremiums(tx, input))).toBe(
        JSON.stringify(await lowestPremiums(tx, input, { slow: true })),
      );
    });
});

it("catches a one-cent winner, dropped evidence and missing cheaper candidate mutants", async () => {
  const expected = await slow(h.db, input.age);
  const cell = await enumerateLowest(h.db, input, await handyManifest(h.db));
  const cheaper = structuredClone(cell);
  cheaper.lowest.monthly_cents!++;
  expect(isLowestCell(cheaper)).toBe(false);
  const missing = structuredClone(cell);
  missing.provenance.candidates = [];
  expect(isLowestCell(missing)).toBe(false);
  const pruned = expected.candidates.filter(
    (p) => !expected.ties.includes(p.id),
  );
  expect(Math.min(...pruned.map((p) => p.cents))).not.toBe(expected.cents);
  const trace = structuredClone(cell);
  delete trace.provenance.candidates[0]!.rate_rows_used;
  expect(isLowestCell(trace)).toBe(false);
});

it("preserves legacy route bytes with the feature absent, off and on, and gates both added MCP definitions", async () => {
  await buildLowestPremiums(
    h.db,
    lowestInput({ zip: "77002", year: 2026, age: 40 }),
  );
  const path = "/v1/plans?zip=77002&year=2026";
  const absent = await h.app.request(path),
    bytes = await absent.text();
  for (const enabled of [false, true]) {
    const app = createApp(h.db, { lowestPremiums: enabled });
    expect(await (await app.request(path)).text()).toBe(bytes);
    const newRoute = await app.request(
      "/v1/lowest-premiums?zip=77002&year=2026&age=40",
    );
    const summaryRoute = await app.request(
      "/v1/market-summary?zip=77002&year=2026",
    );
    expect(newRoute.status).toBe(enabled ? 200 : 404);
    expect(summaryRoute.status).toBe(enabled ? 200 : 404);
    if (enabled) expect(newRoute.headers.get("cache-control")).toBe("no-store");
  }
  expect(digest(bytes + " ")).not.toBe(digest(bytes));
  expect(() => expect(bytes + " ").toBe(bytes)).toThrow();
  const deps = { db: h.db, cursorSecret: "synthetic-handy-secret" };
  const off = await connect({ ...deps, lowestPremiums: false }),
    on = await connect({ ...deps, lowestPremiums: true });
  try {
    const oldTools = await off.client.listTools(),
      newTools = await on.client.listTools();
    expect(
      newTools.tools.filter(
        (t) => ![LOWEST_TOOL, MARKET_SUMMARY_TOOL].includes(t.name),
      ),
    ).toEqual(oldTools.tools);
    expect(newTools.tools.filter((t) => t.name === LOWEST_TOOL)).toHaveLength(
      1,
    );
    expect(
      newTools.tools.filter((t) => t.name === MARKET_SUMMARY_TOOL),
    ).toHaveLength(1);
    const answer = await on.client.callTool({
      name: LOWEST_TOOL,
      arguments: input,
    });
    expect(answer.isError).toBeFalsy();
    const native = await lowestPremiums(h.db, input);
    expect(answer.structuredContent).toMatchObject({
      ...native,
      next_cursor: null,
      truncated: false,
      omitted: { ties: 0, candidates: 0, excluded: 0, evidence: 0 },
    });
    const summaryAnswer = await on.client.callTool({
      name: MARKET_SUMMARY_TOOL,
      arguments: { zip: "77002", county: "48201", year: 2026 },
    });
    expect(summaryAnswer.isError, JSON.stringify(summaryAnswer)).toBeFalsy();
    expect(summaryAnswer.structuredContent).toMatchObject({
      status: "calculated",
      basis: { premium_basis: "not_requested", count_unit: "base_plan" },
    });
    expect(
      Buffer.byteLength(JSON.stringify(answer)) + 4096,
    ).toBeLessThanOrEqual(64 * 1024);
  } finally {
    await off.close();
    await on.close();
  }
});

it("counts distinct base plans and issuers by separate metals, with no default age", async () => {
  const summary = await getMarketSummary(
    h.db,
    marketSummaryQuery({
      zip: "77002",
      county: "48201",
      year: "2026",
    }),
  );
  const catalog = await countyPlans(h.db, "48201", 2026, "77002");
  const plans = new Map(
    catalog.filter((p) => p.on_exchange).map((p) => [p.base_plan_id, p]),
  );
  expect(summary.status).toBe("calculated");
  expect(summary.plan_count).toBe(plans.size);
  expect(summary.carrier_count).toBe(
    new Set([...plans.values()].map((p) => p.issuer_id)).size,
  );
  expect(summary.basis.premium_basis).toBe("not_requested");
  expect(summary.by_metal.map((row) => row.metal)).toEqual([
    "bronze",
    "expanded bronze",
    "silver",
    "gold",
    "platinum",
    "catastrophic",
  ]);
  for (const row of summary.by_metal) {
    const group = [...plans.values()].filter(
      (p) => p.metal.toLowerCase() === row.metal,
    );
    expect(row.plan_count).toBe(group.length);
    expect(row.carrier_count).toBe(new Set(group.map((p) => p.issuer_id)).size);
  }
  expect(() =>
    marketSummaryQuery({ zip: "77002", year: "2026", tobacco: "true" }),
  ).toThrow();
});

it("keeps an unloaded market unknown instead of returning zero counts", async () => {
  const query = h.db.query.bind(h.db);
  const db: SqlSession = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
      options?: QueryOptions,
    ) {
      if (sql.includes("FROM puf_active_catalog")) return { rows: [] as Row[] };
      return query<Row>(sql, parameters, options);
    },
    exec: (sql) => h.db.exec(sql),
  };
  const result = await getMarketSummary(db, {
    zip: "77002",
    county: "48201",
    year: 2025,
  });
  expect(result).toMatchObject({
    status: "unknown",
    reason: "catalog_not_loaded",
    plan_count: null,
    carrier_count: null,
  });
});

it("refuses ambiguous ZIPs and county-only summaries with partial offerings", async () => {
  await rollback(async (tx) => {
    await tx.exec(`INSERT INTO zcta_county
      (zcta,county_fips,county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row)
      SELECT zcta,'48001','SYNTHETIC',arealand_zcta,areawater_zcta,arealand_county,areawater_county,0,0,snapshot_id,source_row+10000000
      FROM zcta_county WHERE zcta='77002' LIMIT 1`);
    const ambiguous = await getMarketSummary(tx, {
      zip: "77002",
      year: 2026,
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.plan_count).toBeNull();
  });
  await rollback(async (tx) => {
    const plan = (await countyPlans(tx, "48201", 2026, "77002"))[0]!;
    await tx.query(
      `UPDATE service_area_county SET partial_county=true,zip_codes='77003'
      WHERE service_area_id IN (SELECT service_area_id FROM plan WHERE base_plan_id=$1)`,
      [plan.base_plan_id],
    );
    const partial = await getMarketSummary(tx, {
      county: "48201",
      year: 2026,
    });
    expect(partial).toMatchObject({
      status: "location_requires_zip",
      reason: "zip_limited_service_area",
      plan_count: null,
    });
  });
});

it("accepts tobacco and the added metal categories for single-age minima", () => {
  expect(
    lowestInput({
      zip: "77002",
      year: 2026,
      age: 40,
      metal: "bronze",
      tobacco: true,
    }),
  ).toMatchObject({
    metal: "bronze",
    tobacco: true,
  });
  expect(
    lowestInput({
      zip: "77002",
      year: 2026,
      age: 40,
      metal: "expanded bronze",
    }),
  ).toMatchObject({
    metal: "expanded bronze",
  });
  expect(() =>
    lowestInput({ zip: "77002", year: 2026, age: 40, metal: "platinum" }),
  ).toThrow();
});

it("matches every supported metal range against full rate enumeration", async () => {
  for (const metal of ["silver", "bronze", "expanded bronze", "gold"]) {
    const expected = await slow(h.db, 40, { metal, tobacco: false });
    const result = await getMarketSummary(h.db, {
      zip: "77002",
      county: "48201",
      year: 2026,
      metal,
      age: 40,
    });
    expect(result.status).toBe("calculated");
    expect(result.by_metal).toHaveLength(1);
    expect(result.by_metal[0]).toMatchObject({
      metal,
      minimum_monthly_cents: Math.min(
        ...expected.candidates.map((p) => p.cents),
      ),
      maximum_monthly_cents: Math.max(
        ...expected.candidates.map((p) => p.cents),
      ),
      rated_count: expected.candidates.length,
    });
  }
});

it("uses tobacco-rated bronze prices for the market range", async () => {
  const expected = await slow(h.db, 40, { metal: "bronze", tobacco: true });
  const nonTobacco = await slow(h.db, 40, { metal: "bronze", tobacco: false });
  expect(expected.cents).not.toBe(nonTobacco.cents);
  const minimum = await lowestPremiums(
    h.db,
    { ...input, metal: "bronze", tobacco: true },
    { slow: true },
  );
  expect(minimum.lowest.monthly_cents).toBe(expected.cents);
  const result = await getMarketSummary(h.db, {
    zip: "77002",
    county: "48201",
    year: 2026,
    metal: "bronze",
    age: 40,
    tobacco: true,
  });
  expect(result.status).toBe("calculated");
  const row = result.by_metal[0]!;
  expect(row).toMatchObject({
    metal: "bronze",
    minimum_monthly_cents: Math.min(...expected.candidates.map((p) => p.cents)),
    maximum_monthly_cents: Math.max(...expected.candidates.map((p) => p.cents)),
    rated_count: expected.candidates.length,
  });
  const evidenceRefs = row.evidence_refs as Record<string, unknown>;
  for (const key of ["catalog_snapshots", "pricing_snapshots"]) {
    const refs = evidenceRefs[key];
    expect(Array.isArray(refs)).toBe(true);
    if (!Array.isArray(refs)) throw new Error(`${key} must be an array`);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref: unknown) => typeof ref === "string")).toBe(true);
  }
});

it("the MCP byte guard omits oversized rows and preserves the summary", () => {
  const result = {
    ties: ["winner", "other"],
    provenance: {
      candidates: [{ source_row: "x".repeat(80_000) }],
      excluded: [],
      evidence: [{ source_url: "https://example.test/" }],
    },
    lowest: { plan_id: "winner", monthly_cents: 12345, tied_plan_count: 2 },
    completeness: { rates: "complete" },
    truncated: false,
    omitted: { ties: 0, candidates: 0, excluded: 0, evidence: 0 },
  };
  boundLowestResult(result);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      }),
    ) + 4096,
  ).toBeLessThanOrEqual(64 * 1024);
  expect(result.truncated).toBe(true);
  expect(result.omitted.candidates).toBe(1);
  expect(result.lowest).toEqual({
    plan_id: "winner",
    monthly_cents: 12345,
    tied_plan_count: 2,
  });
  expect(result.completeness).toEqual({ rates: "complete" });
});

it("keeps public quoting off and MCP uncached", async () => {
  const app = createApp(h.db, { lowestPremiums: true, publicQuoting: false });
  expect(
    (await app.request("/v1/lowest-premiums?zip=77002&year=2026&age=40"))
      .status,
  ).toBe(503);
  const result = await callLowestTool(
    { db: h.db, lowestPremiums: true, publicQuoting: false },
    input,
  );
  expect(result).toHaveProperty("isError", true);
});

it("uses the shared cache with a typed single-age entry; off and store outage preserve bytes", async () => {
  const store = new MemoryCache(64 * 1024 ** 2);
  const cache = createResponseCache(h.db, undefined, { store });
  const original = await lowestPremiums(h.db, input);
  await lowestPremiums(h.db, input, { cache });
  const found = await lowestPremiums(h.db, input, { cache });
  expect(JSON.stringify(found)).toBe(JSON.stringify(original));
  expect(cache.stats().hits).toBeGreaterThan(0);
  const off = createResponseCache(h.db, undefined, {
    config: loadConfig({ OPENPLANS_API_CACHE: "off" }),
  });
  expect(
    JSON.stringify(await lowestPremiums(h.db, input, { cache: off })),
  ).toBe(JSON.stringify(original));
  const outage = createResponseCache(h.db, undefined, {
    store: {
      get: async () => {
        throw new Error("synthetic outage");
      },
      set: async () => {},
      bytes: () => 0,
    },
  });
  expect(
    JSON.stringify(await lowestPremiums(h.db, input, { cache: outage })),
  ).toBe(JSON.stringify(original));
});

it("refuses a missing generation ledger and retries a publication during a read", async () => {
  await rollback(async (tx) => {
    await tx.query("DELETE FROM api_data_generation WHERE table_name='rate'");
    await expect(lowestPremiums(tx, input)).rejects.toThrow(
      "Data generation unavailable",
    );
  });
  let changed = false;
  const publishing: SqlSession = {
    ...h.db,
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      args?: unknown[],
      options?: QueryOptions,
    ) => {
      const result = await h.db.query<Row>(sql, args, options);
      if (!changed && sql.includes("JOIN handy_lowest_build")) {
        changed = true;
        await h.db.query(
          "UPDATE api_data_generation SET revision=revision+1 WHERE table_name='rate'",
        );
      }
      return result;
    },
  };
  const result = await lowestPremiums(publishing, input);
  expect(changed).toBe(true);
  expect(result).toEqual(await lowestPremiums(h.db, input, { slow: true }));
});

it("keeps ZIP-specific offering sets distinct and refuses county-only partial offers", async () => {
  const initial = await lowestPremiums(h.db, input);
  await rollback(async (tx) => {
    await tx.query(
      `UPDATE service_area_county SET partial_county=true,zip_codes='77003'
      WHERE service_area_id IN (SELECT service_area_id FROM plan WHERE base_plan_id=$1)`,
      [initial.lowest.plan_id],
    );
    const county = lowestInput({ county: "48201", year: 2026, age: 40 });
    expect((await lowestPremiums(tx, county)).status).toBe(
      "location_requires_zip",
    );
    const request = await lowestPremiums(tx, input);
    expect(request.lowest.plan_id).not.toBe(initial.lowest.plan_id);
    expect(request).toEqual(await lowestPremiums(tx, input, { slow: true }));
  });
  await rollback(async (tx) => {
    // Synthetic second county for an existing ZIP, on a disposable transaction only.
    await tx.exec(`INSERT INTO zcta_county
      (zcta,county_fips,county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row)
      SELECT zcta,'48001','SYNTHETIC',arealand_zcta,areawater_zcta,arealand_county,areawater_county,0,0,snapshot_id,source_row+10000000
      FROM zcta_county WHERE zcta='77002' LIMIT 1`);
    const ambiguous = lowestInput({ zip: "77002", year: 2026, age: 40 });
    expect((await lowestPremiums(tx, ambiguous)).status).toBe("ambiguous");
    expect(
      (await lowestPremiums(tx, ambiguous)).lowest.monthly_cents,
    ).toBeNull();
  });
});

it("sorts all exact price ties and rejects a missing filed validity interval", async () => {
  await rollback(async (tx) => {
    // Synthetic equal prices retain their real row references and distinct plan identities.
    await tx.exec(
      "UPDATE rate SET individual_rate_cents=100 WHERE age_band='40'",
    );
    const answer = await lowestPremiums(tx, input);
    expect(answer.lowest.tied_plan_count).toBeGreaterThan(1);
    expect(answer.lowest.plan_id).toBe([...answer.ties].sort()[0]);
    expect(answer.ties).toEqual([...new Set(answer.ties)].sort());
    await tx.exec(
      "UPDATE rate SET effective_date='2025-01-01',expiration_date='2025-12-31' WHERE age_band='40'",
    );
    expect((await lowestPremiums(tx, input)).status).toBe("unknown");
  });
});

it("retains source restrictions before cache hits and invalidates warm entries on publication", async () => {
  const { runWithScope, restrictCacheLevel } =
    await import("../../src/plugins/request-scope.js");
  const cache = createResponseCache(h.db);
  await lowestPremiums(h.db, input, { cache });
  const hits = cache.stats().hits;
  await runWithScope(async () => {
    restrictCacheLevel("none");
    await lowestPremiums(h.db, input, { cache });
  });
  expect(cache.stats().hits).toBe(hits);
  await rollback(async (tx) => {
    await tx.exec(
      "UPDATE state_rating_rule SET method='unsupported' WHERE state='TX'",
    );
    expect((await lowestPremiums(tx, input, { cache })).reason).toBe(
      "unsupported_rating_method",
    );
  });
});

it("rebuilds registered cells after a successful worker load", async () => {
  const { runWorker } = await import("../../src/worker/commands.js");
  const { coreMigrations } = await import("../pglite.js");
  const core = await coreMigrations();
  const previous = process.env.OPENPLANS_LOWEST_PREMIUMS;
  process.env.OPENPLANS_LOWEST_PREMIUMS = "on";
  try {
    await buildLowestPremiums(h.db, input);
    const before = await h.db.query(
      "SELECT build_id FROM handy_lowest_active ORDER BY request_key",
    );
    const errors: string[] = [];
    const code = await runWorker(
      ["ingest", "rating-rules"],
      () => ({ ...h.db, close: async () => {} }),
      { out: () => {}, error: (message) => errors.push(message) },
      core.directory,
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    const after = await h.db.query(
      "SELECT build_id FROM handy_lowest_active ORDER BY request_key",
    );
    expect(after.rows).not.toEqual(before.rows);
    expect(
      await readLowestCell(h.db, input, await handyManifest(h.db)),
    ).toBeDefined();
  } finally {
    if (previous === undefined) delete process.env.OPENPLANS_LOWEST_PREMIUMS;
    else process.env.OPENPLANS_LOWEST_PREMIUMS = previous;
    await core.cleanup();
  }
});

it("uses only local geography even when an optional geography credential is configured", async () => {
  const previous = process.env.CMS_API_KEY;
  process.env.CMS_API_KEY = "synthetic-handy-no-network";
  let liveReservations = 0;
  const guarded: SqlSession = {
    ...h.db,
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      args?: unknown[],
      options?: QueryOptions,
    ) => {
      if (sql.includes("UPDATE cms_zip_budget")) {
        liveReservations++;
        throw new Error("Synthetic live lookup guard");
      }
      return h.db.query<Row>(sql, args, options);
    },
  };
  try {
    const result = await lowestPremiums(guarded, {
      zip: "00000",
      year: 2026,
      age: 40,
    });
    expect(result.reason).toBe("zip_not_in_loaded_geography");
    expect(liveReservations).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.CMS_API_KEY;
    else process.env.CMS_API_KEY = previous;
  }
});
