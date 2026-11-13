import { replaceSyntax } from "../../source-mutation.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponseCache } from "../../../src/api/cache/index.js";
import type { CacheOutcome } from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { MAX_ENTRY_BYTES } from "../../../src/api/cache/resp.js";
import type { CacheStore } from "../../../src/api/cache/store.js";
import type { SqlSession } from "../../../src/db/database.js";
import { importMutant, withMutantFile } from "../../mutant-file.js";

const db = {
  query: async () => {
    throw Error("Unexpected SQL");
  },
} as unknown as SqlSession;
const accept = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const request = {
  namespace: "synthetic-public-dto",
  version: "synthetic-app-v1",
  generation: "synthetic-generation-1",
  query: { county: "48201", year: 2026 },
  authorized: () => true,
  accept,
  ttlSeconds: 60,
};
function harness(factory = createResponseCache) {
  const memory = new MemoryCache(4 * 1024 * 1024),
    stored: [string, string][] = [],
    outcomes: CacheOutcome[] = [];
  let reads = 0;
  const store: CacheStore = {
    bytes: () => memory.bytes(),
    get: async (key) => {
      reads++;
      return memory.get(key);
    },
    set: async (key, value, ttl) => {
      stored.push([key, value]);
      await memory.set(key, value, ttl);
    },
  };
  const cache = factory(db, undefined, { store });
  return {
    cache,
    stored,
    outcomes,
    reads: () => reads,
    read: (
      overrides = {},
      load = async () => ({ public_label: "Synthetic public DTO" }),
    ) =>
      cache.catalog(
        {
          ...request,
          outcome: (outcome) => outcomes.push(outcome),
          ...overrides,
        },
        load,
      ),
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("shared public DTO boundary", () => {
  it("keys by application version, namespace, generation and canonical filters", async () => {
    const h = harness();
    await h.read();
    await h.read({ query: { year: 2026, county: "48201" } });
    expect(h.outcomes).toEqual(["miss", "hit"]);
    await h.read({ generation: "synthetic-generation-2" });
    await h.read({ version: "synthetic-app-v2" });
    await h.read({ namespace: "synthetic-other-adapter" });
    await h.read({ query: { year: 2027, county: "48201" } });
    expect(new Set(h.stored.map(([key]) => key)).size).toBe(5);
  });
  it("checks authorization before a populated hit and never retains credentials or household fields", async () => {
    const h = harness();
    await h.read();
    const denied = await h.read({ authorized: () => false }, async () => ({
      public_label: "AUTH_REQUIRED",
    }));
    expect(denied.public_label).toBe("AUTH_REQUIRED");
    expect(h.reads()).toBe(1);
    for (const query of [
      { household: { income_annual: 41000 } },
      { members: [{ age: 35 }] },
      { nested: { household_size: 2 } },
      { authorization: "synthetic-secret" },
      { token: "synthetic-token" },
    ]) {
      await h.read({ query });
    }
    expect(h.reads()).toBe(1);
    expect(h.stored).toHaveLength(1);
    for (const payload of [
      { household_income_annual: 41000 },
      { nested: [{ age: 35 }] },
      { api_key: "synthetic-key" },
      { error: { code: "SYNTHETIC_FAILURE" } },
      { status: "error" },
      { prior_authorization: "synthetic-secret" },
    ]) {
      const isolated = harness();
      await isolated.cache.catalog(request, async () => payload);
      expect(isolated.stored).toEqual([]);
    }
    const degree = harness();
    await degree.cache.catalog(request, async () => ({
      providers: [{ credentials: ["MD"] }],
      prior_authorization: true,
      evidence: [{ prior_authorization: null }],
      error: null,
    }));
    expect(degree.stored).toHaveLength(1);
  });
  it("rejects oversized, error-bearing and invalid backend DTOs; a thrown load is never stored", async () => {
    const h = harness();
    await h.read({}, async () => ({
      public_label: "x".repeat(MAX_ENTRY_BYTES),
    }));
    expect(h.stored).toEqual([]);
    expect(h.outcomes).toEqual(["bypass"]);
    await expect(
      h.read({}, async () => {
        throw Error("Synthetic query failure");
      }),
    ).rejects.toThrow("Synthetic query failure");
    expect(h.stored).toEqual([]);
    for (const cached of [
      "invalid json",
      '{"error":{"code":"SYNTHETIC_FAILURE"}}',
      '{"household":{"size":2}}',
      "{}",
    ]) {
      let writes = 0;
      const cache = createResponseCache(db, undefined, {
        store: {
          bytes: () => 0,
          get: async () => cached,
          set: async () => {
            writes++;
          },
        },
      });
      const answer = await cache.catalog(
        {
          ...request,
          accept: (value): value is { public_label: string } =>
            accept(value) && typeof value.public_label === "string",
        },
        async () => ({ public_label: "Synthetic fresh DTO" }),
      );
      expect(answer.public_label).toBe("Synthetic fresh DTO");
      expect(writes).toBe(0);
    }
  });
});

// Each copy removes one guard. The positive contract must reject the changed behavior.
it.each([
  [
    "generation",
    "[request.namespace, request.version, request.generation, request.query]",
    "[request.namespace, request.version, request.query]",
  ],
  [
    "household",
    "function publicDto(value: unknown): boolean {",
    "function publicDto(value: unknown): boolean { return true;",
  ],
  ["error", "!(key === 'error' && child !== null)", "true"],
  ["authorization", "!request.authorized()", "false"],
] as const)(
  "negative control: removing %s protection fails its contract",
  async (kind, before, after) => {
    const source = new URL("../../../src/api/cache/index.ts", import.meta.url);
    const original = await readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(original, before, after),
      async (temporary) => {
        const mutant = await importMutant<{
          createResponseCache: typeof createResponseCache;
        }>(temporary, "createResponseCache");
        async function contract(factory: typeof createResponseCache) {
          const h = harness(factory);
          if (kind === "generation") {
            await h.read();
            await h.read({ generation: "synthetic-generation-2" });
            expect(h.outcomes).toEqual(["miss", "miss"]);
          } else if (kind === "authorization") {
            await h.read();
            const denied = await h.read(
              { authorized: () => false },
              async () => ({ public_label: "AUTH_REQUIRED" }),
            );
            expect(denied.public_label).toBe("AUTH_REQUIRED");
            expect(h.reads()).toBe(1);
          } else {
            await h.cache.catalog(request, async () =>
              kind === "household"
                ? {
                    public_label: "Synthetic public DTO",
                    household_income_annual: 41000,
                  }
                : { error: { code: "SYNTHETIC_FAILURE" } },
            );
            expect(h.stored).toEqual([]);
          }
        }
        await expect(contract(createResponseCache)).resolves.toBeUndefined();
        await expect(contract(mutant.createResponseCache)).rejects.toThrow();
      },
    );
  },
);
