import { loadPlugins } from "../../../tests/plugins/approval-helpers.js";
import { expect, it } from "vitest";
import { compileSource } from "../src/resolver.js";
import { sourceSchema } from "../src/schema.js";
import { source, reader, input, scope, marketSource } from "./fixtures.js";

it("uses the same field resolver for payment and marketable with independent provenance", async () => {
  const compiled = compileSource(marketSource(), reader);
  const result = await compiled.resolve(input, scope);
  const fields = result.plans[0]!.msot.by_market_segment.off_exchange!.fields;
  expect(fields.marketable.value).toBe(true);
  expect(fields.custom_payment_allowed.value).toBe(true);
  expect(fields.marketable.provenance_ref).not.toBe(
    fields.custom_payment_allowed.provenance_ref,
  );
  expect(
    result.msot.provenance.find(
      (p) => p.id === fields.marketable.provenance_ref,
    ),
  ).toMatchObject({
    rule_id: "offer",
    definition: "marketable@1",
    set_by: "operator-demo",
    matched_scope: source.rules[0]!.scope,
  });
  expect(
    result.plans[1]!.msot.by_market_segment.on_exchange!.fields.marketable,
  ).toMatchObject({ state: "unknown", value: null });
  expect(await compiled.resolve(input, scope)).toEqual(result);
});
it("keeps false, explicit unknown, and missing decisions distinct", async () => {
  for (const value of [
    { state: "known", value: false },
    { state: "unknown", value: null },
  ] as const) {
    const source = marketSource();
    source.rules[1]!.value = value;
    const result = await compileSource(source, reader).resolve(input, scope);
    expect(
      result.plans[0]!.msot.by_market_segment.off_exchange!.fields.marketable,
    ).toMatchObject(value);
    expect(
      result.msot.provenance.find((p) => p.rule_id === "offer")?.origin,
    ).toBe("msot");
  }
});
it("rejects a known marketable default, hidden filtering and same-field ties", () => {
  const source = marketSource();
  const definition = source.fields[1]!;
  for (const change of [
    { default: { state: "known", value: false } },
    { filterable: false },
    { visibility: { ...definition.visibility, compat: false } },
  ])
    expect(
      sourceSchema.safeParse({
        ...source,
        fields: [source.fields[0], { ...definition, ...change }],
      }).success,
    ).toBe(false);
  expect(() =>
    compileSource(
      {
        ...source,
        rules: [...source.rules, { ...source.rules[1], id: "tie" }],
      },
      reader,
    ),
  ).toThrow("msot_equal_rank_overlap");
  expect(() =>
    compileSource(
      { ...source, fields: [definition], rules: source.rules },
      reader,
    ),
  ).toThrow("msot_field_undefined");
});
it("retains hashes for payment-only sources and supplies an unknown built-in decision", async () => {
  const compiled = compileSource(source, reader);
  expect(compiled.source.fields).toHaveLength(1);
  expect(compiled.hash).toBe(
    "1711b4a58ae50b2fa6ce30905f1dbc458900da12b10bc3998b9dceb15ae7cc1d",
  );
  const result = await compiled.resolve(input, scope);
  expect(result.msot.version_hash).toBe(compiled.hash);
  expect(
    result.plans[0]!.msot.by_market_segment.off_exchange!.fields.marketable,
  ).toMatchObject({ state: "unknown", value: null });
  expect(
    result.msot.field_definitions.find((f) => f.name === "marketable"),
  ).toMatchObject({ filterable: true });
});

it("returns both ordinary fields and their provenance through REST and MCP preview", async () => {
  const { loadConfig } = await import("../../../src/config/index.js");
  const { createApp } = await import("../../../src/api/app.js");
  const { createMcpHttp } = await import("../../../src/mcp/http.js");
  const { post } = await import("../../../tests/mcp/transport-helpers.js");
  const { resolveOutput } = await import("../src/schema.js");
  const loaded = await loadPlugins(
    loadConfig(
      {},
      {
        version: 1,
        plugins: {
          entries: [
            {
              package: "@openplans/plugin-msot",
              options: { source: marketSource() },
            },
          ],
        },
      },
    ),
    "api",
    { env: {}, canonicalReader: reader },
  );
  try {
    const response = await createApp(
      scope.db,
      {},
      { plugins: loaded.registries },
    ).request("/msot/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const rest = resolveOutput.parse(await response.json());
    expect(
      rest.plans[0]!.msot.by_market_segment.off_exchange!.fields.marketable
        .value,
    ).toBe(true);
    const mcp = createMcpHttp(scope.db, { env: {}, log: () => {} });
    const rpc = (await (
      await mcp.fetch(
        post("tools/call", { name: "msot_resolve", arguments: input }),
      )
    ).json()) as {
      result: { isError?: boolean; structuredContent: { data: unknown } };
    };
    expect(rpc.result.isError).not.toBe(true);
    expect(resolveOutput.parse(rpc.result.structuredContent.data)).toEqual(
      rest,
    );
  } finally {
    await loadPlugins(loadConfig({}, { version: 1 }), "api", { env: {} });
  }
});
