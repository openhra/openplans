import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResponseCache,
  sharedResponseCache,
} from "../../src/api/cache/index.js";
import type { CacheOutcome } from "../../src/api/cache/index.js";
import type { CacheStore } from "../../src/api/cache/store.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { RespCache } from "../../src/api/cache/resp.js";
import { dataGeneration } from "../../src/api/cache/generation.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import {
  callTool,
  MAX_OUTPUT_BYTES,
  messageBytes,
} from "../../src/mcp/tools.js";
import type { McpDependencies } from "../../src/mcp/tools.js";
import type { ToolName } from "../../src/mcp/schemas.js";
import { outputSchemas } from "../../src/mcp/schemas.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import type { McpLog } from "../../src/mcp/http.js";
import { fixtureFiles } from "../api/helpers.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { post } from "./transport-helpers.js";

const db = testDatabase(new PGlite());
const now = () => Date.parse("2026-11-08T12:00:00Z");
const granted = {
  principal: { id: "synthetic-principal-a" },
  policy: { canEstimate: () => true },
};
const planInput = { location: { county: "48201" }, year: 2026, limit: 1 };
// Real regenerable catalog/geography cuts; principals and households are synthetic.
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
let reads: string[],
  writes: [string, string][],
  cache: ReturnType<typeof createResponseCache>;
function trackingStore(cap = 1024 * 1024) {
  const memory = new MemoryCache(cap);
  const store: CacheStore = {
    bytes: () => memory.bytes(),
    get: async (key) => {
      reads.push(key);
      return memory.get(key);
    },
    set: async (key, value, ttl) => {
      writes.push([key, value]);
      await memory.set(key, value, ttl);
    },
  };
  return store;
}
function deps(extra: Partial<McpDependencies> = {}): McpDependencies {
  return {
    db,
    cache,
    now,
    cursorSecret: "synthetic-cache-cursor-secret",
    ...extra,
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-mcp-cache-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        state: "TX",
        year: 2026,
        files: await fixtureFiles(directory),
        dataDir: directory,
      })
    ).status,
  ).toBe("ACTIVE");
  await ingestRatingRules(db);
});
beforeEach(() => {
  vi.unstubAllEnvs();
  reads = [];
  writes = [];
  cache = createResponseCache(db, undefined, { store: trackingStore() });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe("MCP uses the existing public DTO cache", () => {
  it("shares the API backend and preserves cached/uncached schema, text and cursor consistency", async () => {
    expect(sharedResponseCache(db)).toBe(cache);
    const cold = await callTool(deps(), "search_plans", planInput);
    const warm = await callTool(deps(), "search_plans", planInput);
    expect(warm.isError).toBeUndefined();
    expect(warm).toEqual(cold);
    expect(
      outputSchemas.search_plans.safeParse(warm.structuredContent).success,
    ).toBe(true);
    expect(JSON.parse(warm.content[0]!.text)).toEqual(warm.structuredContent);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    vi.stubEnv("OPENPLANS_API_CACHE", "off");
    const off = createResponseCache(db, undefined, { store: trackingStore() });
    expect(
      await callTool(deps({ cache: off }), "search_plans", planInput),
    ).toEqual(cold);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatch(/^openplans:catalog:v1:[a-f0-9]{64}$/);
    expect(writes[0]![1]).not.toContain(
      cold.structuredContent.page!.next_cursor,
    );
  });
  it("caches plan detail, discovery, fetch and directories without changing their answers", async () => {
    const cases: [ToolName, Record<string, unknown>][] = [
      ["get_plan", { plan_ref: "87226TX0100013", year: 2026 }],
      ["search", { query: "87226TX0100013", entity: "plan", year: 2026 }],
      ["fetch", { id: "plan:2026:87226TX0100013" }],
      ["list_carriers_networks", { state: "TX", year: 2026, kind: "carriers" }],
    ];
    for (const [tool, input] of cases) {
      const cold = await callTool(deps(), tool, input),
        warm = await callTool(deps(), tool, input);
      expect(cold.isError, tool).toBeUndefined();
      expect(warm).toEqual(cold);
    }
    expect(cache.stats()).toMatchObject({ misses: 4, hits: 4 });
  });
  it("shares public pages across principals and reissues scope-bound cursors and access labels", async () => {
    const a = deps(granted),
      b = deps({
        ...granted,
        principal: { id: "synthetic-principal-b" },
        cursorSecret: "synthetic-replica-secret",
      });
    const first = (await callTool(a, "search_plans", planInput))
      .structuredContent;
    const second = (await callTool(b, "search_plans", planInput))
      .structuredContent;
    expect(second.data).toEqual(first.data);
    expect(second.page!.next_cursor).not.toBe(first.page!.next_cursor);
    expect(
      (
        await callTool(b, "search_plans", {
          ...planInput,
          cursor: second.page!.next_cursor,
        })
      ).isError,
    ).toBeUndefined();
    expect(
      (
        await callTool(b, "search_plans", {
          ...planInput,
          cursor: first.page!.next_cursor,
        })
      ).structuredContent.error?.code,
    ).toBe("INVALID_CURSOR");
    const authorized = await callTool(a, "get_data_status", {
      state: "TX",
      year: 2026,
    });
    const anonymous = await callTool(deps(), "get_data_status", {
      state: "TX",
      year: 2026,
    });
    expect(authorized.structuredContent.data).toMatchObject({
      personalized_access: "authorized",
    });
    expect(anonymous.structuredContent.data).toMatchObject({
      personalized_access: "authentication_required",
    });
    expect(cache.stats().hits).toBe(2);
    const stored = JSON.stringify(writes);
    for (const marker of [
      "synthetic-principal-a",
      "synthetic-principal-b",
      "synthetic-cache-cursor-secret",
      "synthetic-replica-secret",
    ]) {
      expect(stored).not.toContain(marker);
    }
  });
  it("a new ACTIVE fixture snapshot invalidates a populated page and expires old cursors", async () => {
    const old = (await callTool(deps(), "search_plans", planInput))
      .structuredContent;
    await callTool(deps(), "search_plans", planInput);
    expect(
      (
        await importPufs(db, {
          state: "TX",
          year: 2026,
          files: await fixtureFiles(directory),
          dataDir: directory,
        })
      ).status,
    ).toBe("ACTIVE");
    const fresh = (await callTool(deps(), "search_plans", planInput))
      .structuredContent;
    expect(fresh.data_generation).not.toBe(old.data_generation);
    const freshPlan = outputSchemas.search_plans.parse(fresh).data!.plans[0]!;
    const oldPlan = outputSchemas.search_plans.parse(old).data!.plans[0]!;
    expect(freshPlan.plan_ref).toBe(oldPlan.plan_ref);
    expect(freshPlan.evidence_refs).not.toEqual(oldPlan.evidence_refs);
    expect(cache.stats()).toMatchObject({ misses: 2, hits: 1 });
    const expired = await callTool(deps(), "search_plans", {
      ...planInput,
      cursor: old.page!.next_cursor,
    });
    expect(expired.structuredContent.error).toMatchObject({
      code: "CURSOR_EXPIRED",
      retryable: true,
    });
    expect(reads).toHaveLength(3);
  });
  it("failed and denied observations also invalidate, without a new generation migration", async () => {
    const before = await dataGeneration(db);
    await callTool(deps(), "lookup_geography", { zip: "77002" });
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=(SELECT snapshot_id FROM puf_import_file LIMIT 1)",
    );
    const failed = await dataGeneration(db);
    expect(failed).not.toBe(before);
    await callTool(deps(), "lookup_geography", { zip: "77002" });
    await db.query(
      "UPDATE snapshot SET http_status=403 WHERE snapshot_id=(SELECT snapshot_id FROM puf_import_file LIMIT 1)",
    );
    expect(await dataGeneration(db)).not.toBe(failed);
    await callTool(deps(), "lookup_geography", { zip: "77002" });
    expect(cache.stats().misses).toBe(3);
  });
  it("never reads or writes the cache for estimates, household inputs or failed tools", async () => {
    const household = {
      plan_refs: ["87226TX0100013"],
      location: { county: "48201" },
      coverage_start: "2026-01-01",
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    };
    for (let i = 0; i < 2; i++)
      expect(
        (await callTool(deps(granted), "quote_premiums", household)).isError,
      ).toBeUndefined();
    expect(
      (await callTool(deps(), "quote_premiums", household)).structuredContent
        .error?.code,
    ).toBe("AUTH_REQUIRED");
    expect(
      (
        await callTool(deps(), "search_plans", {
          ...planInput,
          household: { income_annual: 41000 },
        })
      ).isError,
    ).toBe(true);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await callTool(deps(), "get_plan", {
            plan_ref: "99999TX9999999",
            year: 2026,
          })
        ).isError,
      ).toBe(true);
    expect(writes).toEqual([]);
    expect(cache.stats().bytes).toBe(0);
  });
  it("uses the selected backend on HTTP, keeps credentials out, and returns the public answer while down", async () => {
    const logs: McpLog[] = [],
      env = { OPENPLANS_MCP_TOKEN: "synthetic-mcp-cache-bearer" };
    const app = createMcpHttp(db, { env, log: (entry) => logs.push(entry) });
    const request = (auth = false) =>
      post(
        "tools/call",
        { name: "lookup_geography", arguments: { zip: "77002" } },
        auth ? { Authorization: "Bearer synthetic-mcp-cache-bearer" } : {},
      );
    const first = await (await app.fetch(request(true))).json();
    const hit = await (await app.fetch(request())).json();
    expect(hit.result.structuredContent.data).toEqual(
      first.result.structuredContent.data,
    );
    expect(logs.map((log) => log.cache)).toEqual(["miss", "hit"]);
    expect(JSON.stringify(writes)).not.toContain(env.OPENPLANS_MCP_TOKEN);
    const readsBeforeDenial = reads.length;
    const denied = await app.fetch(
      post("tools/call", { name: "quote_premiums", arguments: {} }),
    );
    expect(denied.status).toBe(401);
    await denied.text();
    expect(reads).toHaveLength(readsBeforeDenial);
    expect(writes).toHaveLength(1);
    // Port 1 is deliberately unreachable. Exercise P10a's actual TCP failure path.
    createResponseCache(db, undefined, {
      store: new RespCache("redis://127.0.0.1:1"),
    });
    const downLogs: McpLog[] = [],
      down = createMcpHttp(db, { log: (log) => downLogs.push(log) });
    const bypass = await (await down.fetch(request())).json();
    expect(bypass.result.structuredContent.data).toEqual(
      first.result.structuredContent.data,
    );
    expect(downLogs[0]!.cache).toBe("bypass");
    expect(sharedResponseCache(db).stats()).toMatchObject({
      backend: "external",
      bytes: 0,
    });
    expect(writes).toHaveLength(1);
  });
  it("cache write outages and bounded LRU eviction preserve results; large RPC IDs stay bounded on hits", async () => {
    const throwing: CacheStore = {
      bytes: () => 0,
      get: async () => null,
      set: async () => {
        throw Error("Synthetic down");
      },
    };
    const broken = createResponseCache(db, undefined, { store: throwing });
    const outcomes: CacheOutcome[] = [];
    const uncached = await callTool(
      deps({ cache: broken, onCache: (outcome) => outcomes.push(outcome) }),
      "search_plans",
      planInput,
    );
    expect(uncached.isError).toBeUndefined();
    expect(outcomes.at(-1)).toBe("bypass");
    const bounded = createResponseCache(db, undefined, {
      store: trackingStore(2048),
    });
    expect(
      await callTool(deps({ cache: bounded }), "search_plans", planInput),
    ).toEqual(uncached);
    expect(bounded.stats().bytes).toBeLessThanOrEqual(2048);
    const largeId = "x".repeat(60_000);
    const a = await callTool(deps(), "search_plans", planInput, largeId);
    const b = await callTool(deps(), "search_plans", planInput, largeId);
    expect(b).toEqual(a);
    expect(messageBytes(b.structuredContent, largeId)).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
  });
});
