import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CacheStore } from "@openplans/plugin-sdk";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { MAX_ENTRY_BYTES, RespCache } from "../../../src/api/cache/resp.js";
import { checkBoundedNamespace } from "../../../src/api/cache/contract.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";

// All values and source namespaces in this file are synthetic.
const namespace = () => `synthetic-bounded-${randomUUID()}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const memory = () => {
  let now = 0;
  const store = new MemoryCache(8 * 1024 ** 2, () => now);
  return {
    store,
    peer: store,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    namespace: namespace(),
  };
};
it("memory: overflow, replacement, expiry, isolation, reduced caps and concurrent writes", async () => {
  await checkBoundedNamespace(memory());
});
it("global byte eviction removes namespace metadata, including on replacement and expiry", async () => {
  const store = new MemoryCache(200);
  const put = (key: string, value = "x") =>
    store.setBounded({
      namespace: "a",
      key,
      value,
      maxEntries: 2,
      ttlSeconds: 60,
    });
  await put("a");
  await put("b");
  await store.set("unrelated", "x".repeat(190), 60);
  await put("c");
  expect(await store.getBounded("a", "c", 2)).toBe("x");
  expect(await store.getBounded("a", "a", 2)).toBeNull();
  await put("c", "x".repeat(300));
  expect(await store.getBounded("a", "c", 2)).toBe("x");
  expect(store.bytes()).toBeLessThanOrEqual(200);
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid cap %s before modifying memory",
  async (cap) => {
    const { store } = memory();
    await store.setBounded({
      namespace: "a",
      key: "a",
      value: "a",
      ttlSeconds: 60,
      maxEntries: 1,
    });
    await expect(store.getBounded("a", "a", cap)).rejects.toThrow();
    await expect(
      store.setBounded({
        namespace: "a",
        key: "b",
        value: "b",
        ttlSeconds: 60,
        maxEntries: cap,
      }),
    ).rejects.toThrow();
    expect(await store.getBounded("a", "a", 1)).toBe("a");
  },
);
it("a planted memory mutant without eviction fails the contract", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/api/cache/store.ts", import.meta.url),
    "while (members && members.size > maxEntries)",
    "while (false && members && members.size > maxEntries)",
  );
  cleanups.push(mutant.cleanup);
  const module = (await import(/* @vite-ignore */ mutant.path)) as {
    MemoryCache: typeof MemoryCache;
  };
  const store = new module.MemoryCache(8 * 1024 ** 2);
  await expect(
    checkBoundedNamespace({
      store,
      peer: store,
      namespace: namespace(),
      advance: () => {},
    }),
  ).rejects.toThrow("overflow");
});

it.each([
  [
    "expired entries spend capacity",
    "this.bytes();\n    const members = this.namespaces?.get(namespace);",
    "void 0;\n    const members = this.namespaces?.get(namespace);",
    "expired entries free capacity",
  ],
  [
    "a write extends other entries' TTLs",
    "this.remove(physical);",
    "if (this.entries.has(physical)) for (const entry of this.entries.values()) entry.expires = this.now() + ttlSeconds * 1000;\n    this.remove(physical);",
    "replacement must not extend another TTL",
  ],
  [
    "replacement keeps its old write position",
    "this.remove(physical);",
    "void physical;",
    "replacement spends one slot",
  ],
] as const)(
  "a planted memory mutant fails: %s",
  async (_name, before, after, reason) => {
    const mutant = await plantMutant(
      new URL("../../../src/api/cache/store.ts", import.meta.url),
      before,
      after,
    );
    cleanups.push(mutant.cleanup);
    const module = (await import(/* @vite-ignore */ mutant.path)) as {
      MemoryCache: typeof MemoryCache;
    };
    let now = 0;
    const store = new module.MemoryCache(8 * 1024 ** 2, () => now);
    await expect(
      checkBoundedNamespace({
        store,
        peer: store,
        namespace: namespace(),
        advance: (seconds) => {
          now += seconds * 1000;
        },
      }),
    ).rejects.toThrow(reason);
  },
);
it("a planted store mutant sharing every source's budget fails isolation", async () => {
  const h = memory(),
    store = h.store;
  const mutant: CacheStore = {
    get: store.get.bind(store),
    set: store.set.bind(store),
    bytes: store.bytes.bind(store),
    getBounded: (_namespace, key, cap) => store.getBounded("shared", key, cap),
    setBounded: (input) => store.setBounded({ ...input, namespace: "shared" }),
  };
  await expect(
    checkBoundedNamespace({ ...h, store: mutant, peer: mutant }),
  ).rejects.toThrow("namespace isolation");
});
it("a planted store mutant double-counting replacement fails the replacement check", async () => {
  const h = memory(),
    store = h.store;
  const mutant: CacheStore = {
    get: store.get.bind(store),
    set: store.set.bind(store),
    bytes: store.bytes.bind(store),
    getBounded: store.getBounded.bind(store),
    setBounded: async (input) => {
      const replaced = await store.getBounded(
        input.namespace,
        input.key,
        input.maxEntries,
      );
      await store.setBounded({
        ...input,
        maxEntries: input.maxEntries - (replaced ? 1 : 0),
      });
    },
  };
  await expect(
    checkBoundedNamespace({ ...h, store: mutant, peer: mutant }),
  ).rejects.toThrow("replacement spends one slot");
});

// A separate lane run supplies an isolated backend. Offline CI still runs all memory controls.
const remote = process.env.OPENPLANS_TEST_BOUNDED_CACHE_URL;
describe.skipIf(!remote)("real disposable remote bounded cache", () => {
  const client = () => new RespCache(remote!, 2_000);
  it("uses independent clients and server time for the full contract", async () => {
    await checkBoundedNamespace({
      store: client(),
      peer: client(),
      namespace: namespace(),
      advance: (seconds) =>
        new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    });
  });
  it("bounds authoritative contents before any read can trim them", async () => {
    const ns = namespace();
    await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        client().setBounded({
          namespace: ns,
          key: `parallel-${i}`,
          value: "synthetic",
          ttlSeconds: 60,
          maxEntries: 3,
        }),
      ),
    );
    const store = client();
    const command = (
      store as unknown as { command(parts: string[]): Promise<string | null> }
    ).command.bind(store);
    const bucket = `openplans:bounded:v1:${createHash("sha256").update(ns).digest("hex")}`;
    expect(
      await command([
        "EVAL",
        "return tostring(redis.call('HLEN', KEYS[1]))",
        "1",
        bucket,
      ]),
    ).toBe("4");
    await client().getBounded(ns, "absent", 1);
    expect(
      await command([
        "EVAL",
        "return tostring(redis.call('HLEN', KEYS[1]))",
        "1",
        bucket,
      ]),
    ).toBe("2");
  });
  it("rejects missing metadata rather than publishing an unindexed answer", async () => {
    const ns = namespace(),
      store = client();
    const input = {
      namespace: ns,
      key: "a",
      value: "synthetic",
      ttlSeconds: 60,
      maxEntries: 1,
    };
    await store.setBounded(input);
    const bucket = `openplans:bounded:v1:${createHash("sha256").update(ns).digest("hex")}`;
    const command = (
      store as unknown as { command(parts: string[]): Promise<string | null> }
    ).command.bind(store);
    await command([
      "EVAL",
      "redis.call('HDEL', KEYS[1], 'index'); return 'OK'",
      "1",
      bucket,
    ]);
    await expect(client().setBounded({ ...input, key: "b" })).rejects.toThrow();
    expect(
      await command([
        "EVAL",
        "return tostring(redis.call('HLEN', KEYS[1]))",
        "1",
        bucket,
      ]),
    ).toBe("1");
  });
  it("survives client restart and whole-container eviction without orphan payloads", async () => {
    const ns = namespace(),
      store = client();
    await store.setBounded({
      namespace: ns,
      key: "a",
      value: "a",
      ttlSeconds: 60,
      maxEntries: 2,
    });
    await client().setBounded({
      namespace: ns,
      key: "b",
      value: "b",
      ttlSeconds: 60,
      maxEntries: 2,
    });
    expect(await client().getBounded(ns, "a", 1)).toBeNull();
    const bucket = `openplans:bounded:v1:${createHash("sha256").update(ns).digest("hex")}`;
    // A backend eviction removes the same physical hash as DEL. No separate index exists.
    const command = (
      store as unknown as { command(parts: string[]): Promise<string | null> }
    ).command.bind(store);
    expect(
      await command([
        "EVAL",
        "return tostring(redis.call('HLEN', KEYS[1]))",
        "1",
        bucket,
      ]),
    ).toBe("2");
    await command([
      "EVAL",
      "redis.call('DEL', KEYS[1]); return 'OK'",
      "1",
      bucket,
    ]);
    expect(await client().getBounded(ns, "b", 2)).toBeNull();
    await client().setBounded({
      namespace: ns,
      key: "c",
      value: "c",
      ttlSeconds: 60,
      maxEntries: 1,
    });
    expect(
      await command([
        "EVAL",
        "return tostring(redis.call('HLEN', KEYS[1]))",
        "1",
        bucket,
      ]),
    ).toBe("2");
  });
  it("retains 2 MiB answers and leaves an existing value intact on oversized/invalid writes", async () => {
    const ns = namespace(),
      store = client();
    const input = {
      namespace: ns,
      key: "a",
      value: "x".repeat(MAX_ENTRY_BYTES),
      ttlSeconds: 60,
      maxEntries: 2,
    };
    await store.setBounded(input);
    expect(await store.getBounded(ns, "a", 2)).toBe(input.value);
    await store.setBounded({
      ...input,
      value: "y".repeat(MAX_ENTRY_BYTES + 1),
    });
    await expect(
      store.setBounded({ ...input, ttlSeconds: Infinity }),
    ).rejects.toThrow();
    await expect(store.getBounded(ns, "a", -1)).rejects.toThrow();
    expect(await store.getBounded(ns, "a", 2)).toBe(input.value);
  });
  it("a planted Lua mutant without capacity enforcement fails against the server", async () => {
    const target = new URL("../../../src/api/cache/resp.ts", import.meta.url);
    const script = (await readFile(target, "utf8")).match(
      /function boundedScript\(\)\s*\{\s*return (`[\s\S]+?`);/,
    )?.[1];
    if (!script) throw new Error("Missing bounded script");
    const mutant = await plantMutant(
      target,
      script,
      script.replace("(#live - first + 1) > cap", "false"),
    );
    cleanups.push(mutant.cleanup);
    const module = (await import(/* @vite-ignore */ mutant.path)) as {
      RespCache: typeof RespCache;
    };
    const store: CacheStore = new module.RespCache(remote!, 2_000);
    await expect(
      checkBoundedNamespace({
        store,
        peer: new module.RespCache(remote!, 2_000),
        namespace: namespace(),
        advance: () => {},
      }),
    ).rejects.toThrow("overflow");
  });
});

const evictionRemote = process.env.OPENPLANS_TEST_BOUNDED_EVICTION_CACHE_URL;
it.skipIf(!evictionRemote)(
  "actual server memory pressure evicts payload and metadata together",
  async () => {
    const store = new RespCache(evictionRemote!, 2_000),
      ns = namespace();
    const command = (
      store as unknown as { command(parts: string[]): Promise<string | null> }
    ).command.bind(store);
    await store.setBounded({
      namespace: ns,
      key: "a",
      value: "synthetic",
      ttlSeconds: 60,
      maxEntries: 1,
    });
    const before = await command(["INFO", "stats"]);
    await command(["CONFIG", "SET", "maxmemory", "1"]);
    try {
      await command(["GET", "synthetic-trigger-eviction"]);
    } finally {
      await command(["CONFIG", "SET", "maxmemory", "33554432"]);
    }
    const after = await command(["INFO", "stats"]);
    const evictions = (stats: string | null) =>
      Number(stats?.match(/evicted_keys:(\d+)/)?.[1]);
    expect(evictions(after)).toBeGreaterThan(evictions(before));
    expect(await store.getBounded(ns, "a", 1)).toBeNull();
    await store.setBounded({
      namespace: ns,
      key: "b",
      value: "synthetic",
      ttlSeconds: 60,
      maxEntries: 1,
    });
    expect(await store.getBounded(ns, "b", 1)).toBe("synthetic");
  },
);
it("a planted store mutant charging replacement twice fails the replacement check", async () => {
  const h = memory(),
    backing = h.store;
  const store: CacheStore = {
    get: backing.get.bind(backing),
    set: backing.set.bind(backing),
    bytes: backing.bytes.bind(backing),
    getBounded: backing.getBounded.bind(backing),
    setBounded: async (input) => {
      const existing = await backing.getBounded(
        input.namespace,
        input.key,
        input.maxEntries,
      );
      await backing.setBounded({
        ...input,
        maxEntries:
          existing === null
            ? input.maxEntries
            : Math.max(0, input.maxEntries - 1),
      });
    },
  };
  await expect(
    checkBoundedNamespace({ ...h, store, peer: store }),
  ).rejects.toThrow("replacement spends one slot");
});
