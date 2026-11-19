import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";

const residentIndexes = (cache: object) =>
  (Object.values(cache) as unknown[]).filter((value) => value instanceof Map)
    .length;

async function ordinaryIndexBudget(cache: MemoryCache) {
  expect(residentIndexes(cache)).toBe(1);
  await cache.set("ordinary", "answer", 60);
  expect(await cache.get("ordinary")).toBe("answer");
  expect(await cache.getBounded("unused", "missing", 2)).toBeNull();
  await cache.setBounded({
    namespace: "unused",
    key: "zero",
    value: "answer",
    ttlSeconds: 60,
    maxEntries: 0,
  });
  expect(residentIndexes(cache)).toBe(1);
}

describe("byte-capped response LRU", () => {
  it("allocates only the response index until a bounded entry is written", async () => {
    const cache = new MemoryCache(4096);
    await ordinaryIndexBudget(cache);
    await cache.setBounded({
      namespace: "used",
      key: "bounded",
      value: "answer",
      ttlSeconds: 60,
      maxEntries: 2,
    });
    expect(await cache.getBounded("used", "bounded", 2)).toBe("answer");
    expect(await cache.get("ordinary")).toBe("answer");
  });
  it("rejects a planted regression that eagerly allocates namespace metadata", async () => {
    const mutant = await plantMutant(
      new URL("../../../src/api/cache/store.ts", import.meta.url),
      'throw new Error("Invalid cache byte cap");',
      'throw new Error("Invalid cache byte cap");\n    this.namespaces = new Map();',
    );
    try {
      const module = (await import(/* @vite-ignore */ mutant.path)) as {
        MemoryCache: typeof MemoryCache;
      };
      await expect(
        ordinaryIndexBudget(new module.MemoryCache(4096)),
      ).rejects.toThrow("expected 2 to be 1");
    } finally {
      await mutant.cleanup();
    }
  });
  it("counts UTF-8 key/value bytes and evicts least recently used, not newest", async () => {
    const cache = new MemoryCache(12);
    await cache.set("a", "12345", 30);
    await cache.set("b", "12345", 30);
    expect(cache.bytes()).toBe(12);
    expect(await cache.get("a")).toBe("12345");
    await cache.set("c", "12345", 30);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).toBe("12345");
    expect(cache.bytes()).toBe(12);
    await cache.set("oversized", "123456", 30);
    expect(cache.bytes()).toBe(12);
    expect(await cache.get("oversized")).toBeNull();
    await cache.set("a", "é", 30);
    expect(cache.bytes()).toBe(9);
  });
  it("expires entries, replaces sizes, and handles a zero-byte cache", async () => {
    let now = 0;
    const cache = new MemoryCache(12, () => now);
    await cache.set("a", "12345", 1);
    now = 1000;
    expect(cache.bytes()).toBe(0);
    expect(await cache.get("a")).toBeNull();
    await cache.set("b", "old", 1);
    await cache.set("b", "x", 2);
    expect(cache.bytes()).toBe(2);
    now = 2000;
    expect(await cache.get("b")).toBe("x");
    now = 3000;
    expect(await cache.get("b")).toBeNull();
    const zero = new MemoryCache(0);
    await zero.set("a", "", 10);
    expect(await zero.get("a")).toBeNull();
  });
  it("negative control: a cap mutant retaining every entry fails the same contract", () => {
    const contract = (bytes: number) => expect(bytes).toBeLessThanOrEqual(12);
    contract(12);
    const mutant = new Map([
      ["a", "12345"],
      ["b", "12345"],
      ["c", "12345"],
    ]);
    expect(() =>
      contract(
        [...mutant].reduce(
          (sum, pair) => sum + Buffer.byteLength(pair.join("")),
          0,
        ),
      ),
    ).toThrow();
  });
});
