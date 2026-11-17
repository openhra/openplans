import type { getPlan } from "../../src/services/catalog.js";
import type * as CompatModule from "../../src/compat/v1/index.js";
import type * as ToolsModule from "../../src/mcp/tools.js";
import type * as DrugsModule from "../../src/services/drugs.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { setup, TOKEN, headers } from "../compat/v1/helpers.js";
import { canonicalReader } from "../../src/plugins/canonical-reader.js";
import { compileSource } from "../../plugins/msot/src/resolver.js";
import { marketSource } from "../../plugins/msot/tests/fixtures.js";
import {
  withCatalogPolicy,
  guardCatalogPlans,
} from "../../src/services/catalog-policy.js";
import { loadConfig } from "../../src/config/index.js";
import { createApp } from "../../src/api/app.js";
import { benchmarkSilver } from "../../src/services/catalog.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import { ichraRequest, benchmarkRequest } from "../../src/api/validation.js";
import type { benchmark } from "../../src/services/subsidies.js";
import { resolveLocation } from "../../src/api/repository.js";
import { callTool } from "../../src/mcp/tools.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";

// Synthetic operator exclusions and household over unmodified public CMS fixture cuts.
let fixture: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  fixture = await setup();
});
afterAll(async () => {
  await fixture?.close();
});
const policy = loadConfig(
  {},
  {
    version: 1,
    catalogPolicy: {
      provider: "msot",
      source: "agency-market",
      selection: "marketable_only",
      asOf: "2026-11-15",
    },
  },
).catalogPolicy!;
function excluding<T>(
  run: () => Promise<T>,
  transport: "rest" | "compat" | "mcp" = "rest",
) {
  const source = marketSource();
  source.rules[1]!.scope = { state: "TX" };
  source.rules[1]!.value = { state: "known", value: false };
  const provider = compileSource(source, canonicalReader);
  return withCatalogPolicy(
    policy,
    provider,
    { db: fixture.db, signal: new AbortController().signal },
    transport,
    { market_segment: "on_exchange" },
    run,
  );
}
const cheap = "87226TX0100011";
const benchmarkParams = { zip: "77002", year: "2026", ages: "40" };
const employee = ichraRequest({
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 300_000 },
  income: [{ measure: "household", annual_cents: 4_118_000 }],
});
it("keeps an excluded cheap plan in SLCSP, benchmark and ICHRA calculations", async () => {
  const publicBenchmark = await benchmarkSilver(fixture.db, benchmarkParams);
  const publicIchra = await ichraAffordability(fixture.db, employee);
  expect(publicBenchmark.benchmark_plan_ids).toContain(cheap);
  expect(publicIchra.lcsp?.plan_ids).toContain(cheap);
  await excluding(async () => {
    await expect(guardCatalogPlans([cheap], 2026)).rejects.toThrow(
      "PLAN_NOT_MARKETABLE",
    );
    const calculated = await benchmarkSilver(fixture.db, benchmarkParams);
    expect(calculated, "public_benchmark_universe").toEqual(publicBenchmark);
    expect(
      await ichraAffordability(fixture.db, employee),
      "public_ichra_universe",
    ).toEqual(publicIchra);
    expect(calculated.slcsp_monthly_cents).toBe(59_205);
  });
});
it("guards native/compat details, premiums, quotes and plan-linked provider/drug reads", async () => {
  const app = createApp(fixture.db, { premiumToken: TOKEN });
  const calls: [string, RequestInit?][] = [
    [`/v1/plans/${cheap}?year=2026`],
    [`/compat/v1/plans/medical/${cheap}?year=2026`, { headers }],
    [`/v1/plans/${cheap}/providers/1234567893?year=2026`],
    [`/v1/plans/${cheap}/drugs/123?year=2026`],
    [
      "/v1/quotes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          year: 2026,
          zip: "77002",
          plan_ids: [cheap],
          members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
        }),
      },
    ],
    [
      "/v1/premium-quotes",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          year: 2026,
          coverage_start: "2026-01-01",
          zip: "77002",
          plan_ids: [cheap],
          members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
        }),
      },
    ],
  ];
  for (const [path, init] of calls)
    await excluding(
      async () => {
        const response = await app.request(path, init);
        expect(await response.json(), `offering_guard:${path}`).toMatchObject({
          error: { code: "PLAN_NOT_MARKETABLE" },
        });
      },
      path.startsWith("/compat/") ? "compat" : "rest",
    );
});
it("guards MCP get/fetch/coverage calls before projection or public evidence lookup", async () => {
  for (const [name, input] of [
    ["get_plan", { plan_ref: cheap, year: 2026 }],
    ["fetch", { id: `plan:2026:${cheap}` }],
    [
      "check_provider_network",
      { plan_ids: [cheap], year: 2026, npis: ["1234567893"] },
    ],
    ["check_drug_coverage", { plan_ids: [cheap], year: 2026, rxcuis: ["123"] }],
  ] as const)
    await excluding(async () => {
      const result = await callTool({ db: fixture.db }, name, input);
      expect(
        result.structuredContent,
        `mcp_offering_guard:${name}`,
      ).toMatchObject({
        status: "error",
        error: { code: "PLAN_NOT_MARKETABLE" },
      });
    }, "mcp");
});
it("negative control rejects a bypassed native detail guard", async () => {
  const mutant = await plantMutant(
    new URL("../../src/services/catalog.ts", import.meta.url),
    "await guardCatalogPlans([id.full], year);",
    "void year;",
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as { getPlan: typeof getPlan };
    await excluding(async () => {
      const result = await module.getPlan(fixture.db, cheap, { year: "2026" });
      expect(() =>
        expect(result, "detail_guard_required").toHaveProperty(
          "error.code",
          "PLAN_NOT_MARKETABLE",
        ),
      ).toThrow("detail_guard_required");
    });
  } finally {
    await mutant.cleanup();
  }
});
it("negative control detects removal of an excluded cheap public benchmark", async () => {
  const mutant = await plantMutant(
    new URL("../../src/services/subsidies.ts", import.meta.url),
    ").filter(silver);",
    `).filter(silver).filter((plan) => plan.base_plan_id !== '${cheap}');`,
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as { benchmark: typeof benchmark };
    const request = benchmarkRequest(benchmarkParams);
    const location = await resolveLocation(fixture.db, request.location);
    await excluding(async () => {
      const result = await module.benchmark(fixture.db, request, location);
      expect(() =>
        expect(
          result.benchmark_plan_ids,
          "public_benchmark_universe",
        ).toContain(cheap),
      ).toThrow("public_benchmark_universe");
    });
  } finally {
    await mutant.cleanup();
  }
});

it("negative control detects a compatibility detail bypass", async () => {
  const mutant = await plantMutant(
    new URL("../../src/compat/v1/index.ts", import.meta.url),
    "await guardCatalogPlans([parsed.full], year);",
    "void year;",
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as typeof CompatModule;
    await excluding(async () => {
      const response = await module
        .compatRoutes(fixture.db)
        .request(`/compat/v1/plans/medical/${cheap}?year=2026`, { headers });
      expect(() =>
        expect(response.status, "compat_guard_required").toBe(403),
      ).toThrow("compat_guard_required");
    }, "compat");
  } finally {
    await mutant.cleanup();
  }
});
it("negative control detects a typed MCP fetch bypass", async () => {
  const catalog = await plantMutant(
    new URL("../../src/services/catalog.ts", import.meta.url),
    "await guardCatalogPlans([id.full], year);",
    "void year;",
  );
  const tools = await plantMutant(
    new URL("../../src/mcp/tools.ts", import.meta.url),
    '"../services/catalog.js"',
    JSON.stringify(pathToFileURL(catalog.path).href),
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(tools.path).href
    )) as typeof ToolsModule;
    await excluding(async () => {
      const result = await module.callTool({ db: fixture.db }, "fetch", {
        id: `plan:2026:${cheap}`,
      });
      expect(() =>
        expect(result.structuredContent, "fetch_guard_required").toMatchObject({
          error: { code: "PLAN_NOT_MARKETABLE" },
        }),
      ).toThrow("fetch_guard_required");
    }, "mcp");
  } finally {
    await tools.cleanup();
    await catalog.cleanup();
  }
});
it("negative control detects a plan-linked drug coverage bypass", async () => {
  const mutant = await plantMutant(
    new URL("../../src/services/drugs.ts", import.meta.url),
    "if (catalogPolicyActive())\n    await guardCatalogPlans([v.planId(plan).full], drugYear(year));",
    "void plan;",
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as typeof DrugsModule;
    await excluding(async () => {
      const result = await module.checkDrugCoverage(
        fixture.db,
        cheap,
        "123",
        "2026",
      );
      expect(() =>
        expect(result, "coverage_guard_required").toHaveProperty(
          "error.code",
          "PLAN_NOT_MARKETABLE",
        ),
      ).toThrow("coverage_guard_required");
    });
  } finally {
    await mutant.cleanup();
  }
});
it("returns the original public body only with explicit public-read permission", async () => {
  const source = marketSource();
  const provider = compileSource(source, canonicalReader);
  const original = await fixture.app.request(`/v1/plans/${cheap}?year=2026`);
  const app = createApp(
    fixture.db,
    { premiumToken: TOKEN },
    {
      config: loadConfig(
        {},
        { version: 1, catalogPolicy: { ...policy, allowPublicRead: true } },
      ),
      plugins: {
        routes: [],
        catalogPolicies: {
          msot: { plugin: "@openplans/plugin-msot", spec: provider },
        },
      },
    },
  );
  const response = await app.request(`/v1/plans/${cheap}?year=2026`, {
    headers: { "X-OpenPlans-MSoT": "public" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(await original.text());
  expect(response.headers.get("X-OpenPlans-MSoT")).toBeNull();
});
