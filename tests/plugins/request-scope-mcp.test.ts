import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CacheLevel } from "@openplans/plugin-sdk";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { CacheStore } from "../../src/api/cache/store.js";
import type { SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import type { McpLog } from "../../src/mcp/http.js";
import { restrictCacheLevel } from "../../src/plugins/request-scope.js";
import { post } from "../mcp/transport-helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";
import { importMutant, withMutantFile } from "../mutant-file.js";

// Synthetic: an empty migrated catalog and a ZIP with no rows. The level is injected from the
// tool's own SQL, as a pass-through answer would restrict it from inside catalog()'s load().
type Restriction = { level: CacheLevel; ttl?: number } | null;

describe("MCP streaming path sees the cache level before the first byte", () => {
  const base = testDatabase(new PGlite());
  let core: Awaited<ReturnType<typeof coreMigrations>>;
  beforeAll(async () => {
    core = await coreMigrations();
    await migrate(base, core.directory);
  });
  afterAll(async () => {
    await base.close();
    await core?.cleanup();
  });

  async function call(
    restriction: Restriction,
    factory: typeof createMcpHttp = createMcpHttp,
  ) {
    // A fresh wrapper per case: sharedResponseCache is keyed by the session object.
    const db = new Proxy(base, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "query") return value;
        return (sql: string, ...rest: unknown[]) => {
          if (restriction && !/api_data_generation/.test(String(sql)))
            restrictCacheLevel(restriction.level, restriction.ttl);
          return (value as (...args: unknown[]) => unknown).call(
            target,
            sql,
            ...rest,
          );
        };
      },
    }) as SqlSession;
    const memory = new MemoryCache(1024 * 1024),
      ttls: number[] = [];
    const store: CacheStore = {
      bytes: () => memory.bytes(),
      get: (key) => memory.get(key),
      set: async (key, value, ttl) => {
        ttls.push(ttl);
        await memory.set(key, value, ttl);
      },
    };
    createResponseCache(db, undefined, { store });
    const events: string[] = [],
      logs: McpLog[] = [];
    const app = factory(db, {
      env: {},
      log: (entry) => logs.push(entry),
      onCacheLevel: (level) => events.push(`level:${level}`),
    });
    const response = await app.fetch(
      post("tools/call", {
        name: "lookup_geography",
        arguments: { zip: "00000" },
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      events.push("byte");
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain(String.raw`\"zip\":\"00000\"`);
    return { events, ttls, bytes: memory.bytes(), cache: logs[0]?.cache };
  }

  it.each(["none", "request"] as const)(
    "%s: known before the first byte; the catalog stays empty",
    async (level) => {
      const result = await call({ level });
      expect(result.events[0]).toBe(`level:${level}`);
      expect(result.events.slice(1).every((e) => e === "byte")).toBe(true);
      expect(result.ttls).toEqual([]);
      expect(result.bytes).toBe(0);
      expect(result.cache).toBe("bypass");
    },
  );
  it("memory: stored for min(tool TTL, source TTL)", async () => {
    const result = await call({ level: "memory", ttl: 7 });
    expect(result.events[0]).toBe("level:memory");
    expect(result.ttls).toEqual([7]);
    expect(result.cache).toBe("miss");
  });
  it.each([{ level: "stored" as const }, null])(
    "%o: today's behaviour, the tool's 300 s TTL",
    async (restriction) => {
      const result = await call(restriction);
      expect(result.events[0]).toBe(`level:${restriction?.level ?? null}`);
      expect(result.ttls).toEqual([300]);
      expect(result.cache).toBe("miss");
    },
  );
  it("negative control: an MCP handler without its scope does not see the level", async () => {
    const source = new URL("../../src/mcp/http.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "runWithScope(",
        "((fn: (h: ScopeHandle) => Promise<Response>) => fn({ level: () => null }))(",
      ),
      async (temporary) => {
        const mutant = await importMutant<{
          createMcpHttp: typeof createMcpHttp;
        }>(temporary, "createMcpHttp");
        const real = await call({ level: "none" });
        expect(real.events[0]).toBe("level:none");
        const changed = await call({ level: "none" }, mutant.createMcpHttp);
        expect(changed.events[0]).not.toBe("level:none");
      },
    );
  });
});
