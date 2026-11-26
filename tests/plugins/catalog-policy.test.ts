import type { SqlSession } from "../../src/db/database.js";
import type * as CatalogPolicyModule from "../../src/plugins/catalog-policy.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import type { CatalogPolicyProvider } from "@openplans/plugin-sdk";
import { compileSource } from "../../plugins/msot/src/resolver.js";
import {
  plans,
  reader,
  scope,
  marketSource,
} from "../../plugins/msot/tests/fixtures.js";
import {
  withCatalogPolicy,
  parsePolicySelection,
  selectCatalogPlans,
  guardCatalogPlans,
  annotateCatalogPlan,
  catalogPolicyContext,
  requireCatalogServingReady,
} from "../../src/services/catalog-policy.js";
import { loadConfig } from "../../src/config/index.js";
import { createApp } from "../../src/api/app.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import {
  classifyCatalogHttp,
  classifyCatalogTool,
} from "../../src/plugins/catalog-policy.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";

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
const provider = () => compileSource(marketSource(), reader);
const run = <T>(
  fn: () => Promise<T>,
  config = policy,
  p: CatalogPolicyProvider = provider(),
) =>
  withCatalogPolicy(
    config,
    p,
    scope,
    "rest",
    { market_segment: "off_exchange" },
    fn,
  );
afterEach(() => vi.unstubAllEnvs());

it("selects before counts and limits and guards direct/nested reads with distinct decisions", async () => {
  const source = marketSource();
  source.rules.push({
    ...source.rules[1]!,
    id: "exclude-other",
    scope: { issuer_id: "issuer-demo-b" },
    value: { state: "known", value: false },
  });
  await run(
    async () => {
      const selected = await selectCatalogPlans(plans, 2026, (p) => p.id);
      expect(
        selected.map((p) => p.id),
        "filter_before_limit",
      ).toEqual(["plan-demo-a"]);
      await expect(guardCatalogPlans(["plan-demo-c"], 2026)).rejects.toThrow(
        "plan_not_marketable",
      );
      await expect(guardCatalogPlans(["plan-demo-b"], 2026)).rejects.toThrow(
        "marketability_unknown",
      );
      const annotated = await annotateCatalogPlan(
        { id: "plan-demo-a" },
        "plan-demo-a",
        2026,
      );
      expect(
        annotated.msot?.by_market_segment.off_exchange?.fields.marketable
          ?.value,
      ).toBe(true);
      expect(
        catalogPolicyContext()?.provenance.some((p) => p.rule_id === "offer"),
      ).toBe(true);
    },
    policy,
    compileSource(source, reader),
  );
});
it("validates typed aliases and requires an explicit channel for filters", () => {
  for (const params of [
    { marketable: "true" },
    { market_segment: "both" },
    {
      market_segment: "on_exchange",
      marketable: "true",
      "msot.field.marketable.eq": "false",
    },
    { market_segment: "on_exchange", "msot.field.premium.eq": "true" },
    { market_segment: "on_exchange", marketable: "yes" },
  ])
    expect(() => parsePolicySelection(params)).toThrow();
  expect(
    parsePolicySelection({
      market_segment: "off_exchange",
      "msot.field.marketable.eq": "false",
    }).filters,
  ).toEqual([{ field: "marketable", operator: "eq", value: false }]);
});
it("does not equate false and unknown and rejects non-filterable or transport-hidden fields", async () => {
  const filters = parsePolicySelection({
    market_segment: "off_exchange",
    "msot.field.marketable.state": "unknown",
  });
  await withCatalogPolicy(
    { ...policy, selection: "annotation" },
    provider(),
    scope,
    "rest",
    filters,
    async () => {
      expect(
        (await selectCatalogPlans(plans, 2026, (p) => p.id)).map((p) => p.id),
      ).toEqual(["plan-demo-c"]);
    },
  );
  await expect(
    withCatalogPolicy(
      policy,
      provider(),
      scope,
      "compat",
      parsePolicySelection({
        market_segment: "off_exchange",
        custom_payment_allowed: "true",
      }),
      () => selectCatalogPlans(plans, 2026, (p) => p.id),
    ),
  ).rejects.toThrow("msot_invalid_filter");
});
it("pins source, date, version and generation across nested reads and isolates sources", async () => {
  const original = provider();
  let sequence = 0;
  const changing: CatalogPolicyProvider = {
    resolve: async (input, scope) => {
      const result = await original.resolve(input, scope);
      return {
        ...result,
        msot: { ...result.msot, catalog_generation: String(++sequence) },
      };
    },
  };
  await run(
    async () => {
      await guardCatalogPlans([plans[0]!.id], 2026);
      await expect(guardCatalogPlans([plans[2]!.id], 2026)).rejects.toThrow(
        "msot_context_changed",
      );
    },
    policy,
    changing,
  );
  const other = marketSource();
  other.source_id = "other-source";
  other.rules[1]!.value = { state: "known", value: false };
  const a = run(() => selectCatalogPlans(plans, 2026, (p) => p.id));
  const b = run(
    () => selectCatalogPlans(plans, 2026, (p) => p.id),
    { ...policy, source: other.source_id },
    compileSource(other, reader),
  );
  expect(
    (await a).map((p) => p.id),
    "source_cache_isolation",
  ).toEqual(["plan-demo-a"]);
  expect(await b, "source_cache_isolation").toEqual([]);
});
it("never reads or writes a shared cache under policy context", async () => {
  const store = new MemoryCache(1024 * 1024);
  const get = vi.spyOn(store, "get"),
    set = vi.spyOn(store, "set");
  const cache = createResponseCache(scope.db, undefined, {
    store,
    config: loadConfig({}),
  });
  await run(async () => {
    for (let i = 0; i < 2; i++)
      await cache.catalog(
        {
          namespace: "synthetic",
          version: "1",
          generation: "g1",
          query: {},
          authorized: () => true,
          accept: (v): v is { value: boolean } => typeof v === "object",
          ttlSeconds: 60,
        },
        async () => ({ value: true }),
      );
  });
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
it("refuses configured missing providers, unauthorized public mode, and serving activation", async () => {
  const p = provider();
  const registries = {
    routes: [],
    catalogPolicies: { msot: { plugin: "@openplans/plugin-msot", spec: p } },
  };
  const path = "/v1/plans?county=48201&year=2026";
  const missing = createApp(
    scope.db,
    {},
    { config: loadConfig({}, { version: 1, catalogPolicy: policy }) },
  );
  expect(await (await missing.request(path)).json()).toMatchObject({
    error: { code: "msot_provider_unavailable" },
  });
  const app = createApp(
    scope.db,
    {},
    {
      plugins: registries,
      config: loadConfig({}, { version: 1, catalogPolicy: policy }),
    },
  );
  expect(
    await (
      await app.request(path, { headers: { "X-OpenPlans-MSoT": "public" } })
    ).json(),
  ).toMatchObject({ error: { code: "msot_public_read_forbidden" } });
  expect(await (await app.request(path)).json()).toMatchObject({
    error: { code: "msot_serving_disabled" },
  });
  expect(await (await app.request("/v1/medicare/plans")).json()).toMatchObject({
    error: { code: "msot_operation_unsupported" },
  });
  expect(() => requireCatalogServingReady()).toThrow("msot_serving_disabled");
});
it("requires explicit public permission before dispatch and keeps unknown operations closed", async () => {
  const db: SqlSession = {
    ...scope.db,
    query: async <Row extends Record<string, unknown>>(sql: string) =>
      sql.includes("api_data_generation")
        ? {
            rows: [
              { generation: "synthetic-policy-generation" },
            ] as unknown as Row[],
          }
        : scope.db.query(),
  };
  const p = provider();
  const app = createApp(
    db,
    {},
    {
      plugins: {
        routes: [],
        catalogPolicies: {
          msot: { plugin: "@openplans/plugin-msot", spec: p },
        },
      },
      config: loadConfig(
        {},
        { version: 1, catalogPolicy: { ...policy, allowPublicRead: true } },
      ),
    },
  );
  const publicResponse = await app.request("/v1/plans/not-a-plan?year=2026", {
    headers: { "X-OpenPlans-MSoT": "public" },
  });
  expect((await publicResponse.json()) as unknown).not.toMatchObject({
    error: { code: "msot_public_read_forbidden" },
  });
  expect(publicResponse.status).toBe(400);
  expect(publicResponse.headers.get("X-OpenPlans-MSoT")).toBeNull();
  expect(classifyCatalogHttp("GET", "/v1/new-catalog-route")).toBe(
    "unsupported",
  );
  expect(classifyCatalogTool("new_plugin_catalog_tool")).toBe("unsupported");
});

describe("named negative controls in disposable copies", () => {
  it("rejects unknown_as_false_metadata", async () => {
    const mutant = await plantMutant(
      new URL("../../plugins/msot/src/resolver.ts", import.meta.url),
      "const value = rule && !missing ? rule.value : definition.default;",
      "const value = rule && !missing ? rule.value : { state: 'known' as const, value: false };",
    );
    try {
      const m = (await import(
        /* @vite-ignore */ pathToFileURL(mutant.path).href
      )) as { compileSource: typeof compileSource };
      const result = await m.compileSource(marketSource(), reader).resolve(
        {
          source_id: "agency-market",
          plan_ids: ["plan-demo-c"],
          year: 2026,
          as_of: "2026-11-15",
        },
        scope,
      );
      expect(() =>
        expect(
          result.plans[0]!.msot.by_market_segment.off_exchange!.fields
            .marketable,
          "unknown_as_false_metadata",
        ).toMatchObject({ state: "unknown", value: null }),
      ).toThrow("unknown_as_false_metadata");
    } finally {
      await mutant.cleanup();
    }
  });
});

it("negative control detects selection after a page limit", async () => {
  const candidates = Array.from({ length: 101 }, (_, index) => ({
    ...plans[0]!,
    id: `synthetic-plan-${index}`,
    issuer_id: index === 100 ? "issuer-demo-a" : "issuer-demo-b",
  }));
  const batchReader = {
    plans: async (input: { plan_ids: string[] }) => ({
      catalog_generation: "synthetic-generation",
      plans: input.plan_ids.map((id) => candidates.find((p) => p.id === id)!),
    }),
  };
  const p = compileSource(marketSource(), batchReader);
  await run(
    async () => {
      expect(
        (await selectCatalogPlans(candidates, 2026, (p) => p.id)).map(
          (p) => p.id,
        ),
        "filter_before_limit",
      ).toEqual(["synthetic-plan-100"]);
    },
    policy,
    p,
  );
  const mutant = await plantMutant(
    new URL("../../src/services/catalog-policy.ts", import.meta.url),
    "return plans.filter((p) => selected(resolved!.get(identity(p))!, request));",
    "return plans.slice(0, 50).filter((p) => selected(resolved!.get(identity(p))!, request));",
  );
  try {
    const m = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as {
      withCatalogPolicy: typeof withCatalogPolicy;
      selectCatalogPlans: typeof selectCatalogPlans;
    };
    await m.withCatalogPolicy(
      policy,
      p,
      scope,
      "rest",
      { market_segment: "off_exchange" },
      async () => {
        const result = await m.selectCatalogPlans(
          candidates,
          2026,
          (p) => p.id,
        );
        expect(() =>
          expect(
            result.map((p) => p.id),
            "filter_before_limit",
          ).toEqual(["synthetic-plan-100"]),
        ).toThrow("filter_before_limit");
      },
    );
  } finally {
    await mutant.cleanup();
  }
});
it("negative control refuses a source A cached answer delivered under source B", async () => {
  const original = provider();
  const cached = await original.resolve(
    {
      source_id: policy.source,
      plan_ids: [plans[0]!.id],
      year: 2026,
      as_of: "2026-11-15",
      market_segment: "off_exchange",
    },
    scope,
  );
  const poisoned: CatalogPolicyProvider = { resolve: async () => cached };
  await expect(
    run(
      () => selectCatalogPlans([plans[0]!], 2026, (p) => p.id),
      { ...policy, source: "source-b" },
      poisoned,
    ),
    "source_cache_isolation",
  ).rejects.toThrow("msot_context_mismatch");
});

it("negative control rejects an unauthorized public-read bypass", async () => {
  const mutant = await plantMutant(
    new URL("../../src/plugins/catalog-policy.ts", import.meta.url),
    "if (!catalogPolicy.allowPublicRead)",
    "if (false)",
  );
  try {
    const { Hono } = await import("hono");
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as typeof CatalogPolicyModule;
    const app = new Hono();
    app.use(
      "*",
      module.catalogPolicyAdmission(
        loadConfig({}, { version: 1, catalogPolicy: policy }),
        {
          catalogPolicies: {
            msot: { plugin: "@openplans/plugin-msot", spec: provider() },
          },
        },
      ),
    );
    app.get("/v1/plans", (c) => c.json({ plans: [] }));
    const response = await app.request("/v1/plans", {
      headers: { "X-OpenPlans-MSoT": "public" },
    });
    expect(() =>
      expect(response.status, "public_permission_required").toBe(403),
    ).toThrow("public_permission_required");
  } finally {
    await mutant.cleanup();
  }
});

it("does not memoize a none-level answer", async () => {
  const { restrictCacheLevel, runWithScope } =
    await import("../../src/plugins/request-scope.js");
  const original = provider();
  const resolve = vi.fn(original.resolve);
  await runWithScope(async () => {
    restrictCacheLevel("none");
    await run(
      async () => {
        await guardCatalogPlans([plans[0]!.id], 2026);
        await guardCatalogPlans([plans[0]!.id], 2026);
      },
      policy,
      { resolve },
    );
  });
  expect(resolve).toHaveBeenCalledTimes(2);
});
it("can inspect an unknown decision when public channel evidence is missing", async () => {
  const unknownReader = {
    plans: async () => ({
      catalog_generation: "synthetic-generation",
      plans: [{ ...plans[0]!, off_exchange: null }],
    }),
  };
  const p = compileSource(marketSource(), unknownReader);
  await withCatalogPolicy(
    { ...policy, selection: "annotation" },
    p,
    scope,
    "rest",
    parsePolicySelection({
      market_segment: "off_exchange",
      "msot.field.marketable.state": "unknown",
    }),
    async () => {
      expect(
        (await selectCatalogPlans([plans[0]!], 2026, (p) => p.id)).map(
          (p) => p.id,
        ),
      ).toEqual([plans[0]!.id]);
    },
  );
});
