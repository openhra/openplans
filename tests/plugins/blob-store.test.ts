import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import { loadConfig } from "../../src/config/index.js";
import {
  LocalBlobStore,
  RemoteFetchStore,
  asFetchBlobStore,
} from "../../src/fetch/blob/index.js";
import { FetchError, fetchToCache } from "../../src/fetch/index.js";
import type { FetchOptions, Transport } from "../../src/fetch/index.js";
import {
  restrictCacheLevel,
  runWithScope,
} from "../../src/plugins/request-scope.js";
import {
  providerTables,
  selectBlobStore,
  unknownProviders,
} from "../../src/plugins/providers.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import type * as LocalModule from "../../src/fetch/blob/local.js";
import type * as CacheModule from "../../src/fetch/cache.js";

const localFile = new URL("../../src/fetch/blob/local.ts", import.meta.url);
const cacheFile = new URL("../../src/fetch/cache.ts", import.meta.url);
const body = Buffer.from('{"synthetic":true}\n');

async function* chunks(...parts: (Buffer | Error)[]) {
  for (const part of parts) {
    if (part instanceof Error) throw part;
    yield part;
  }
}
async function collect(iterable: AsyncIterable<Uint8Array> | null) {
  if (!iterable) return null;
  const parts: Buffer[] = [];
  for await (const part of iterable) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
async function keys(store: BlobStore, prefix: string) {
  const result: string[] = [];
  for await (const key of store.list(prefix)) result.push(key);
  return result.sort();
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openplans-blob-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local blob store", () => {
  it("puts, reads, lists, publishes and aliases under the root", async () => {
    const store = new LocalBlobStore(root);
    const staged = await store.stage("raw/synthetic");
    expect(staged).toMatch(/^raw\/synthetic\/\.pending-[A-Za-z0-9]+$/);
    expect(
      await store.put(
        `${staged}/payload.part`,
        chunks(body.subarray(0, 4), body.subarray(4)),
      ),
    ).toEqual({
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    await store.publish(`${staged}/payload.part`, `${staged}/payload`);
    await store.publish(staged, "raw/synthetic/snap");
    await store.alias(
      "raw/synthetic/snap/payload",
      "raw/synthetic/snap.payload",
    );
    await store.alias(
      "raw/synthetic/snap/payload",
      "raw/synthetic/snap.payload",
    );
    expect(
      await collect(await store.get("raw/synthetic/snap/payload")),
    ).toEqual(body);
    expect(await store.stat("raw/synthetic/snap/payload")).toEqual({
      bytes: body.length,
      sha256: null,
    });
    expect(await store.get("raw/synthetic/absent")).toBeNull();
    expect(await store.get("raw/synthetic/snap.payload/meta.json")).toBeNull();
    expect(await store.stat("raw/synthetic/absent")).toBeNull();
    expect(await keys(store, "raw/synthetic")).toEqual([
      "raw/synthetic/snap.payload",
      "raw/synthetic/snap/",
    ]);
    expect(await keys(store, "raw/none")).toEqual([]);
    expect(store.localPath("raw/synthetic/snap/payload")).toBe(
      join(root, "raw", "synthetic", "snap", "payload"),
    );
    expect((await stat(join(root, "raw/synthetic/snap/payload"))).nlink).toBe(
      2,
    );
  });

  it("refuses keys that leave the root or are not plain segments", async () => {
    const store = new LocalBlobStore(root);
    for (const key of [
      "",
      "/abs",
      "a//b",
      "../x",
      "a/../b",
      "a/./b",
      "a\\b",
      "a/b/",
    ])
      expect(() => store.localPath(key)).toThrow("Invalid blob key");
    expect(() => new LocalBlobStore("relative")).toThrow(FetchError);
  });

  it("never replaces a key, and a failed or mismatched put leaves no key", async () => {
    const store = new LocalBlobStore(root);
    const staged = await store.stage("raw/synthetic");
    await store.put(`${staged}/a`, chunks(body));
    await expect(
      store.put(`${staged}/a`, chunks(Buffer.from("x"))),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await collect(await store.get(`${staged}/a`))).toEqual(body);
    await expect(
      store.put(
        `${staged}/b`,
        chunks(body, new Error("synthetic stream failure")),
      ),
    ).rejects.toThrow("synthetic stream failure");
    await expect(
      store.put(`${staged}/c`, chunks(body), { sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(await keys(store, staged)).toEqual([`${staged}/a`]);
    await store.discard(staged);
    expect(await keys(store, "raw/synthetic")).toEqual([]);
  });

  it("negative control: a put that keeps its partial file is caught", async () => {
    const mutant = await plantMutant(
      localFile,
      "if (!written) await this.fs.rm(path, { force: true });",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof LocalModule;
      const store = new module.LocalBlobStore(root);
      const staged = await store.stage("raw/synthetic");
      await expect(
        store.put(
          `${staged}/b`,
          chunks(body, new Error("synthetic stream failure")),
        ),
      ).rejects.toThrow();
      expect(await keys(store, staged)).toEqual([`${staged}/b`]);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("blob provider selection (config.blobs.provider)", () => {
  it("defaults to local, rooted at OPENPLANS_DATA_DIR", () => {
    const config = loadConfig({ OPENPLANS_DATA_DIR: root });
    expect(config.blobs.provider).toBe("local");
    const store = selectBlobStore(config);
    expect(store).toBeInstanceOf(LocalBlobStore);
    expect((store as LocalBlobStore).root).toBe(root);
    expect(unknownProviders(config, providerTables())).toEqual([]);
  });

  it("reports an unknown provider by setting path and refuses to select it", () => {
    const config = loadConfig(
      {},
      { version: 1, blobs: { provider: "absent" } },
    );
    expect(unknownProviders(config, providerTables())).toEqual([
      "blobs.provider",
    ]);
    expect(() => selectBlobStore(config)).toThrow("Unknown blob provider");
  });

  it("selects a provider a plugin registered", () => {
    const made: string[] = [];
    const tables = providerTables(undefined, {
      blobStores: {
        synthetic: ({ root: where }) => {
          made.push(where ?? "");
          return new LocalBlobStore(where!);
        },
      },
    });
    const config = loadConfig(
      { OPENPLANS_DATA_DIR: root },
      { version: 1, blobs: { provider: "synthetic" } },
    );
    expect(unknownProviders(config, tables)).toEqual([]);
    selectBlobStore(config, tables);
    expect(made).toEqual([root]);
  });

  it("a store without local paths runs behind RemoteFetchStore; local stores pass through", async () => {
    const sdkOnly: BlobStore = {
      put: async () => ({ bytes: 0, sha256: "" }),
      get: async () => null,
      stat: async () => null,
      list: async function* () {},
      publish: async () => {},
      delete: async () => {},
    };
    const wrapped = asFetchBlobStore(sdkOnly, root);
    expect(wrapped).toBeInstanceOf(RemoteFetchStore);
    expect((wrapped as RemoteFetchStore).store).toBe(sdkOnly);
    const local = new LocalBlobStore(root);
    expect(asFetchBlobStore(local, root)).toBe(local);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("no blob write in a none or request scope", () => {
  const transport: Transport = async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([body]),
  });
  class CountingStore extends LocalBlobStore {
    calls: string[] = [];
    override async stage(prefix: string) {
      this.calls.push("stage");
      return super.stage(prefix);
    }
    override async put(...args: Parameters<LocalBlobStore["put"]>) {
      this.calls.push("put");
      return super.put(...args);
    }
    override async publish(from: string, to: string) {
      this.calls.push("publish");
      return super.publish(from, to);
    }
    override async alias(key: string, aliasKey: string) {
      this.calls.push("alias");
      return super.alias(key, aliasKey);
    }
  }
  const optionsFor = (store: BlobStore): FetchOptions => ({
    source: "synthetic",
    allowHosts: ["publisher.test"],
    expectedContent: "json",
    dataDir: root,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport,
    maxAttempts: 1,
    blobStore: store,
  });
  const inScope = <T>(level: "none" | "request", fn: () => Promise<T>) =>
    runWithScope(async () => {
      restrictCacheLevel(level);
      return fn();
    });

  it.each(["none", "request"] as const)(
    "%s: fetchToCache never reaches the store, and the store refuses writes itself",
    async (level) => {
      const store = new CountingStore(root);
      await expect(
        inScope(level, () =>
          fetchToCache("https://publisher.test/file", optionsFor(store)),
        ),
      ).rejects.toMatchObject({ code: "storage_forbidden" });
      expect(store.calls).toEqual([]);
      for (const write of [
        (): Promise<unknown> => store.stage("raw/synthetic"),
        () => store.put("raw/x", chunks(body)),
        () => store.publish("raw/x", "raw/y"),
        () => store.alias("raw/x", "raw/y"),
      ])
        await expect(inScope(level, write)).rejects.toMatchObject({
          code: "storage_forbidden",
        });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("memory, stored and no level still write the snapshot", async () => {
    for (const level of ["memory", "stored"] as const) {
      const store = new CountingStore(root);
      const result = await runWithScope(async () => {
        restrictCacheLevel(level);
        return fetchToCache("https://publisher.test/file", optionsFor(store));
      });
      expect(result.outcome).toMatch(/downloaded|reused/);
    }
    const result = await fetchToCache(
      "https://publisher.test/file",
      optionsFor(new CountingStore(root)),
    );
    expect(result.outcome).toBe("reused");
  });

  it("negative control: without the fetch guard the store still keeps a none answer off disk", async () => {
    const mutant = await plantMutant(
      cacheFile,
      "if (scopeForbidsStorage())",
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof CacheModule;
      const store = new CountingStore(root);
      await expect(
        inScope("none", () =>
          module.fetchToCache("https://publisher.test/file", optionsFor(store)),
        ),
      ).rejects.toMatchObject({ code: "storage_forbidden" });
      // The guard is what keeps the store from being asked at all.
      expect(store.calls).toEqual(["stage"]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("the default store is the local tree", () => {
  it("fetchToCache without a blobStore writes under dataDir", async () => {
    const result = await fetchToCache("https://publisher.test/file", {
      source: "synthetic",
      allowHosts: ["publisher.test"],
      expectedContent: "json",
      dataDir: root,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({
        status: 200,
        headers: {},
        body: Readable.from([body]),
      }),
    });
    if (result.outcome === "not_modified")
      throw new Error("Expected a snapshot");
    expect(result.path).toBe(
      join(root, "raw", "synthetic", result.snapshotId, "payload"),
    );
    expect(await readFile(result.path)).toEqual(body);
  });
});
