import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import { setup } from "../../../tests/compat/v1/helpers.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { createCalculationHost } from "../../../src/plugins/calculation-host.js";
import { loadConfig } from "../../../src/config/index.js";
import { createApp } from "../../../src/api/app.js";
import { connect } from "../../../tests/mcp/client.js";
import { marketOutput } from "../src/service.js";
import { printMarket } from "../src/print.js";
import { marketInput } from "../src/input.js";
import { writeFile } from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  replaceSyntax,
  rebaseImports,
} from "../../../tests/source-mutation.js";
import type { CalculationHost } from "@openplans/plugin-sdk";

let h: Awaited<ReturnType<typeof setup>>;
const input = { zip: "77002", county: "48201", year: 2026, age: 40 };
const packagePath = new URL("../dist/index.js", import.meta.url).pathname;
const config = (enabled = true, quoting = true, tpa = false) =>
  loadConfig(
    {},
    {
      version: 1,
      public: { quoting },
      tpa: { enabled: tpa, privateIngress: tpa },
      plugins: [{ package: packagePath, enabled }],
    },
  );

beforeAll(async () => {
  h = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
});
afterEach(async () => {
  await loadPlugins(loadConfig({}, { version: 1, plugins: [] }), "api", {
    env: {},
  });
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.close();
});

it("uses one canonical answer for REST, actual MCP calls and print, without retention", async () => {
  const loaded = await loadPlugins(config(), "api", { env: {} });
  const app = createApp(h.db, undefined, { plugins: loaded.registries });
  const response = await app.request(
    "/compare/v1/market?zip=77002&county=48201&year=2026&age=40",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const answer = marketOutput.parse(await response.json());
  expect(answer.data.comparison.status).toBe("calculated");
  const client = await connect({
    db: h.db,
    cursorSecret: "synthetic-compare-secret",
    pluginTools: loaded.registries.mcpTools,
  });
  try {
    expect(
      (await client.client.listTools()).tools.map((tool) => tool.name),
    ).toContain("compare_market_costs");
    const result = await client.client.callTool({
      name: "compare_market_costs",
      arguments: input,
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toEqual(answer);
    expect(Buffer.byteLength(JSON.stringify(result)) + 4096).toBeLessThan(
      64 * 1024,
    );
  } finally {
    await client.close();
  }
  const print = await app.request("/compare/v1/print", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(print.headers.get("cache-control")).toBe("no-store");
  expect(await print.text()).toBe(printMarket(answer));
  const html = printMarket(answer);
  expect(html).toContain("Sources and method");
  expect(html).toContain("Statistics use the entire cohort");
  expect(html).toContain("@page");
  const oldApp = createApp(h.db);
  const path = "/v1/plans?zip=77002&county=48201&year=2026";
  expect(await (await app.request(path)).text()).toBe(
    await (await oldApp.request(path)).text(),
  );
});

it("keeps metal groups separate and prices each household on the same plans", async () => {
  const loaded = await loadPlugins(config(), "api", { env: {} });
  const app = createApp(h.db, undefined, { plugins: loaded.registries });
  const gold = await app.request(
    "/compare/v1/market?zip=77002&county=48201&year=2026&age=40&metal=gold",
  );
  expect(gold.status).toBe(200);
  const goldAnswer = marketOutput.parse(await gold.json()).data.comparison;
  expect(goldAnswer.basis.metal).toBe("gold");
  const householdInput = {
    zip: "77002",
    county: "48201",
    year: 2026,
    metal: "silver",
    members: [
      { age: 40, relationship: "subscriber" },
      { age: 40, relationship: "spouse" },
      { age: 10, relationship: "child" },
      { age: 8, relationship: "child" },
    ],
  };
  const printed = await app.request("/compare/v1/print", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(householdInput),
  });
  expect(printed.status).toBe(200);
  const html = await printed.text();
  expect(html).toContain(
    "subscriber age 40, spouse age 40, child age 10, child age 8",
  );
  expect(html).toContain("Statistics use the entire cohort");
  expect(html).not.toContain("Unknown</td><td>Unknown");
});

it("registers nothing when disabled or public quote access is off; direct host calls also refuse", async () => {
  for (const settings of [config(false), config(true, false)]) {
    const loaded = await loadPlugins(settings, "api", { env: {} });
    expect(loaded.registries.routes).toEqual([]);
    expect(loaded.registries.mcpTools).toEqual([]);
    const app = createApp(h.db, undefined, { plugins: loaded.registries });
    expect(
      (await app.request("/compare/v1/market?zip=77002&year=2026&age=40"))
        .status,
    ).toBe(404);
  }
  await expect(
    createCalculationHost(config(true, false)).enumerateHouseholdOffers(
      offerCohortInputSchema.parse(input),
      { db: h.db, signal: new AbortController().signal },
    ),
  ).rejects.toThrow("QUOTING_DISABLED");
});

it("keeps the private renewal route absent in public mode and operator protected when enabled", async () => {
  const publicPlugin = await loadPlugins(config(), "api", { env: {} });
  const publicRegistrations = JSON.stringify(publicPlugin.registries.routes);
  expect(publicRegistrations).not.toContain("/compare/v1/employer");
  const operatorPlugin = await loadPlugins(config(true, true, true), "api", {
    env: {},
  });
  const operatorRegistrations = JSON.stringify(
    operatorPlugin.registries.routes,
  );
  expect(operatorRegistrations).toContain('"path":"/compare/v1/employer"');
  expect(operatorRegistrations).toContain(
    '"path":"/compare/v1/employer-print"',
  );
  expect(operatorRegistrations.match(/"exposure":"operator"/g)).toHaveLength(2);
  const app = createApp(h.db, undefined, {
    plugins: operatorPlugin.registries,
  });
  expect(
    (await app.request("/compare/v1/employer", { method: "POST" })).status,
  ).toBe(404);
});

it("rejects future inputs and private fields, enforces work budget and cancellation", async () => {
  for (const extra of [
    { members: [{ age: 40 }] },
    { metal: "platinum" },
    { tobacco: true },
    { coverage_start: "2026-02-01" },
    { market: "shop" },
    { carrier_ids: ["99999"] },
    { group_quote: {} },
    { date_of_birth: "1980-01-01" },
  ])
    expect(marketInput.safeParse({ ...input, ...extra }).success).toBe(false);
  for (const metal of ["bronze", "expanded bronze", "silver", "gold"])
    expect(marketInput.safeParse({ ...input, metal }).success).toBe(true);
  expect(
    marketInput.safeParse({
      zip: "77002",
      year: 2026,
      metal: "gold",
      members: [
        { age: 40, relationship: "subscriber" },
        { age: 40, relationship: "spouse" },
        { age: 10, relationship: "child" },
        { age: 8, relationship: "child" },
      ],
    }).success,
  ).toBe(true);
  expect(
    marketInput.safeParse({
      ...input,
      members: [{ age: 40, relationship: "subscriber", tobacco: true }],
    }).success,
  ).toBe(false);
  expect(
    marketInput.safeParse({ zip: "77002", year: 2026, metal: "silver" })
      .success,
  ).toBe(false);
  expect(
    marketInput.safeParse({
      ...input,
      members: [{ age: 40, relationship: "subscriber" }],
    }).success,
  ).toBe(false);
  const host = createCalculationHost(config());
  await expect(
    host.enumerateHouseholdOffers(offerCohortInputSchema.parse(input), {
      db: h.db,
      signal: new AbortController().signal,
      budget: { remainingOffers: 0 },
    }),
  ).rejects.toThrow("work_budget_exceeded");
  await expect(
    host.enumerateHouseholdOffers(offerCohortInputSchema.parse(input), {
      db: h.db,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  const loaded = await loadPlugins(config(), "api", { env: {} });
  const app = createApp(h.db, undefined, { plugins: loaded.registries });
  for (const path of [
    "/compare/v1/market?zip=77002&year=2026&age=40&metal=platinum",
    "/compare/v1/market?zip=77002&year=2026",
    "/compare/v1/market?zip=77002&year=no&age=40",
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

it("escapes source markup and prints unknown amounts explicitly", async () => {
  const host = createCalculationHost(config());
  const cell = await host.enumerateHouseholdOffers(
    offerCohortInputSchema.parse({ ...input, year: 2040 }),
    { db: h.db, signal: new AbortController().signal },
  );
  cell.evidence.unknown.push({ reason: "<script>synthetic</script>" });
  const { marketCosts } = await import("../src/service.js");
  const answer = await marketCosts(
    { enumerateHouseholdOffers: async () => cell },
    offerCohortInputSchema.parse(input),
    { db: h.db, signal: new AbortController().signal },
  );
  const html = printMarket(answer);
  expect(html).toContain("Unknown");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

it("kills disabled_quote_access mutant with the host authorization assertion", async () => {
  const original = new URL(
    "../../../dist/plugins/calculation-host.js",
    import.meta.url,
  );
  const directory = await mkdtemp(
    fileURLToPath(
      new URL("../../../dist/.compare-host-mutant-", import.meta.url),
    ),
  );
  try {
    const source = await readFile(original, "utf8");
    const mutant = replaceSyntax(
      source,
      'if (!config.public.quoting) throw new Error("QUOTING_DISABLED");',
      "void config;",
    );
    const path = join(directory, "host.mjs");
    await writeFile(path, rebaseImports(mutant, original));
    const module = (await import(pathToFileURL(path).href)) as {
      createCalculationHost: (
        value: ReturnType<typeof config>,
      ) => CalculationHost;
    };
    const result = module
      .createCalculationHost(config(true, false))
      .enumerateHouseholdOffers(offerCohortInputSchema.parse(input), {
        db: h.db,
        signal: new AbortController().signal,
      });
    await expect(
      expect(result).rejects.toThrow("QUOTING_DISABLED"),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
