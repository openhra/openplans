import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../../src/api/cache/store.js";

describe("byte-capped response LRU", () => {
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
