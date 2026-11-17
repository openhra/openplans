import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type {
  CatalogPolicyInput,
  CatalogPolicyResolution,
  CanonicalReader,
  McpToolContext,
  OperatorHost,
  PluginRouteEnv,
} from "@openplans/plugin-sdk";
import {
  source,
  reader,
  input,
  scope,
} from "../../../../msot/tests/fixtures.js";
import { compileSource } from "../../../../msot/src/resolver.js";
import type { AdminPageDependencies } from "../../../src/contracts.js";
import {
  inspectPage,
  registerInspect,
} from "../../../src/customizations/inspect.js";

const resolution: CatalogPolicyResolution = {
  msot: {
    source_id: "synthetic-source",
    version: 3,
    version_hash: "synthetic-hash",
    as_of: "2026-11-15",
    catalog_generation: "synthetic-generation",
    evaluator_version: 1,
    dimension_schema_version: 1,
    provenance: [
      {
        id: "prov-unknown",
        origin: "msot_default",
        source_id: "synthetic-source",
        version: 3,
        definition: "custom_payment_allowed",
        rule_id: null,
        matched_scope: null,
        set_by: "synthetic-operator",
        set_at: "2026-11-15T12:00:00Z",
        valid_from: null,
        valid_until: null,
        reason_code: "no_matching_rule",
      },
    ],
  },
  plans: [
    {
      id: "synthetic-plan",
      public: {
        id: "synthetic-plan",
        base_plan_id: "synthetic-plan",
        plan_year: 2026,
        issuer_id: "synthetic-issuer",
        state: "TX",
        product_family: "medical",
        business_market: "individual",
        on_exchange: true,
        off_exchange: true,
        provenance: {
          snapshot_id: "synthetic-snapshot",
          source_row: 7,
          channel_granularity: "base_plan",
        },
      },
      msot: {
        by_market_segment: {
          on_exchange: {
            applicability: "applicable",
            fields: {
              custom_payment_allowed: {
                state: "unknown",
                value: null,
                origin: "msot_default",
                provenance_ref: "prov-unknown",
                public: { state: "not_defined", value: null },
              },
            },
          },
          off_exchange: {
            applicability: "unknown",
            fields: {
              custom_payment_allowed: {
                state: "unknown",
                value: null,
                origin: "msot_default",
                provenance_ref: "prov-unknown",
                public: { state: "not_defined", value: null },
              },
            },
          },
        },
      },
    },
  ],
};

function setup(withProvider = true) {
  const inspect = vi.fn(
    async (_input: CatalogPolicyInput, _scope: McpToolContext) => ({
      state: "available" as const,
      observedAt: "2026-11-15T12:00:00.000Z",
      value: resolution,
    }),
  );
  const routes: Parameters<AdminPageDependencies["routes"]["add"]>[0][] = [];
  const dependencies = {
    routes: { add: (route: (typeof routes)[number]) => routes.push(route) },
    operator: withProvider
      ? ({ msot: { inspect } } as unknown as OperatorHost)
      : undefined,
    status: {},
    now: () => new Date("2026-11-15T12:00:00.000Z"),
  } satisfies AdminPageDependencies;
  registerInspect(dependencies);
  const route = routes[0]!;
  const app = new Hono<PluginRouteEnv>();
  app.use("*", (c, next) => {
    c.set("pluginDb", {} as never);
    c.set("pluginSignal", new AbortController().signal);
    return next();
  });
  app.post(route.path, route.handler);
  return { app, inspect };
}

const requestBody = {
  field: "custom_payment_allowed",
  source_id: "synthetic-source",
  plan_ids: ["synthetic-plan"],
  year: 2026,
  as_of: "2026-11-15",
};

it("calls the host facade and preserves both channels, unknown state, explanation, and public evidence", async () => {
  const service = setup();
  const response = await service.app.request("/admin/customizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const body = JSON.parse(await response.text()) as {
    value: CatalogPolicyResolution;
  };
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(service.inspect).toHaveBeenCalledTimes(1);
  expect(service.inspect.mock.calls[0]?.[0]).toEqual({
    source_id: "synthetic-source",
    plan_ids: ["synthetic-plan"],
    year: 2026,
    as_of: "2026-11-15",
  });
  expect(service.inspect.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  const plan = body.value.plans[0]!;
  const onExchange = plan.msot.by_market_segment.on_exchange!;
  const offExchange = plan.msot.by_market_segment.off_exchange!;
  expect(onExchange.fields.custom_payment_allowed!.state).toBe("unknown");
  expect(offExchange.fields.custom_payment_allowed!.state).toBe("unknown");
  expect(body.value.msot.provenance[0]!.reason_code).toBe("no_matching_rule");
  expect(plan.public.provenance.snapshot_id).toBe("synthetic-snapshot");
  expect(JSON.stringify(body)).not.toContain('"market":');
});

it("returns the configured MSoT resolver answer unchanged through the host facade", async () => {
  const service = setup();
  const dualChannelReader: CanonicalReader = {
    plans: async (request, requestScope) => {
      const batch = await reader.plans(request, requestScope);
      return {
        ...batch,
        plans: batch.plans.map((plan) =>
          plan.id === "plan-demo-a"
            ? { ...plan, on_exchange: true, off_exchange: true }
            : plan,
        ),
      };
    },
  };
  const provider = compileSource(source, dualChannelReader);
  service.inspect.mockImplementation(async (request, requestScope) => ({
    state: "available",
    observedAt: "2026-11-15T12:00:00.000Z",
    value: await provider.resolve(request, requestScope),
  }));
  const expected = await provider.resolve(input, scope);
  const response = await service.app.request("/admin/customizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field: "custom_payment_allowed", ...input }),
  });
  const actual = JSON.parse(await response.text()) as {
    value: CatalogPolicyResolution;
  };
  expect(response.status).toBe(200);
  expect(actual.value).toEqual(expected);
  const tx = actual.value.plans.find((plan) => plan.id === "plan-demo-a")!;
  expect(
    tx.msot.by_market_segment.off_exchange?.fields.custom_payment_allowed
      ?.state,
  ).toBe("known");
  expect(
    tx.msot.by_market_segment.on_exchange?.fields.custom_payment_allowed?.state,
  ).toBe("unknown");
});

it("rejects unsupported fields, market aliases, oversized previews, and oversized bodies before provider calls", async () => {
  const service = setup();
  for (const bad of [
    { ...requestBody, field: "premium" },
    { ...requestBody, market: "off_exchange" },
    {
      ...requestBody,
      plan_ids: Array.from({ length: 26 }, (_, i) => `plan-${i}`),
    },
  ]) {
    const response = await service.app.request(
      "/admin/customizations/inspect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad),
      },
    );
    expect(response.status).toBe(400);
  }
  const tooLarge = await service.app.request("/admin/customizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: " ".repeat(16 * 1024 + 1),
  });
  expect(tooLarge.status).toBe(413);
  expect(service.inspect).not.toHaveBeenCalled();
});

it("shows unavailable without a provider and renders a no-JavaScript inspection form", async () => {
  const service = setup(false);
  const response = await service.app.request("/admin/customizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    state: "unavailable",
    reason: "not_supported",
  });

  const dependencies = {
    routes: { add: vi.fn() },
    operator: { msot: { inspect: vi.fn() } } as unknown as OperatorHost,
    status: {},
    now: () => new Date("2026-11-15T12:00:00.000Z"),
  } satisfies AdminPageDependencies;
  const page = inspectPage(dependencies);
  const app = new Hono<PluginRouteEnv>();
  app.get("/admin/customizations", page);
  const html = await (await app.request("/admin/customizations")).text();
  expect(html).toContain(
    'method="post" action="/admin/customizations/inspect"',
  );
  expect(html).toContain("one plan ID per line");
  expect(html).not.toContain("<script");
});
