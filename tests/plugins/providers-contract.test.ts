import { fileURLToPath } from "node:url";
import type { CacheStoreFactory } from "@openplans/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/index.js";
import { providerTables } from "../../src/plugins/providers.js";
import { checkCacheStore } from "../../src/plugins/testing/index.js";
import type { CacheStoreSubject } from "../../src/plugins/testing/index.js";
import { fakeResp } from "../api/cache/resp-fake.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const shipped = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const core = providerTables().cacheStores;
const passing = [
  { check: "ttl-expiry", ok: true },
  { check: "byte-accounting", ok: true },
  { check: "entry-bound", ok: true },
  { check: "failure-bypass", ok: true },
];
const verdicts = async (subject: CacheStoreSubject) =>
  (await checkCacheStore(subject)).map(({ check, ok }) => ({ check, ok }));
const failed = async (subject: CacheStoreSubject) =>
  (await checkCacheStore(subject))
    .filter((result) => !result.ok)
    .map((result) => result.check);

// Only Date is faked, so sockets and the contract's own call bounds keep real timers.
const advanceDate = (seconds: number) => {
  vi.setSystemTime(Date.now() + seconds * 1000);
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function syntheticFactory(): Promise<CacheStoreFactory> {
  const loaded = await loadPlugins(
    loadConfig(
      {},
      {
        version: 1,
        cache: { provider: "synthetic" },
        plugins: [{ package: "./synthetic-cache-store/index.mjs" }],
      },
    ),
    "api",
    {
      env: {},
      baseDirectory: fixtures,
      manifestPaths: [shipped],
      writeLog: () => {},
    },
  );
  return providerTables(loaded.registries).cacheStores.synthetic!;
}
const syntheticState = () =>
  (globalThis as { syntheticCacheStore?: { down: boolean } })
    .syntheticCacheStore!;

describe("cache store contract (design 5.7)", () => {
  it("passes for the memory provider", async () => {
    expect(
      await verdicts({ factory: core.memory!, advance: advanceDate }),
    ).toEqual(passing);
  });

  it("passes for the valkey provider against the in-process RESP fake", async () => {
    const server = await fakeResp();
    try {
      const results = await checkCacheStore({
        factory: core.valkey!,
        settings: { url: server.url },
        advance: server.advance,
        fail: server.close,
      });
      expect(results.map(({ check, ok }) => ({ check, ok }))).toEqual(passing);
      expect(results.at(-1)!.detail).toMatch(/bypass/);
    } finally {
      await server.close();
    }
  });

  it("passes for a synthetic third provider loaded as a plugin", async () => {
    const factory = await syntheticFactory();
    try {
      expect(
        await verdicts({
          factory,
          advance: advanceDate,
          fail: () => {
            syntheticState().down = true;
          },
        }),
      ).toEqual(passing);
    } finally {
      syntheticState().down = false;
    }
  });
});

describe("contract negative controls (planted store mutants)", () => {
  it("fails a store that ignores TTLs", async () => {
    const factory: CacheStoreFactory = ({ maxBytes }) => {
      const store = new MemoryCache(maxBytes);
      return {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value, 3600),
        bytes: () => store.bytes(),
      };
    };
    expect(await failed({ factory, advance: advanceDate })).toEqual([
      "ttl-expiry",
    ]);
  });

  it("fails a store that counts characters instead of UTF-8 bytes", async () => {
    const factory: CacheStoreFactory = ({ maxBytes }) => {
      const store = new MemoryCache(maxBytes);
      let chars = 0;
      return {
        get: (key) => store.get(key),
        set: async (key, value, ttl) => {
          chars += key.length + value.length;
          await store.set(key, value, ttl);
        },
        bytes: () => chars,
      };
    };
    expect(await failed({ factory, advance: advanceDate })).toEqual([
      "byte-accounting",
    ]);
  });

  it("fails a store that truncates entries below 2 MiB", async () => {
    const factory: CacheStoreFactory = ({ maxBytes }) => {
      const store = new MemoryCache(maxBytes);
      return {
        get: (key) => store.get(key),
        set: (key, value, ttl) => store.set(key, value.slice(0, 1 << 20), ttl),
        bytes: () => store.bytes(),
      };
    };
    expect(await failed({ factory, advance: advanceDate })).toEqual([
      "entry-bound",
    ]);
  });

  it("fails a store that hangs instead of failing", async () => {
    let down = false;
    const factory: CacheStoreFactory = ({ maxBytes }) => {
      const store = new MemoryCache(maxBytes);
      const hang = () => new Promise<never>(() => {});
      return {
        get: (key) => (down ? hang() : store.get(key)),
        set: (key, value, ttl) => (down ? hang() : store.set(key, value, ttl)),
        bytes: () => store.bytes(),
      };
    };
    expect(
      await failed({
        factory,
        advance: advanceDate,
        fail: () => {
          down = true;
        },
        timeoutMs: 50,
      }),
    ).toEqual(["failure-bypass"]);
  });

  it("fails a store whose failure is silent and serves stale data", async () => {
    let down = false;
    const factory: CacheStoreFactory = ({ maxBytes }) => {
      const store = new MemoryCache(maxBytes);
      return {
        // A broken backend that answers every read with a fixed, unrelated entry.
        get: async (key) =>
          down
            ? JSON.stringify({
                body: '{"stale":true}',
                headers: [["content-type", "application/json"]],
              })
            : store.get(key),
        set: (key, value, ttl) => store.set(key, value, ttl),
        bytes: () => store.bytes(),
      };
    };
    expect(
      await failed({
        factory,
        advance: advanceDate,
        fail: () => {
          down = true;
        },
      }),
    ).toEqual(["failure-bypass"]);
  });
});
