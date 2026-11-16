import { describe, expect, it } from "vitest";
import type { OperatorStatus } from "@openplans/plugin-status";
import {
  ADMIN_PATH,
  createAdminPlugin,
  renderAdminOverview,
} from "../src/index.js";
import { Hono } from "hono";
import { pluginRoutes } from "../../../src/plugins/routes.js";
import type { RouteSpec, SqlSession } from "@openplans/plugin-sdk";

const sample = {
  version: "0.4.10",
  api: "ok",
  db: "ok",
  pool: { waiting: null },
  data: { states: null, years: null, status_counts: null, issuers: null },
  sources: null,
  worker: { last_ingest: null },
  cache: {
    enabled: false,
    backend: "memory",
    hits: null,
    misses: null,
    bypasses: null,
    bytes: null,
  },
  passthrough: null,
  plugins: [],
  events: { recent: null },
  health_transitions: { last_change: "unknown", history: null },
} satisfies OperatorStatus;

function assertAdminContract(input: {
  unknownHtml: string;
  availableHtml: string;
  statusOwner: string;
  method: string;
  absentCredentialStatus: number;
}) {
  expect(input.unknownHtml).toContain("Coverage evidence is unavailable.");
  expect(input.unknownHtml).not.toContain("Coverage: 0");
  expect(input.availableHtml).toContain("&lt;exchange&gt;");
  expect(input.availableHtml).not.toContain("<exchange>");
  expect(input.statusOwner).toBe("@openplans/plugin-status");
  expect(input.method).toBe("GET");
  expect(input.absentCredentialStatus).toBe(404);
}

describe("admin overview", () => {
  it("preserves unknown values, groups panels and emits accessible responsive HTML", () => {
    const html = renderAdminOverview(sample, "2026-11-15T12:00:00.000Z");
    expect(html).toContain("Coverage evidence is unavailable.");
    expect(html).toContain("Source evidence is unavailable.");
    expect(html).not.toContain("States: 0");
    expect(html).toContain("Skip to overview");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("@media (max-width");
    expect(html).not.toContain("<script");

    const available = renderAdminOverview({
      ...sample,
      data: {
        ...sample.data,
        states: 1,
        years: [2026],
        issuers: [
          {
            state: "TX",
            year: 2026,
            market: "<exchange>",
            issuer_id: "issuer-1",
            catalog: "available",
            premium: "unknown",
            provider: "unknown",
            formulary: "unknown",
            snapshot_id: null,
          },
        ],
      },
      sources: [
        {
          id: "fixture:source",
          freshness: "unknown",
          published_at: null,
          published_from: null,
          retrieved_at: null,
          snapshot_id: "fixture-snapshot",
        },
      ],
    });
    expect(available).toContain("<caption>Scope availability</caption>");
    expect(available).toContain('tabindex="0"');
    expect(available).toContain("&lt;exchange&gt;");
    expect(available).toContain("fixture-snapshot");
  });

  it("escapes values and preserves the overview registration", () => {
    const html = renderAdminOverview({ ...sample, version: "<img src=x>" });
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
    const routes: RouteSpec[] = [];
    createAdminPlugin().setup({
      routes: { add: (route: RouteSpec) => routes.push(route) },
    } as never);
    expect(
      routes
        .filter(({ path }) => path === ADMIN_PATH)
        .map(({ method, path, exposure }) => ({ method, path, exposure })),
    ).toEqual([{ method: "GET", path: ADMIN_PATH, exposure: "operator" }]);
  });

  it("uses the status plugin state owner and inherits bearer and no-store policy", async () => {
    const specs: RouteSpec[] = [];
    const dbCalls: { sql: string; parameters?: unknown[] }[] = [];
    const db = {
      query: async (sql: string, parameters?: unknown[]) => {
        dbCalls.push({ sql, parameters });
        return { rows: sql === "SELECT 1" ? [{}] : [] };
      },
      exec: async () => {
        throw new Error("read-only route attempted a write");
      },
    };
    const config = {
      cache: { enabled: false, provider: "memory" },
      plugins: [],
      cmsFallback: { enabled: false },
    };
    createAdminPlugin({
      now: () => new Date("2026-11-15T12:00:00.000Z"),
    }).setup({
      config,
      routes: { add: (route: RouteSpec) => specs.push(route) },
    } as never);
    const router = pluginRoutes(
      {
        routes: specs.map((spec) => ({
          plugin: "@openplans/plugin-admin",
          spec,
        })),
      },
      {
        db: db as unknown as SqlSession,
        operatorToken: () => "synthetic-token",
        trustedProxies: [],
      },
    );
    const app = new Hono();
    router.guard(app);
    router.mount(app);
    expect((await app.request(ADMIN_PATH)).status).toBe(401);
    expect(
      (
        await app.request(ADMIN_PATH, {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    const response = await app.request(ADMIN_PATH, {
      headers: { authorization: "Bearer synthetic-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(
      "Coverage evidence is unavailable.",
    );
    expect(
      (
        await app.request(ADMIN_PATH, {
          method: "POST",
          headers: { authorization: "Bearer synthetic-token" },
        })
      ).status,
    ).toBe(404);
    const stateRead = dbCalls.find(({ sql }) => sql.includes("plugin_state"));
    expect(stateRead?.parameters).toEqual(["@openplans/plugin-status"]);

    const absentTokenRouter = pluginRoutes(
      {
        routes: specs.map((spec) => ({
          plugin: "@openplans/plugin-admin",
          spec,
        })),
      },
      {
        db: db as unknown as SqlSession,
        operatorToken: () => undefined,
        trustedProxies: [],
      },
    );
    const absentTokenApp = new Hono();
    absentTokenRouter.guard(absentTokenApp);
    absentTokenRouter.mount(absentTokenApp);
    expect((await absentTokenApp.request(ADMIN_PATH)).status).toBe(404);
  });

  it("rejects planted unknown, escaping, state-owner, method and credential mutants", () => {
    const unknownHtml = renderAdminOverview(sample);
    const availableHtml = renderAdminOverview({
      ...sample,
      data: {
        ...sample.data,
        issuers: [
          {
            state: "TX",
            year: 2026,
            market: "<exchange>",
            issuer_id: "issuer-1",
            catalog: "available",
            premium: "unknown",
            provider: "unknown",
            formulary: "unknown",
            snapshot_id: null,
          },
        ],
      },
    });
    const baseline = {
      unknownHtml,
      availableHtml,
      statusOwner: "@openplans/plugin-status",
      method: "GET",
      absentCredentialStatus: 404,
    };
    assertAdminContract(baseline);

    const mutants = [
      {
        ...baseline,
        unknownHtml: unknownHtml.replace(
          "Coverage evidence is unavailable.",
          "Coverage: 0",
        ),
      },
      {
        ...baseline,
        availableHtml: availableHtml.replace("&lt;exchange&gt;", "<exchange>"),
      },
      { ...baseline, statusOwner: "@openplans/plugin-admin" },
      { ...baseline, method: "POST" },
      { ...baseline, absentCredentialStatus: 200 },
    ];
    for (const mutant of mutants)
      expect(() => assertAdminContract(mutant)).toThrow();
  });
});
