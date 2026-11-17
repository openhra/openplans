import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { loadConfig } from "../../../src/config/index.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { createMcpHttp } from "../../../src/mcp/http.js";
import { toolNames } from "../../../src/mcp/schemas.js";
import { post } from "../../../tests/mcp/transport-helpers.js";
import { FIXED_TIME } from "../../../tests/plugins/fixture.js";
import { setup } from "../../../tests/compat/v1/helpers.js";
import type { SqlSession } from "../../../src/db/database.js";
import { marketOutput } from "../src/service.js";
import { marketForm } from "../src/visitor.js";
import { withMutantFile, importMutant } from "../../../tests/mutant-file.js";
import type { OpenPlansPlugin, RouteSpec } from "@openplans/plugin-sdk";

// Recorded bodies include the algorithm identity of the captured release, like FIXED_TIME.
// Keep captured bytes stable across release-version changes without recording new digests.
vi.mock("../../../src/mcp/version.js", () => ({
  applicationVersion: "0.4.11",
}));

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof Crypto>();
  let sequence = 0;
  return {
    ...crypto,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
});

const ageInput = { zip: "77002", county: "48201", year: 2026, age: 40 };
const householdInput = {
  zip: "77002",
  county: "48201",
  year: 2026,
  members: [
    { age: 40, relationship: "subscriber" },
    { age: 40, relationship: "spouse" },
    { age: 10, relationship: "child" },
    { age: 8, relationship: "child" },
  ],
};
const settings = (enabled = true, privateIngress = false, tpaEnabled = false) =>
  loadConfig(
    {},
    {
      version: 1,
      public: { quoting: true },
      tpa: { enabled: tpaEnabled, privateIngress },
      plugins: [{ package: "@openplans/plugin-compare", enabled }],
    },
  );
const query = (input: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ]),
  );
const marketPath = (input: Record<string, unknown>) =>
  `/compare/v1/market?${query(input)}`;
let fixture: Awaited<ReturnType<typeof setup>>;
async function app(db: SqlSession = fixture.db) {
  const loaded = await loadPlugins(settings(), "api", { env: {} });
  return createApp(db, undefined, {
    plugins: loaded.registries,
    config: settings(),
  });
}
async function printed(server: ReturnType<typeof createApp>, input: unknown) {
  return server.request("/compare/v1/print", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
interface RpcBody {
  error?: unknown;
  result: {
    isError?: boolean;
    structuredContent?: unknown;
    tools: { name: string }[];
    nextCursor?: string;
  };
}
async function rpc(input: Record<string, unknown>): Promise<RpcBody> {
  const server = createMcpHttp(fixture.db, { env: {}, log: () => {} });
  const response = await server.fetch(
    post("tools/call", { name: "compare_market_costs", arguments: input }),
  );
  return (await response.json()) as RpcBody;
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("SYNTHETIC public comparator rollback");
  await expect(
    fixture.db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  fixture = await setup({ fixedTime: FIXED_TIME });
});
afterEach(async () => {
  await loadPlugins(loadConfig({}, { version: 1, plugins: [] }), "api", {
    env: {},
  });
});
afterAll(async () => {
  await fixture?.close();
  vi.useRealTimers();
});

it("registers exactly three public routes and one tool, with either TPA gate off", async () => {
  for (const [tpaEnabled, privateIngress] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    const loaded = await loadPlugins(
      settings(true, privateIngress, tpaEnabled),
      "api",
      {
        env: {},
      },
    );
    expect(
      loaded.registries.routes.map(({ spec }) => [
        spec.method,
        spec.path,
        spec.exposure,
      ]),
    ).toEqual([
      ["GET", "/compare/v1", "public"],
      ["GET", "/compare/v1/market", "public"],
      ["POST", "/compare/v1/print", "public"],
    ]);
    expect(loaded.registries.mcpTools.map(({ spec }) => spec.name)).toEqual([
      "compare_market_costs",
    ]);
    for (const { spec } of loaded.registries.routes)
      expect(spec.rateLimit).toEqual({
        perMinute: 30,
        activePerSource: 2,
        activeTotal: 4,
      });
    const server = createApp(fixture.db, undefined, {
      plugins: loaded.registries,
      config: settings(),
    });
    for (const path of [
      "/compare/v1/employer",
      "/compare/v1/employer-print",
      "/compare/v1/group",
      "/v1/ichra/affordability/batch",
    ])
      for (const authorization of [undefined, "Bearer synthetic-operator"])
        expect(
          (
            await server.request(path, {
              method: "POST",
              headers: authorization ? { authorization } : {},
            })
          ).status,
        ).toBe(404);
    const mcp = createMcpHttp(fixture.db, { env: {}, log: () => {} });
    const response = await mcp.fetch(post("tools/list"));
    const body = (await response.json()) as RpcBody;
    expect(
      body.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([...toolNames, "compare_market_costs"]);
    expect(body.result.nextCursor).toBeUndefined();
  }
  const defaults = loadConfig({}, { version: 1 });
  expect(defaults.plugins).toEqual([]);
  expect(defaults.tpa).toEqual({ enabled: false, privateIngress: false });
  const off = await loadPlugins(settings(false), "api", { env: {} });
  const server = createApp(fixture.db, undefined, {
    plugins: off.registries,
    config: settings(false),
  });
  expect((await server.request("/compare/v1")).status).toBe(404);
});

it("admits browser age and household forms and preserves the canonical print answer", async () => {
  const server = await app();
  const page = await server.request("/compare/v1");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  const html = await page.text();
  expect(html).toContain('action="/compare/v1/print"');
  expect(html).toContain('name="age_10"');
  expect(html).toContain("Group costs: unavailable from public evidence");
  expect(html).not.toContain("<script");
  const householdForm = {
    zip: "77002",
    county: "48201",
    year: "2026",
    metal: "silver",
    ...Object.fromEntries(
      householdInput.members.flatMap((member, index) => [
        [`age_${index + 1}`, String(member.age)],
        [`relationship_${index + 1}`, member.relationship],
      ]),
    ),
  };
  for (const [input, form] of [
    [ageInput, Object.fromEntries(query(ageInput))],
    [householdInput, householdForm],
  ] as const) {
    const answer = marketOutput.parse(
      await (await server.request(marketPath(input))).json(),
    );
    const result = await rpc(input);
    expect(result.error).toBeUndefined();
    expect(result.result.isError).not.toBe(true);
    expect(result.result.structuredContent).toEqual(answer);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    const json = await printed(server, input);
    const browser = await server.request("/compare/v1/print", {
      method: "POST",
      body: new URLSearchParams(form),
    });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("cache-control")).toBe("no-store");
    const sheet = await browser.text();
    expect(sheet).toBe(await json.text());
    expect(sheet).toContain("2026-01-01");
    expect(sheet).toContain("Inspect JSON evidence");
    expect(sheet).toContain("Statistics use the entire cohort");
  }
  expect(() =>
    marketForm({ ...householdForm, year: ["2026", "2027"] }),
  ).toThrow("INVALID_INPUT");
  expect(() => marketForm({ ...householdForm, age: "40" })).toThrow();
});

it("refuses planted employer, renewal, contribution and census fields on REST, print, form and MCP", async () => {
  const server = await app();
  for (const [key, value] of Object.entries({
    group_quote: { source: "SYNTHETIC employer input" },
    group_renewal: { monthly_cents: 1 },
    employer_contribution: 1,
    contribution: { basis_points: 7500 },
    census: [{ age: 40 }],
    employees: [{ row: 1 }],
  })) {
    const planted = { ...ageInput, [key]: value };
    expect((await server.request(`/compare/v1?${query(planted)}`)).status).toBe(
      400,
    );
    const response = await server.request(marketPath(planted));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await printed(server, planted)).status).toBe(400);
    expect(
      (
        await server.request("/compare/v1/print", {
          method: "POST",
          body: query(planted),
        })
      ).status,
    ).toBe(400);
    const result = await rpc(planted);
    expect(Boolean(result.error || result.result?.isError)).toBe(true);
  }
});

it("pins both kinds of evidence to generation and manifest and refuses changed or missing pins", async () => {
  for (const input of [ageInput, householdInput]) {
    const server = await app();
    const first = marketOutput.parse(
      await (await server.request(marketPath(input))).json(),
    );
    expect(first.data.comparison.status).toBe("calculated");
    expect(first.data.comparison.evidence.next_page).toBe(2);
    const pin = {
      ...input,
      evidence_page: 2,
      data_generation: first.data_generation,
    };
    const second = marketOutput.parse(
      await (await server.request(marketPath(pin))).json(),
    );
    expect(second.data.comparison.statistics).toEqual(
      first.data.comparison.statistics,
    );
    for (const data_generation of [
      "stale",
      first.data_generation.split(":")[0]!,
    ]) {
      expect(
        (await server.request(marketPath({ ...pin, data_generation }))).status,
      ).toBe(503);
      expect((await printed(server, { ...pin, data_generation })).status).toBe(
        503,
      );
      const result = await rpc({ ...pin, data_generation });
      expect(Boolean(result.error || result.result?.isError)).toBe(true);
    }
    expect(
      (await server.request(marketPath({ ...input, evidence_page: 2 }))).status,
    ).toBe(400);
    await rollback(async (tx) => {
      await tx.exec(
        "UPDATE rate SET individual_rate_cents=individual_rate_cents",
      );
      const changed = await app(tx);
      const response = await changed.request(marketPath(pin));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "generation_changed" },
      });
    });
  }
});

it("keeps an unpriced offer unknown for both age and household instead of publishing a cheaper-looking cohort", async () => {
  for (const input of [ageInput, householdInput]) {
    const server = await app();
    const complete = marketOutput.parse(
      await (await server.request(marketPath(input))).json(),
    ).data.comparison;
    const id = complete.evidence.candidates[0]!.plan_id;
    await rollback(async (tx) => {
      await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [id]);
      const changed = await app(tx);
      const answer = marketOutput.parse(
        await (await changed.request(marketPath(input))).json(),
      );
      expect(answer.data.comparison).toMatchObject({
        status: "unknown",
        statistics: null,
        denominator: {
          candidate_count: complete.denominator.candidate_count,
          unknown_count: 1,
        },
      });
      expect(await (await printed(changed, input)).text()).toContain("Unknown");
    });
  }
});

it("kills a planted TPA bypass with the exact public route inventory", async () => {
  const file = new URL("../src/index.ts", import.meta.url);
  const source = await readFile(file, "utf8");
  const guard = "ctx.config.tpa?.enabled && ctx.config.tpa.privateIngress";
  expect(source).toContain(guard);
  await withMutantFile(file, source.replace(guard, "true"), async (url) => {
    const module = await importMutant<{ default: OpenPlansPlugin }>(url);
    const routes: RouteSpec[] = [];
    module.default.setup({
      config: settings(),
      calculationHost: {},
      routes: { add: (spec: RouteSpec) => routes.push(spec) },
      mcpTools: { add: () => {} },
    } as unknown as Parameters<OpenPlansPlugin["setup"]>[0]);
    expect(() =>
      expect(routes.every((route) => route.exposure === "public")).toBe(true),
    ).toThrow();
  });
});

it("matches separate recorded public-on HTTP and MCP bytes", async () => {
  const server = await app();
  const mcp = createMcpHttp(fixture.db, { env: {}, log: () => {} });
  const responses = {
    visitor: await server.request("/compare/v1"),
    age: await server.request(marketPath(ageInput)),
    household: await server.request(marketPath(householdInput)),
    age_print: await printed(server, ageInput),
    household_print: await printed(server, householdInput),
    tools: await mcp.fetch(post("tools/list")),
    age_mcp: await mcp.fetch(
      post("tools/call", { name: "compare_market_costs", arguments: ageInput }),
    ),
    household_mcp: await mcp.fetch(
      post("tools/call", {
        name: "compare_market_costs",
        arguments: householdInput,
      }),
    ),
  };
  const actual = Object.fromEntries(
    await Promise.all(
      Object.entries(responses).map(
        async ([name, response]) =>
          [
            name,
            {
              status: response.status,
              body_sha256: createHash("sha256")
                .update(Buffer.from(await response.arrayBuffer()))
                .digest("hex"),
              headers: Object.fromEntries(
                [
                  "content-type",
                  "cache-control",
                  "content-security-policy",
                ].map((key) => [key, response.headers.get(key)]),
              ),
            },
          ] as const,
      ),
    ),
  );
  const file = new URL(
    "../../../tests/fixtures/plugins/response-digests-compare-on.json",
    import.meta.url,
  );
  if (process.env.OPENPLANS_RECORD_COMPARE_DIGESTS === "1")
    await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`);
  else expect(actual).toEqual(JSON.parse(await readFile(file, "utf8")));
});
