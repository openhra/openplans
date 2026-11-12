import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CacheLevel } from "@openplans/plugin-sdk";
import * as requestScope from "../../src/plugins/request-scope.js";
import { fetchToCache } from "../../src/fetch/cache.js";
import { FetchError } from "../../src/fetch/errors.js";
import { replaceSyntax } from "../source-mutation.js";

type ScopeModule = typeof requestScope;
const root = fileURLToPath(new URL("../../", import.meta.url));

// The behaviour every copy of request-scope.ts must keep. Mutants below must break it.
async function scopeContract(m: ScopeModule) {
  // Outside a scope nothing is recorded and caches keep the route TTL.
  m.restrictCacheLevel("none");
  expect(m.scopeCacheLevel()).toBeNull();
  expect(m.scopeStoreTtl(60)).toBe(60);
  expect(m.scopeForbidsStorage()).toBe(false);

  // Strictest wins, whatever the order.
  await m.runWithScope(async () => {
    m.restrictCacheLevel("stored");
    m.restrictCacheLevel("none");
    m.restrictCacheLevel("memory", 5);
    expect(m.scopeCacheLevel()).toBe("none");
  });
  const expected: [CacheLevel | null, number | null, boolean][] = [
    [null, 60, false],
    ["stored", 60, false],
    ["memory", 60, false],
    ["request", null, true],
    ["none", null, true],
  ];
  for (const [level, ttl, forbids] of expected)
    await m.runWithScope(async () => {
      if (level) m.restrictCacheLevel(level);
      expect(m.scopeStoreTtl(60)).toBe(ttl);
      expect(m.scopeForbidsStorage()).toBe(forbids);
    });
  // memory: min(route, shortest source TTL).
  await m.runWithScope(async () => {
    m.restrictCacheLevel("memory", 30);
    m.restrictCacheLevel("memory", 10);
    m.restrictCacheLevel("stored");
    expect(m.scopeStoreTtl(60)).toBe(10);
    expect(m.scopeStoreTtl(5)).toBe(5);
  });
  await m.runWithScope(async () => {
    m.restrictCacheLevel("memory", 0);
    expect(m.scopeStoreTtl(60)).toBeNull();
  });

  // A nested scope starts at its parent's level, shares the request answers and passes its
  // restrictions up, even after an async hop.
  await m.runWithScope(async (outer) => {
    m.scopeRequestAnswers()?.set("synthetic-question", "synthetic-answer");
    m.restrictCacheLevel("memory", 20);
    await m.runWithScope(async (inner) => {
      expect(m.scopeCacheLevel()).toBe("memory");
      expect(m.scopeRequestAnswers()?.get("synthetic-question")).toBe(
        "synthetic-answer",
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      m.restrictCacheLevel("request");
      expect(inner.level()).toBe("request");
    });
    expect(outer.level()).toBe("request");
    expect(m.scopeCacheLevel()).toBe("request");
  });
  // Sibling scopes do not leak into each other.
  const levels = await Promise.all(
    (["none", "stored"] as const).map((level) =>
      m.runWithScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        m.restrictCacheLevel(level);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return m.scopeCacheLevel();
      }),
    ),
  );
  expect(levels).toEqual(["none", "stored"]);
  expect(() =>
    m.restrictCacheLevel("synthetic" as unknown as CacheLevel),
  ).toThrow(TypeError);
}

describe("request scope", () => {
  it("keeps the strictest level, the memory TTL and nesting rules", async () => {
    await scopeContract(requestScope);
  });

  it.each([
    [
      "loosening",
      "if (s.level === null || order(level) < order(s.level)) s.level = level;",
      "s.level = level;",
    ],
    [
      "no-propagation",
      "for (let s = scope.getStore(); s; s = s.parent)",
      "for (let s = scope.getStore(); s; s = undefined)",
    ],
    [
      "request-stores",
      "return ttl > 0 ? ttl : null;\n  }\n  return null;",
      "return ttl > 0 ? ttl : null;\n  }\n  return routeTtlSeconds;",
    ],
    [
      "memory-ignores-source-ttl",
      ": Math.min(routeTtlSeconds, s.memoryTtlSeconds)",
      ": routeTtlSeconds",
    ],
  ])(
    "negative control: %s mutant fails the contract",
    async (kind, before, after) => {
      const source = join(root, "src/plugins/request-scope.ts");
      const temporary = join(root, `src/plugins/.scope-mutant-${kind}.ts`);
      await writeFile(
        temporary,
        replaceSyntax(await readFile(source, "utf8"), before, after),
      );
      try {
        const mutant = (await import(
          /* @vite-ignore */ temporary
        )) as ScopeModule;
        await expect(scopeContract(mutant)).rejects.toThrow();
      } finally {
        await rm(temporary, { force: true });
      }
    },
  );
});

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(path))
      out.push(path);
  }
  return out;
}

describe("scope establishment rules", () => {
  it("opens scopes only in the response cache and the MCP HTTP handler", async () => {
    const files = [
      ...(await sourceFiles(join(root, "src"))),
      ...(await sourceFiles(join(root, "plugins/sdk/src"))),
    ];
    const opened: Record<string, number> = {},
      storage: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8"),
        name = relative(root, file);
      const calls = text.match(/\brunWithScope\(/g)?.length ?? 0;
      if (calls && name !== "src/plugins/request-scope.ts")
        opened[name] = calls;
      if (/\bAsyncLocalStorage\b/.test(text)) storage.push(name);
    }
    // Middleware and catalog() in the response cache; handler.fetch in the MCP HTTP handler.
    expect(opened).toEqual({
      "src/api/cache/index.ts": 2,
      "src/mcp/http.ts": 1,
    });
    // The event bus keeps its own SQL-session store (PLG-13), and migrate.ts keeps the worker's
    // enabled plugin migrations for bootstrap and ingest (5.13). No request scope lives there.
    expect(storage.sort()).toEqual([
      "src/db/migrate.ts",
      "src/plugins/events.ts",
      "src/plugins/request-scope.ts",
    ]);
  });
});

describe("fetchToCache inside a request scope", () => {
  async function attempt(
    level: CacheLevel | null,
    fetcher: typeof fetchToCache = fetchToCache,
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), "openplans-scope-"));
    let requests = 0;
    try {
      const error = await requestScope.runWithScope(async () => {
        if (level) requestScope.restrictCacheLevel(level);
        return fetcher("https://synthetic.invalid/data.json", {
          source: "synthetic-scope",
          allowHosts: ["synthetic.invalid"],
          expectedContent: "json",
          dataDir,
          maxAttempts: 1,
          lookup: async () => [{ address: "192.0.2.1", family: 4 }],
          transport: async () => {
            requests++;
            throw new Error("synthetic transport");
          },
        }).then(
          () => null,
          (e: unknown) => e,
        );
      });
      return {
        code: error instanceof FetchError ? error.code : String(error),
        requests,
        files: await readdir(dataDir),
      };
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  it.each(["none", "request"] as const)(
    "%s: refuses before any request or disk write",
    async (level) => {
      expect(await attempt(level)).toEqual({
        code: "storage_forbidden",
        requests: 0,
        files: [],
      });
    },
  );
  it.each(["memory", "stored", null] as const)(
    "%s: the guard does not apply",
    async (level) => {
      // It runs on to the URL policy, which refuses the TEST-NET address before any request.
      expect(await attempt(level)).toEqual({
        code: "blocked_address",
        requests: 0,
        files: [],
      });
    },
  );
  it("negative control: without the guard a none request reaches the fetch", async () => {
    const source = join(root, "src/fetch/cache.ts");
    const temporary = join(root, "src/fetch/.scope-mutant-cache.ts");
    await writeFile(
      temporary,
      replaceSyntax(
        await readFile(source, "utf8"),
        "if (scopeForbidsStorage())",
        "if (false)",
      ),
    );
    try {
      const mutant = (await import(/* @vite-ignore */ temporary)) as {
        fetchToCache: typeof fetchToCache;
      };
      expect((await attempt("none", mutant.fetchToCache)).code).toBe(
        "blocked_address",
      );
    } finally {
      await rm(temporary, { force: true });
    }
  });
});
