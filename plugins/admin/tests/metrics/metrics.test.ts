import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type {
  OperatorHost,
  PluginRouteVariables,
  RouteSpec,
  SqlSession,
} from "@openplans/plugin-sdk";
import { registerMetrics, renderMetrics } from "../../src/metrics/index.js";
const now = "2026-11-15T12:00:00.000Z";
const sample = {
  collection: "partial",
  since: now,
  until: now,
  drops: 3,
  resets: 2,
  series: [
    {
      transport: "http",
      operation: "get.plans",
      owner: "core",
      outcome: "completed",
      statusClass: "5xx",
      count: 20,
      durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20],
    },
  ],
} as const;
describe("metrics page", () => {
  it("names denominators, unknowns, bounds and partial coverage", () => {
    const html = renderMetrics(sample, now, {
      hits: 2,
      misses: 3,
      bypasses: 7,
    });
    expect(html).toContain("20 / 20");
    expect(html).toContain("Above 15 s");
    expect(html).toContain("2 / 5");
    expect(html).toContain("Drops since process start: 3");
    expect(html).toContain("Window resets: 2");
    expect(html).toContain("Series cap: 128");
    expect(html).toContain("Other processes and stdio are not included");
    expect(html).toContain("No successful flush observed");
    expect(html).toMatch(/prefers-color-scheme:\s*dark/);
    expect(html).toContain('scope="col"');
    expect(html).not.toContain("<script");
  });
  it("rejects unbounded, raw-label and malformed histogram fixture mutants", () => {
    for (const mutant of [
      {
        ...sample,
        series: [
          { ...sample.series[0], operation: "/v1/plans?secret=synthetic" },
        ],
      },
      {
        ...sample,
        series: Array.from({ length: 129 }, () => sample.series[0]),
      },
      { ...sample, series: [{ ...sample.series[0], durationBuckets: [20] }] },
      { ...sample, series: [{ ...sample.series[0], count: 21 }] },
    ])
      expect(renderMetrics(mutant, now)).toContain("Collection unavailable");
  });
  it("never displays zero latency or a numeric rate without samples", () => {
    const html = renderMetrics({ ...sample, series: [] }, now, {
      hits: 0,
      misses: 0,
      bypasses: 0,
    });
    expect(html).toContain("Undefined, no eligible completions");
    expect(html).toContain("Unavailable, fewer than 20 samples");
    expect(html).toContain("Undefined, no cache lookups");
    expect(html).not.toContain("0 ms");
    expect(() =>
      expect(
        html.replaceAll("Unavailable, fewer than 20 samples", "0 ms"),
      ).not.toContain("0 ms"),
    ).toThrow();
    expect(renderMetrics(undefined, "<synthetic>")).toContain(
      "&lt;synthetic&gt;",
    );
  });
  it("keeps registration protected, reads scoped evidence and returns no-store HTML", async () => {
    const routes: RouteSpec[] = [];
    registerMetrics({
      routes: { add: (route) => routes.push(route) },
      status: {},
      now: () => new Date(now),
    });
    expect(routes).toMatchObject([
      {
        method: "GET",
        path: "/admin/metrics",
        exposure: "operator",
        adminSession: true,
      },
    ]);
    const route = routes[0]!;
    const app = new Hono();
    app.get(route.path, route.handler);
    const result = await app.request(route.path);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.status).toBe(503);
    expect(await result.text()).toContain("This feature is not installed");
  });
  it("uses the scoped telemetry facade and preserves independent cache evidence", async () => {
    const signal = new AbortController().signal;
    const db = {} as SqlSession;
    const read = vi
      .fn<NonNullable<OperatorHost["telemetry"]>["read"]>()
      .mockResolvedValue({
        state: "available",
        value: sample,
        observedAt: now,
      });
    const routes: RouteSpec[] = [];
    registerMetrics({
      routes: { add: (route) => routes.push(route) },
      operator: { telemetry: { read } } as unknown as OperatorHost,
      status: {
        cacheStats: () => ({ hits: 1, misses: 1, bypasses: 0, bytes: 0 }),
      },
      now: () => new Date(now),
    });
    const app = new Hono<{ Variables: PluginRouteVariables }>();
    app.use("*", async (c, next) => {
      c.set("pluginDb", db);
      c.set("pluginSignal", signal);
      await next();
    });
    app.get(routes[0]!.path, routes[0]!.handler);
    const result = await app.request("/admin/metrics");
    expect(result.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      { window: "current_process" },
      { db, signal },
    );
    const html = await result.text();
    expect(html).toContain("Current-process observation");
    expect(html).toContain("1 / 2");
  });
});
