import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalReader } from "@openplans/plugin-sdk";
import { compileSource } from "../src/resolver.js";
import { resolveOutput, sourceSchema } from "../src/schema.js";
import type { Resolution } from "../src/schema.js";
import { loadConfig } from "../../../src/config/index.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { createApp } from "../../../src/api/app.js";
import { createMcpHttp } from "../../../src/mcp/http.js";
import { post, listedToolNames } from "../../../tests/mcp/transport-helpers.js";
import { plantMutant } from "../../../src/plugins/testing/artifacts.js";
import { pathToFileURL } from "node:url";
import { source, plans, reader, input, scope, db } from "./fixtures.js";

const config = (options?: unknown, enabled = true) =>
  loadConfig(
    {},
    {
      version: 1,
      plugins: [{ package: "@openplans/plugin-msot", enabled, options }],
    },
  );
afterEach(async () => {
  await loadPlugins(loadConfig({}, { version: 1 }), "api", { env: {} });
});
const field = (
  r: Resolution,
  at: number,
  channel: "on_exchange" | "off_exchange" | "unknown",
) =>
  r.plans[at]!.msot.by_market_segment[channel]!.fields.custom_payment_allowed;
function checkExample(r: Resolution) {
  expect(field(r, 0, "off_exchange").value, "issuer_rule_true").toBe(true);
  expect(field(r, 1, "on_exchange").value, "missing_flag_remains_unknown").toBe(
    null,
  );
  expect(
    field(r, 2, "off_exchange").value,
    "other_issuer_remains_unknown",
  ).toBe(null);
  expect(
    resolveOutput.safeParse(r).success,
    "actor_scope_provenance_required",
  ).toBe(true);
  const p = r.msot.provenance.find(
    (p) => p.id === field(r, 0, "off_exchange").provenance_ref,
  )!;
  expect(p.set_by, "actor_scope_provenance_required").toBe("operator-demo");
  expect(p.matched_scope, "actor_scope_provenance_required").toEqual(
    source.rules[0]!.scope,
  );
}
it("resolves three examples through wrapped REST and MCP with public facts and provenance", async () => {
  const loaded = await loadPlugins(config({ source }), "api", {
    canonicalReader: reader,
    env: {},
  });
  const app = createApp(db, undefined, { plugins: loaded.registries });
  const response = await app.request("/msot/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const rest = resolveOutput.parse(await response.json());
  checkExample(rest);
  expect(rest.plans.map((p) => p.public)).toEqual(plans);
  const mcp = createMcpHttp(db, { env: {}, log: () => {} });
  expect(await listedToolNames(mcp)).toContain("msot_resolve");
  const result = await mcp.fetch(
    post("tools/call", { name: "msot_resolve", arguments: input }),
  );
  const rpc = (await result.json()) as {
    result: {
      isError?: boolean;
      structuredContent: { data: unknown; provenance: unknown[] };
    };
  };
  expect(rpc.result.isError).not.toBe(true);
  expect(rpc.result.structuredContent.data).toEqual(rest);
  expect(rpc.result.structuredContent.provenance).toHaveLength(1);
  for (const body of [
    { ...input, year: "2026" },
    { ...input, as_of: "2026-02-30" },
    { ...input, plan_ids: Array(101).fill("x") },
    { ...input, source_id: "unreadable" },
  ]) {
    const rejected = await app.request("/msot/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(rejected.status).toBe(400);
  }
});
it.each(["api", "worker", "stdio"] as const)(
  "loads additive policy provider on %s and no-source keeps the tool list unchanged",
  async (host) => {
    const noSource = await loadPlugins(config(), host, { env: {} });
    expect(noSource.registries.mcpTools).toEqual([]);
    expect(noSource.registries.routes).toEqual([]);
    expect(noSource.registries.catalogPolicies).toEqual({});
    expect(noSource.migrations, "no_mandatory_policy_migrations").toHaveLength(
      host === "worker" ? 1 : 0,
    );
    const loaded = await loadPlugins(config({ source }), host, {
      env: {},
      canonicalReader: reader,
    });
    expect(loaded.registries.catalogPolicies.msot?.spec.resolve).toBeTypeOf(
      "function",
    );
    expect(loaded.migrations).toHaveLength(1);
  },
);
it("rejects invalid scopes, types, duplicate rules and equal-rank time overlaps", () => {
  for (const scope of [
    { state: null },
    { issuer_id: 123 },
    { market_segment: "both" },
    { state: "" },
    { priority: 1 },
  ])
    expect(
      sourceSchema.safeParse({
        ...source,
        rules: [{ ...source.rules[0], scope }],
      }).success,
    ).toBe(false);
  expect(() =>
    compileSource(
      {
        ...source,
        rules: [
          { ...source.rules[0], value: { state: "known", value: "false" } },
        ],
      },
      reader,
    ),
  ).toThrow();
  const rule = source.rules[0]!;
  expect(() =>
    compileSource(
      { ...source, rules: [rule, { ...rule, id: "overlap" }] },
      reader,
    ),
  ).toThrow("MSOT_EQUAL_RANK_OVERLAP");
  expect(() =>
    compileSource(
      {
        ...source,
        rules: [
          { ...rule, scope: { state: "TX" } },
          {
            ...rule,
            id: "cross-dimension",
            scope: { issuer_id: "issuer-demo-a" },
          },
        ],
      },
      reader,
    ),
  ).toThrow("MSOT_EQUAL_RANK_OVERLAP");
  expect(() =>
    compileSource({ ...source, rules: [rule, rule] }, reader),
  ).toThrow("MSOT_DUPLICATE_RULE");
});
it("pins immutable content, normalizes wildcards, separates channels and respects dates", async () => {
  const raw = structuredClone(source);
  const provider = compileSource(raw, reader);
  raw.rules[0]!.value = { state: "known", value: false };
  const answer = await provider.resolve(input, scope);
  checkExample(answer);
  expect(Object.isFrozen(provider.source.rules[0]!.scope)).toBe(true);
  expect(await provider.resolve(input, scope)).toEqual(answer);
  const dualReader: CanonicalReader = {
    plans: async () => ({
      catalog_generation: "synthetic-generation",
      plans: [{ ...plans[0]!, on_exchange: true }],
    }),
  };
  const dual = await compileSource(source, dualReader).resolve(
    { ...input, plan_ids: ["plan-demo-a"] },
    scope,
  );
  expect(
    Object.keys(dual.plans[0]!.msot.by_market_segment),
    "dual_channels_separate",
  ).toEqual(["on_exchange", "off_exchange"]);
  expect(field(dual, 0, "on_exchange").value).toBe(null);
  expect(field(dual, 0, "off_exchange").value).toBe(true);
  const early = await provider.resolve(
    { ...input, as_of: "2026-11-14" },
    scope,
  );
  expect(field(early, 0, "off_exchange").value).toBe(null);
  const unknownReader: CanonicalReader = {
    plans: async () => ({
      catalog_generation: "synthetic-generation",
      plans: [{ ...plans[0]!, on_exchange: null, off_exchange: null }],
    }),
  };
  const unknown = await compileSource(source, unknownReader).resolve(
    input,
    scope,
  );
  expect(field(unknown, 0, "unknown").state).toBe("unknown");
  const unresolved = unknown.msot.provenance.find(
    (p) => p.id === field(unknown, 0, "unknown").provenance_ref,
  )!;
  expect(unresolved.matched_scope).toBe(null);
  expect(unresolved.unresolved_dimensions).toContain("market_segment");
  expect(unresolved.candidate_rule_ids).toEqual(["payment-tx-off"]);
  const unknownSelected = await compileSource(source, unknownReader).resolve(
    { ...input, market_segment: "off_exchange" },
    scope,
  );
  expect(field(unknownSelected, 0, "off_exchange").state).toBe("unknown");
  expect(
    unknownSelected.plans[0]!.msot.by_market_segment.off_exchange!
      .applicability,
  ).toBe("unknown");
  const inapplicable = await provider.resolve(
    { ...input, market_segment: "on_exchange" },
    scope,
  );
  expect(
    inapplicable.plans[0]!.msot.by_market_segment.on_exchange!.applicability,
  ).toBe("inapplicable");
});

describe("named negative controls in temporary source copies", () => {
  const mutations = [
    [
      "missing_flag_remains_unknown",
      "const value = rule && !missing ? rule.value : definition.default;",
      "const value = rule && !missing ? rule.value : { state: 'known' as const, value: false };",
    ],
    [
      "other_issuer_remains_unknown",
      "issuer_id: plan.issuer_id",
      "issuer_id: 'issuer-demo-a'",
    ],
    [
      "actor_scope_provenance_required",
      "set_by: selected?.set_by ?? definition.set_by",
      "set_by: undefined",
    ],
    [
      "actor_scope_provenance_required",
      "matched_scope: selected?.scope ?? null",
      "matched_scope: null",
    ],
  ];
  it.each(mutations)("rejects %s", async (name, before, after) => {
    const mutant = await plantMutant(
      new URL("../src/resolver.ts", import.meta.url),
      before!,
      after!,
    );
    try {
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(mutant.path).href
      )) as { compileSource: typeof compileSource };
      const answer = await module
        .compileSource(source, reader)
        .resolve(input, scope);
      expect(() => checkExample(answer)).toThrow(name);
    } finally {
      await mutant.cleanup();
    }
  });
  it("rejects dual_channels_separate", async () => {
    const mutant = await plantMutant(
      new URL("../src/resolver.ts", import.meta.url),
      "channels[segment as keyof typeof channels]",
      "channels['off_exchange']",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(mutant.path).href
      )) as { compileSource: typeof compileSource };
      const dualReader: CanonicalReader = {
        plans: async () => ({
          catalog_generation: "synthetic-generation",
          plans: [{ ...plans[0]!, on_exchange: true }],
        }),
      };
      const answer = await module
        .compileSource(source, dualReader)
        .resolve(input, scope);
      expect(() =>
        expect(
          Object.keys(answer.plans[0]!.msot.by_market_segment),
          "dual_channels_separate",
        ).toEqual(["on_exchange", "off_exchange"]),
      ).toThrow("dual_channels_separate");
    } finally {
      await mutant.cleanup();
    }
  });
  it("rejects tool_requires_configured_source", async () => {
    const mutant = await plantMutant(
      new URL("../src/index.ts", import.meta.url),
      "if (!source && !readableSources.length) return;",
      `if (!source) { ctx.mcpTools.add({ name: "msot_resolve", title: "Synthetic mutant", description: "Synthetic mutant", inputSchema: resolveInput, outputSchema: mcpOutput, readOnly: true, handler: async () => { throw new Error("unused"); } }); return; }`,
    );
    try {
      const loaded = await loadPlugins(
        loadConfig({}, { version: 1, plugins: [{ package: mutant.path }] }),
        "api",
        { env: {} },
      );
      expect(() =>
        expect(
          loaded.registries.mcpTools,
          "tool_requires_configured_source",
        ).toHaveLength(0),
      ).toThrow("tool_requires_configured_source");
    } finally {
      await mutant.cleanup();
    }
  });
});

it("reads a public catalog through the production canonical reader without changing catalog answers", async () => {
  const { digestFixture } = await import("../../../tests/plugins/fixture.js");
  const fixture = await digestFixture();
  try {
    const { rows } = await fixture.db.query<{
      base_plan_id: string;
      issuer_id: string;
      state: string;
    }>(
      "SELECT base_plan_id,issuer_id,state FROM plan WHERE off_exchange IS TRUE ORDER BY base_plan_id LIMIT 1",
    );
    const plan = rows[0]!;
    expect(plan).toBeDefined();
    const inline = structuredClone(source);
    inline.rules[0]!.scope = {
      issuer_id: plan.issuer_id,
      state: plan.state,
      market_segment: "off_exchange",
    };
    const original = createApp(fixture.db);
    const path = `/v1/plans/${plan.base_plan_id}?year=2026`;
    const before = await (await original.request(path)).text();
    const loaded = await loadPlugins(config({ source: inline }), "api", {
      env: {},
    });
    const app = createApp(fixture.db, undefined, {
      plugins: loaded.registries,
    });
    const response = await app.request("/msot/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        plan_ids: [plan.base_plan_id],
        market_segment: "off_exchange",
      }),
    });
    expect(response.status).toBe(200);
    const answer = resolveOutput.parse(await response.json());
    expect(field(answer, 0, "off_exchange").value).toBe(true);
    expect(answer.plans[0]!.public.issuer_id).toBe(plan.issuer_id);
    expect(answer.msot.catalog_generation).toMatch(/^[a-f0-9]{32}$/);
    expect(await (await app.request(path)).text()).toBe(before);
    expect(
      (
        await fixture.db.query(
          "SELECT tablename FROM pg_tables WHERE tablename LIKE 'plg_msot_%'",
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it("normalizes wildcard scopes and preserves explicit false, unknown masking and half-open dates", async () => {
  const wildcard = structuredClone(source);
  wildcard.rules[0]!.scope.issuer_id = "*";
  const normalized = compileSource(wildcard, reader);
  const omitted = structuredClone(wildcard);
  delete omitted.rules[0]!.scope.issuer_id;
  expect(normalized.source.rules[0]!.scope).not.toHaveProperty("issuer_id");
  expect(normalized.hash).toBe(compileSource(omitted, reader).hash);
  const broad = {
    ...source.rules[0]!,
    id: "broad-false",
    scope: {},
    value: { state: "known" as const, value: false },
  };
  const masked = compileSource(
    {
      ...source,
      rules: [
        broad,
        {
          ...source.rules[0]!,
          scope: { state: "TX" },
          value: { state: "unknown", value: null },
        },
      ],
    },
    reader,
  );
  expect(
    field(
      await compileSource({ ...source, rules: [broad] }, reader).resolve(
        input,
        scope,
      ),
      0,
      "off_exchange",
    ).value,
  ).toBe(false);
  expect(
    field(await masked.resolve(input, scope), 0, "off_exchange").state,
  ).toBe("unknown");
  const dated = { ...source.rules[0]!, valid_until: "2026-11-16" };
  expect(
    field(
      await compileSource({ ...source, rules: [dated] }, reader).resolve(
        { ...input, as_of: "2026-11-16" },
        scope,
      ),
      0,
      "off_exchange",
    ).state,
  ).toBe("unknown");
  expect(() =>
    compileSource(
      {
        ...source,
        rules: [
          dated,
          {
            ...dated,
            id: "next-window",
            valid_from: "2026-11-16",
            valid_until: null,
          },
        ],
      },
      reader,
    ),
  ).not.toThrow();
});

it("keeps actual API schema readiness unchanged without a source and refuses configured missing state", async () => {
  const { digestFixture } = await import("../../../tests/plugins/fixture.js");
  const { coreMigrations } = await import("../../../tests/pglite.js");
  const { schemaGate } = await import("../../../src/api/schema-gate.js");
  const fixture = await digestFixture();
  const core = await coreMigrations();
  try {
    let baseline: { status: number; body: string } | undefined;
    for (const mode of ["absent", "disabled", "no-source"] as const) {
      const configured =
        mode === "absent"
          ? loadConfig({}, { version: 1 })
          : config(undefined, mode !== "disabled");
      const loaded = await loadPlugins(configured, "api", { env: {} });
      const readiness = schemaGate(fixture.db, {
        directory: core.directory,
        plugins: loaded.migrations,
      });
      expect((await readiness.status()).state, `off_mode_ready:${mode}`).toBe(
        "ready",
      );
      const app = createApp(
        fixture.db,
        undefined,
        { plugins: loaded.registries },
        readiness,
      );
      const response = await app.request("/v1/data-availability");
      const actual = { status: response.status, body: await response.text() };
      baseline ??= actual;
      expect(actual, `off_mode_bytes:${mode}`).toEqual(baseline);
    }
    const active = await loadPlugins(
      config({ readableSources: [source.source_id] }),
      "api",
      { env: {} },
    );
    const missing = schemaGate(fixture.db, {
      directory: core.directory,
      plugins: active.migrations,
    });
    expect(
      (await missing.status()).state,
      "configured_missing_state_refuses",
    ).toBe("pending");
    const app = createApp(
      fixture.db,
      undefined,
      { plugins: active.registries },
      missing,
    );
    expect((await app.request("/v1/data-availability")).status).toBe(503);
  } finally {
    await fixture.close();
    await core.cleanup();
  }
});
