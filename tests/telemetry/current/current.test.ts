import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SqlSession } from "../../../src/db/database.js";
import { createApp } from "../../../src/api/app.js";
import { createResponseCache } from "../../../src/api/cache/index.js";
import { loadConfig } from "../../../src/config/index.js";
import {
  configureTelemetry,
  activeRecorder,
  currentReader,
} from "../../../src/telemetry/index.js";
import {
  createRecorder,
  httpObserver,
} from "../../../src/telemetry/observer.js";
import {
  BUCKET_MS,
  MEMORY_CAP,
  SERIES_BYTES,
  SERIES_CAP,
} from "../../../src/telemetry/aggregate.js";
import { responseDigest } from "../../plugins/admin-support/digests.js";
import { post } from "../../mcp/transport-helpers.js";
import { createMcpHttp } from "../../../src/mcp/http.js";

// Synthetic database, no sockets or public service access.
const db: SqlSession = {
  async query(sql: string) {
    return {
      rows:
        sql.includes("FROM annual_data_admission") || sql.includes("AS domain")
          ? []
          : [{ ok: 1, generation: "1" }],
      rowCount: 1,
    };
  },
} as unknown as SqlSession;
afterEach(() => {
  configureTelemetry({ enabled: false });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function assertSnapshot(
  snapshot: ReturnType<
    ReturnType<typeof createRecorder>["aggregate"]["snapshot"]
  >,
) {
  expect(snapshot.series.length).toBeLessThanOrEqual(SERIES_CAP);
  expect(snapshot.reservedBytes).toBeLessThanOrEqual(MEMORY_CAP);
  for (const row of snapshot.series) {
    expect(row.operation).toMatch(/^[a-zA-Z0-9_.:-]{1,120}$/);
    expect(row.durationBuckets.reduce((sum, value) => sum + value, 0)).toBe(
      row.count,
    );
  }
}

describe("bounded current-process telemetry", () => {
  it("allocates no recorder while disabled and refuses retained windows without SQL", async () => {
    configureTelemetry({ enabled: false });
    expect(activeRecorder()).toBeUndefined();
    configureTelemetry({ enabled: true });
    const collector = activeRecorder()!;
    const query = vi.spyOn(db, "query");
    const reader = currentReader(collector.aggregate);
    expect(
      await reader.read(
        { window: "7d" },
        { db, signal: new AbortController().signal },
      ),
    ).toMatchObject({ state: "unavailable", reason: "not_collected" });
    expect(
      await reader.read(
        { window: "current_process" },
        { db, signal: AbortSignal.abort() },
      ),
    ).toMatchObject({ state: "unavailable", reason: "deadline" });
    expect(query).not.toHaveBeenCalled();
  });
  it("records exact disjoint histograms, outcomes, rates and cache decisions", () => {
    const sink = createRecorder();
    const http = sink.register("http", "get.plans"),
      tool = sink.register("mcp", "get_plan");
    for (const duration of [
      0, 5, 6, 10, 11, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 15001,
    ])
      sink.complete(http, 200, "completed", duration);
    sink.complete(tool, 500, "completed", 30);
    sink.complete(http, 429, "completed", 7);
    sink.complete(http, 499, "cancelled", 7);
    sink.complete(http, 504, "timeout", 7);
    sink.cache("hit");
    sink.cache("miss");
    sink.cache("bypass");
    const snapshot = sink.aggregate.snapshot();
    expect(snapshot.series[0]?.durationBuckets).toEqual([
      2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    expect(snapshot.series.reduce((sum, row) => sum + row.count, 0)).toBe(19);
    expect(
      snapshot.series.map((row) => [row.outcome, row.statusClass]),
    ).toEqual([
      ["completed", "2xx"],
      ["completed", "5xx"],
      ["completed", "429"],
      ["cancelled", "4xx"],
      ["timeout", "5xx"],
    ]);
    expect(snapshot.cache).toEqual({ hits: 1, misses: 1, bypasses: 1 });
    assertSnapshot(snapshot);
  });
  it("rejects raw URL registrations and forged capture labels, folds series overflow, resets bounded windows", () => {
    let now = 0;
    const sink = createRecorder(() => now);
    expect(() => sink.register("http", "/v1/plans?zip=synthetic")).toThrow(
      "Invalid telemetry registration",
    );
    sink.complete(
      { transport: "http", operation: "/sensitive", owner: "core" },
      200,
      "completed",
      1,
    );
    expect(sink.aggregate.snapshot().series).toHaveLength(0);
    for (let i = 0; i < 200; i++)
      sink.complete(
        sink.register("http", `synthetic.${i}`),
        200,
        "completed",
        10,
      );
    const snapshot = sink.aggregate.snapshot();
    expect(snapshot.series).toHaveLength(128);
    expect(snapshot.series.at(-1)).toMatchObject({
      operation: "other",
      count: 73,
    });
    expect(snapshot.drops).toBe(73);
    expect(snapshot.reservedBytes).toBe(SERIES_CAP * SERIES_BYTES);
    assertSnapshot(snapshot);
    expect(() =>
      assertSnapshot({ ...snapshot, reservedBytes: MEMORY_CAP + 1 }),
    ).toThrow();
    expect(() =>
      assertSnapshot({
        ...snapshot,
        series: [...snapshot.series, snapshot.series[0]!],
      }),
    ).toThrow();
    expect(() =>
      assertSnapshot({
        ...snapshot,
        series: [{ ...snapshot.series[0]!, operation: "/raw?query" }],
      }),
    ).toThrow();
    now = BUCKET_MS;
    expect(sink.aggregate.snapshot()).toMatchObject({
      resets: 1,
      series: [],
      reservedBytes: 0,
      drops: 73,
    });
  });
  it("keeps HTTP bytes identical off/on, including a rejected one-byte mutant, and never labels request input", async () => {
    const off = createApp(db);
    const expected = await responseDigest(
      await off.request("/healthz?private=synthetic"),
    );
    configureTelemetry({ enabled: true });
    const on = createApp(db);
    expect(
      await responseDigest(await on.request("/healthz?private=synthetic")),
    ).toEqual(expected);
    expect(() =>
      expect({
        ...expected,
        body_sha256: `x${expected.body_sha256.slice(1)}`,
      }).toEqual(expected),
    ).toThrow();
    await (await on.request("/unregistered/synthetic-secret")).text();
    const snapshot = activeRecorder()!.aggregate.snapshot();
    expect(snapshot.series.map((row) => row.operation)).toEqual([
      "get.healthz",
      "unmatched",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|synthetic-secret/);
  });
  it("records the existing cache decisions exactly once", async () => {
    configureTelemetry({ enabled: true });
    const cache = createResponseCache(db, undefined, {
      config: loadConfig({ OPENPLANS_API_CACHE: "1" }),
    });
    const app = new Hono();
    app.use("*", cache.middleware);
    app.get("/v1/plans", (c) => c.json({ plans: [] }));
    await (await app.request("/v1/plans")).text();
    await (await app.request("/v1/plans")).text();
    await (await app.request("/unknown")).text();
    expect(activeRecorder()!.aggregate.snapshot().cache).toEqual({
      hits: 1,
      misses: 1,
      bypasses: 1,
    });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, bypasses: 1 });
  });
  it("waits for EOF, classifies disconnect once and catches a throwing sink", async () => {
    configureTelemetry({ enabled: true });
    const sink = activeRecorder()!;
    const label = sink.register("http", "synthetic.stream");
    const app = new Hono();
    app.use(
      "*",
      httpObserver(() => label),
    );
    app.get(
      "/stream",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("synthetic"));
            },
          }),
        ),
    );
    const response = await app.request("/stream");
    expect(sink.aggregate.snapshot().series).toHaveLength(0);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(sink.aggregate.snapshot().series).toMatchObject([
      { outcome: "cancelled", count: 1 },
    ]);
    vi.spyOn(sink, "complete").mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });
    const publicApp = createApp(db);
    const result = await publicApp.request("/healthz");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: "ok", db: "ok" });
  });
  it("records one MCP tool separate from its HTTP envelope, and preserves MCP bytes", async () => {
    vi.stubEnv("OPENPLANS_MCP", "1");
    vi.stubEnv("OPENPLANS_MCP_ALLOWED_HOSTS", "127.0.0.1");
    const direct = createMcpHttp(db, { log: () => {} });
    const expected = await responseDigest(
      await direct.fetch(post("tools/list")),
    );
    configureTelemetry({ enabled: true });
    const app = createApp(db);
    expect(await responseDigest(await app.fetch(post("tools/list")))).toEqual(
      expected,
    );
    await (
      await app.fetch(
        post("tools/call", { name: "get_data_status", arguments: {} }),
      )
    ).text();
    const snapshot = activeRecorder()!.aggregate.snapshot();
    expect(
      snapshot.series
        .filter((row) => row.transport === "http")
        .reduce((sum, row) => sum + row.count, 0),
    ).toBe(2);
    expect(
      snapshot.series
        .filter((row) => row.transport === "mcp")
        .reduce((sum, row) => sum + row.count, 0),
    ).toBe(1);
    const tools = snapshot.series.filter((row) => row.transport === "mcp");
    expect(() =>
      expect(
        [...tools, ...tools].reduce((sum, row) => sum + row.count, 0),
      ).toBe(1),
    ).toThrow();
  });
});
