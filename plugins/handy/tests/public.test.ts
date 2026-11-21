import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CalculationHost,
  McpToolSpec,
  PluginContext,
  RouteSpec,
} from "@openplans/plugin-sdk";
import plugin from "../src/index.js";
import type * as allowanceModule from "../src/allowance/service.js";
import { allowanceScenario } from "../src/allowance/service.js";
import {
  allowanceSourceManifest,
  printAllowanceSheet,
} from "../src/allowance/sheet.js";
import { allowanceMcpAnswer } from "../src/allowance/mcp.js";
import { coreConfigView, loadConfig } from "../../../src/config/index.js";
import { createCalculationHost } from "../../../src/plugins/calculation-host.js";
import {
  activateRegistries,
  currentRegistries,
} from "../../../src/plugins/registries.js";
import { createMcpHttp } from "../../../src/mcp/http.js";
import { post as mcpPost } from "../../../tests/mcp/transport-helpers.js";
import { pluginRoutes } from "../../../src/plugins/routes.js";
import {
  callPluginTool,
  pluginToolDefinition,
  toolListBytes,
} from "../../../src/plugins/mcp-tools.js";
import {
  coreToolDefinition,
  MAX_TOOL_LIST_BYTES,
} from "../../../src/mcp/tools.js";
import { toolNames } from "../../../src/mcp/schemas.js";
import { digestFixture, FIXED_TIME } from "../../../tests/plugins/fixture.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";

// Synthetic amounts and source records, used only to exercise transport contracts.
const input = {
  zip: "77002",
  county: "48201",
  year: 2026,
  preset: "family-40-40-10-8-v1" as const,
};
const members = [
  { age: 40, relationship: "subscriber" as const, tobacco: false as const },
  { age: 40, relationship: "spouse" as const, tobacco: false as const },
  { age: 10, relationship: "child" as const, tobacco: false as const },
  { age: 8, relationship: "child" as const, tobacco: false as const },
];
const distribution = {
  status: "calculated",
  data_generation: "synthetic-generation-a",
  location: { zip: "77002", county: "48201" },
  provenance: {
    input_manifest: "synthetic-manifest",
    snapshots: [],
    evidence: [{ status: "unknown", reason: "synthetic_gap" }],
  },
  benchmarks: [
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ].map((profile_id) => ({
    profile_id,
    result: {
      status: "calculated",
      slcsp_monthly_cents: 12345,
      data_generation: "synthetic-generation-a",
    },
  })),
  profiles: [
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ].map((id, index) => ({
    id,
    members: members.slice(0, index + 1),
    lowest_silver: { monthly_cents: 10000 * (index + 1), denominator: 2 },
    metals: ["bronze", "expanded bronze", "silver", "gold"].map((metal) => ({
      metal,
      status: "calculated",
      counts: { eligible: 2, unknown: 0, excluded: 0 },
      completeness: { catalog: "complete", rates: "complete" },
      reasons: [],
      points: {
        minimum: { monthly_cents: 10000 * (index + 1) },
        median: { monthly_cents: 20000 * (index + 1) },
      },
      candidates: [{ plan_id: "synthetic-plan", evidence_ref: 0 }],
    })),
  })),
};
const db = { query: async () => ({ rows: [] }), exec: async () => {} };
const scope = () => ({ db, signal: new AbortController().signal });
function hostFor(raw = distribution): Required<CalculationHost> {
  return {
    enumerateHouseholdOffers: async () => {
      throw new Error("unused");
    },
    householdDistributions: async () => raw,
  };
}
function setup(
  options: unknown = { publicOnly: true },
  quoting = true,
  host = hostFor(),
  deadlineMs?: number,
) {
  const routes: RouteSpec[] = [],
    tools: McpToolSpec<unknown, unknown>[] = [];
  const config = loadConfig(
    {},
    { version: 1, public: { quoting }, plugins: { entries: [] } },
  );
  plugin.setup({
    options,
    config: coreConfigView(config),
    calculationHost: host,
    routes: { add: (spec: RouteSpec) => routes.push(spec) },
    mcpTools: {
      add: (spec: McpToolSpec<unknown, unknown>) => tools.push(spec),
    },
  } as unknown as PluginContext);
  const wrapper = pluginRoutes(
    { routes: routes.map((spec) => ({ plugin: plugin.manifest.name, spec })) },
    {
      db,
      operatorToken: () => "synthetic-operator-token",
      trustedProxies: [],
      peerAddress: () => "127.0.0.1",
      now: () => 0,
      deadlineMs,
      writeLog: () => {},
    },
  );
  const app = new Hono();
  wrapper.guard(app);
  wrapper.mount(app);
  return { routes, tools, app };
}
const query = new URLSearchParams({
  ...input,
  year: String(input.year),
}).toString();
const post = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
afterEach(() => vi.useRealTimers());

describe("public stipend preparation", () => {
  it("keeps plugin loading off by default and registers only three preset routes and one tool in public mode", () => {
    expect(loadConfig({}).plugins.entries).toEqual([]);
    const { routes, tools } = setup();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /handy/allowance/print",
      "GET /handy/allowance/manifest",
      "POST /handy/allowance",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["get_allowance_range"]);
    expect(setup(undefined, false).routes).toEqual([]);
    expect(setup(undefined, false).tools).toEqual([]);
    expect(setup({}).routes).toHaveLength(4);
  });

  it("rejects private scenarios even with operator credentials, including indirect fields in POST, GET and MCP", async () => {
    const { app, tools } = setup();
    const privateValue = {
      zip: input.zip,
      year: input.year,
      members,
      allowance_cents: 10000,
    };
    expect(
      (
        await app.request("/handy/allowance/scenario", {
          ...post(privateValue),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-operator-token",
          },
        })
      ).status,
    ).toBe(404);
    for (const extra of [
      { members },
      { allowance_cents: 10000 },
      { employer_id: "synthetic" },
      { preset: "other" },
    ]) {
      expect(
        (await app.request("/handy/allowance", post({ ...input, ...extra })))
          .status,
      ).toBe(400);
      const result = await callPluginTool(
        { db, cursorSecret: "synthetic" },
        tools[0]!,
        { ...input, ...extra },
        scope().signal,
      );
      expect(result.isError).toBe(true);
    }
    for (const mode of ["print", "manifest"]) {
      expect(
        (await app.request(`/handy/allowance/${mode}?${query}&members=private`))
          .status,
      ).toBe(400);
      expect(
        (
          await app.request(
            `/handy/allowance/${mode}?${query.replace("zip=77002", "zip=%3Cscript%3E")}`,
          )
        ).status,
      ).toBe(400);
    }
  });

  it("refuses a planted missing-profile minimum and duplicate-profile replacement", async () => {
    for (const profiles of [
      distribution.profiles.slice(0, 3),
      [...distribution.profiles.slice(0, 3), distribution.profiles[0]!],
    ]) {
      const answer = await allowanceScenario(
        hostFor({ ...distribution, profiles }),
        scope(),
        input,
      );
      expect(answer.target).toMatchObject({
        status: "unknown",
        monthly_cents: null,
        denominator: 4,
      });
      expect(answer.reason).toBe("required_profile_missing");
      const html = printAllowanceSheet(answer, "/manifest");
      expect(html).toContain(
        "The allowance target is unknown because a required preset profile is missing.",
      );
      expect(html).toContain("All four profiles are needed.");
      expect(html).toContain("targets:</strong> Unknown");
    }
  });

  it("rejects mixed, absent and missing benchmarks from the atomic result", async () => {
    for (const data_generation of ["synthetic-generation-b", undefined]) {
      const raw = structuredClone(distribution);
      Object.assign(raw.benchmarks[0]!.result, { data_generation });
      await expect(
        allowanceScenario(hostFor(raw), scope(), input),
      ).rejects.toThrow("DATA_CHANGED");
    }
    const raw = structuredClone(distribution);
    raw.benchmarks.pop();
    await expect(
      allowanceScenario(hostFor(raw), scope(), input),
    ).rejects.toThrow("BENCHMARK_MISSING");
  });

  it.each([
    "/handy/allowance",
    "/handy/allowance/print",
    "/handy/allowance/manifest",
  ])("client cancellation stops benchmark reads on %s", async (path) => {
    const controller = new AbortController();
    const host = hostFor();
    let observed: AbortSignal | undefined;
    let calculations = 0;
    host.householdDistributions = async (_input, scope) => {
      calculations++;
      observed = scope.signal;
      controller.abort();
      return distribution;
    };
    const { app } = setup({ publicOnly: true }, true, host);
    const request =
      path === "/handy/allowance"
        ? new Request(`http://localhost${path}`, {
            ...post(input),
            signal: controller.signal,
          })
        : new Request(`http://localhost${path}?${query}`, {
            signal: controller.signal,
          });
    const response = await app.request(request);
    expect(observed?.aborted).toBe(true);
    expect(calculations).toBe(1);
    expect(response.status).toBe(503);
  });

  it("pins source downloads to the printed generation and refuses a stale manifest", async () => {
    const { app } = setup();
    const printed = await app.request(`/handy/allowance/print?${query}`);
    const html = await printed.text();
    expect(html).toContain("data_generation=synthetic-generation-a");
    expect(html).toContain("Illustrative product profiles");
    expect(printed.headers.get("cache-control")).toBe("no-store");
    const manifest = await app.request(
      `/handy/allowance/manifest?${query}&data_generation=synthetic-generation-a`,
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      data_generation: distribution.data_generation,

      provenance: {
        ...distribution.provenance,
        evidence: distribution.provenance.evidence.map(
          (source, evidence_ref) => ({ evidence_ref, source }),
        ),
      },
    });
    const stale = await app.request(
      `/handy/allowance/manifest?${query}&data_generation=synthetic-generation-b`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: "DATA_CHANGED" } });
  });

  it("explains stale print requests and restarts without the old generation or evidence page", async () => {
    for (const host of [
      hostFor(),
      {
        ...hostFor(),
        householdDistributions: async () => {
          throw new Error("DATA_CHANGED");
        },
      },
    ]) {
      const { app } = setup({ publicOnly: true }, true, host);
      const response = await app.request(
        `/handy/allowance/print?${query}&data_generation=synthetic-old&evidence_page=2&paper=A4`,
      );
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("The source data has changed.");
      expect(html).toContain("Restart the sheet");
      expect(html).toContain("<code>DATA_CHANGED</code>");
      expect(html).toContain("paper=A4");
      expect(html).not.toContain("data_generation=");
      expect(html).not.toContain("evidence_page=");
      expect(html).not.toContain("synthetic-old");
    }
  });

  it("requires a generation pin on later evidence pages and rejects private fields there", async () => {
    const { app } = setup();
    for (const suffix of [
      "&evidence_page=2",
      "&evidence_page=0",
      "&members=private",
      "&allowance_cents=100",
    ])
      expect(
        (await app.request(`/handy/allowance/manifest?${query}${suffix}`))
          .status,
      ).toBe(400);
    expect(
      (
        await app.request(
          `/handy/allowance/manifest?${query}&evidence_page=2&data_generation=stale`,
        )
      ).status,
    ).toBe(409);
  });

  it.each([
    "/handy/allowance",
    "/handy/allowance/print",
    "/handy/allowance/manifest",
  ])("enforces host rate limits on %s without credentials", async (path) => {
    const { app, routes } = setup();
    expect(routes.every((route) => route.rateLimit?.activeTotal === 4)).toBe(
      true,
    );
    const request = () =>
      path === "/handy/allowance"
        ? app.request(path, post(input))
        : app.request(`${path}?${query}`);
    for (let index = 0; index < 30; index++)
      expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });

  it("keeps successful MCP output and its tool list below 64 KiB even for dense evidence", async () => {
    const large = structuredClone(distribution);
    for (const profile of large.profiles)
      for (const group of profile.metals)
        group.candidates = Array.from({ length: 2000 }, () => ({
          plan_id: "synthetic-plan",
          evidence_ref: 0,
        }));
    const { tools } = setup({ publicOnly: true }, true, hostFor(large));
    const result = await callPluginTool(
      { db, cursorSecret: "synthetic" },
      tools[0]!,
      input,
      scope().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      data_generation: distribution.data_generation,
    });
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result })),
    ).toBeLessThan(65536);
    expect(
      toolListBytes([
        ...toolNames.map(coreToolDefinition),
        pluginToolDefinition(tools[0]!),
      ]),
    ).toBeLessThan(MAX_TOOL_LIST_BYTES);
    expect(toolListBytes([pluginToolDefinition(tools[0]!)])).toBeLessThan(
      65536,
    );
    const answer = await allowanceScenario(hostFor(), scope(), input);
    answer.location = { zip: "x".repeat(25000) };
    expect(() => allowanceMcpAnswer(answer, input)).toThrow("RESULT_TOO_LARGE");
  });

  it("enforces the shared MCP anonymous rate limit on the public preset", async () => {
    const original = currentRegistries();
    const { tools } = setup();
    activateRegistries({
      ...original,
      mcpTools: tools.map((spec) => ({ plugin: plugin.manifest.name, spec })),
    });
    try {
      const transport = createMcpHttp(db, {
        env: {},
        now: () => 0,
        log: () => {},
      });
      for (let index = 0; index < 60; index++) {
        const response = await transport.fetch(
          mcpPost("tools/call", {
            name: "get_allowance_range",
            arguments: input,
          }),
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain('"isError":true');
        expect(text).toContain('"status":"ok"');
        expect(Buffer.byteLength(text)).toBeLessThan(65536);
      }
      const limited = await transport.fetch(
        mcpPost("tools/call", {
          name: "get_allowance_range",
          arguments: input,
        }),
      );
      expect(limited.status).toBe(429);
    } finally {
      activateRegistries(original);
    }
  });

  it("limits MCP to four concurrent calculations and releases the work", async () => {
    const original = currentRegistries();
    const host = hostFor();
    let entered = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.householdDistributions = async () => {
      entered++;
      await waiting;
      return distribution;
    };
    const { tools } = setup({ publicOnly: true }, true, host);
    activateRegistries({
      ...original,
      mcpTools: tools.map((spec) => ({ plugin: plugin.manifest.name, spec })),
    });
    try {
      const transport = createMcpHttp(db, { env: {}, log: () => {} });
      const call = () =>
        transport.fetch(
          mcpPost("tools/call", {
            name: "get_allowance_range",
            arguments: input,
          }),
        );
      const running = Array.from({ length: 4 }, call);
      await vi.waitFor(() => expect(entered).toBe(4));
      const fifth = await call();
      expect(fifth.status).toBe(429);
      release();
      for (const response of await Promise.all(running)) {
        expect(response.status).toBe(200);
        await response.text();
      }
    } finally {
      release();
      activateRegistries(original);
    }
  });

  it("records separate enabled-response digests without changing the disabled fixtures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXED_TIME));
    const { app, tools } = setup();
    const responses = [
      await (await app.request("/handy/allowance", post(input))).text(),
      await (await app.request(`/handy/allowance/print?${query}`)).text(),
      await (await app.request(`/handy/allowance/manifest?${query}`)).text(),
      JSON.stringify(
        await callPluginTool(
          { db, cursorSecret: "synthetic" },
          tools[0]!,
          input,
          scope().signal,
        ),
      ),
    ];
    const hashes = responses.map((text) =>
      createHash("sha256").update(text).digest("hex"),
    );
    const fixture = new URL(
      "./fixtures/public-on-digests.json",
      import.meta.url,
    );
    if (process.env.RECORD_STIPEND_ON === "1")
      await writeFile(
        fixture,
        `${JSON.stringify({ synthetic: true, hashes }, null, 2)}\n`,
      );
    expect(hashes).toEqual(
      (JSON.parse(await readFile(fixture, "utf8")) as { hashes: string[] })
        .hashes,
    );
  });

  it("detects a source mutant that drops the required-profile check", async () => {
    const mutant = await plantMutant(
      new URL("../src/allowance/service.ts", import.meta.url),
      "const targetKnown = completeProfiles &&",
      "const targetKnown =",
    );
    try {
      const module = (await import(mutant.path)) as typeof allowanceModule;
      const raw = {
        ...distribution,
        profiles: distribution.profiles.slice(0, 3),
      };
      const checked = await module.allowanceScenario(
        hostFor(raw),
        scope(),
        input,
      );
      expect(() =>
        expect(checked.target).toMatchObject({
          status: "unknown",
          monthly_cents: null,
        }),
      ).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("stipend core calculation integration", () => {
  it("shares one generation through actual distribution and benchmark readers, and refuses quoting off", async () => {
    const fixture = await digestFixture();
    try {
      const scope = { db: fixture.db, signal: new AbortController().signal };
      const host = createCalculationHost({
        public: { quoting: true, household: false, compat: false },
      });
      const result = await allowanceScenario(
        host as Required<Pick<CalculationHost, "householdDistributions">>,
        scope,
        input,
      );
      expect(typeof result.data_generation).toBe("string");
      expect(result.profiles).toHaveLength(4);
      for (const entry of result.slcsp as {
        result: { data_generation: string };
      }[])
        expect(entry.result.data_generation).toBe(result.data_generation);
      const changingDb = new Proxy(fixture.db, {
        get(target, key, receiver) {
          if (key !== "query")
            return Reflect.get(target, key, receiver) as unknown;
          let generations = 0;
          return async (sql: string, parameters?: unknown[]) => {
            const result = await target.query(sql, parameters);
            if (sql.includes("AS generation FROM") && ++generations > 1)
              return {
                rows: [{ generation: `synthetic-changed-${generations}` }],
              };
            return result;
          };
        },
      });
      // Keep a stable query function so the planted generation changes on the second read.
      const changingQuery = changingDb.query;
      await expect(
        host.householdDistributions!(inputWithMembers(), {
          ...scope,
          db: { query: changingQuery, exec: fixture.db.exec },
        }),
      ).rejects.toThrow("DATA_CHANGED");
      if (process.env.STIPEND_ARTIFACT_DIR) {
        const directory = process.env.STIPEND_ARTIFACT_DIR;
        await mkdir(directory, { recursive: true });
        const manifestQuery = `${query}&data_generation=${String(result.data_generation)}`;
        for (const paper of ["letter", "A4"] as const)
          await writeFile(
            `${directory}/stipend-${paper}.html`,
            printAllowanceSheet(
              { ...result, generated_at: FIXED_TIME },
              `/handy/allowance/manifest?${manifestQuery}`,
              paper,
            ),
          );
        await writeFile(
          `${directory}/stipend-manifest.json`,
          JSON.stringify(allowanceSourceManifest(result), null, 2),
        );
      }
      const off = createCalculationHost({
        public: { quoting: false, household: false, compat: false },
      });
      await expect(
        off.householdDistributions!(inputWithMembers(), scope),
      ).rejects.toThrow("QUOTING_DISABLED");
      const controller = new AbortController();
      controller.abort();
      await expect(
        host.householdDistributions!(inputWithMembers(), {
          ...scope,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
});
function inputWithMembers() {
  return { zip: input.zip, county: input.county, year: input.year, members };
}
