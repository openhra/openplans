import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import { loadConfig } from "../../src/config/index.js";
import { LocalBlobStore } from "../../src/fetch/blob/index.js";
import {
  providerTables,
  selectBlobStore,
} from "../../src/plugins/providers.js";
import type * as ProvidersModule from "../../src/plugins/providers.js";
import {
  restrictCacheLevel,
  runWithScope,
} from "../../src/plugins/request-scope.js";
import {
  checkBlobStore,
  plantMutant,
} from "../../src/plugins/testing/index.js";
import type { BlobStoreSubject } from "../../src/plugins/testing/index.js";

// Every key and payload below is synthetic.
const providersFile = new URL(
  "../../src/plugins/providers.ts",
  import.meta.url,
);
const payload = Buffer.from('{"synthetic":true}\n');
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function* chunks(...parts: Buffer[]) {
  for (const part of parts) yield part;
}
async function read(body: AsyncIterable<Uint8Array> | null) {
  if (!body) return null;
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
const allChecks = [
  "round-trip",
  "missing-key",
  "exclusive-put",
  "failed-put-leaves-no-key",
  "list-children",
  "publish-key",
  "publish-prefix",
  "publish-refuses-existing",
  "delete-key",
];
const verdicts = async (subject: BlobStoreSubject) =>
  Object.fromEntries(
    (await checkBlobStore(subject)).map(({ check, ok }) => [check, ok]),
  );
const passing = Object.fromEntries(allChecks.map((check) => [check, true]));

/**
 * A plugin-style store kept in memory, with no scope guard of its own: it writes whenever it is
 * asked. It follows the contract, so only the core wrap can stop a write in a restricted scope.
 */
class UnguardedStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { sha256?: string },
  ) {
    this.calls.push(`put ${key}`);
    const parts: Buffer[] = [];
    for await (const part of body) parts.push(Buffer.from(part));
    const data = Buffer.concat(parts);
    if (this.objects.has(key))
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    if (meta.sha256 && meta.sha256 !== sha(data))
      throw Object.assign(new Error("hash"), { code: "hash_mismatch" });
    this.objects.set(key, data);
    return { bytes: data.length, sha256: sha(data) };
  }
  async get(key: string) {
    const data = this.objects.get(key);
    return data ? chunks(data) : null;
  }
  async stat(key: string) {
    const data = this.objects.get(key);
    return data ? { bytes: data.length, sha256: sha(data) } : null;
  }
  async *list(prefix: string) {
    const seen = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const [head, ...rest] = key.slice(prefix.length + 1).split("/");
      const child = rest.length ? `${prefix}/${head}/` : `${prefix}/${head}`;
      if (!seen.has(child)) {
        seen.add(child);
        yield child;
      }
    }
  }
  async publish(temporaryKey: string, finalKey: string) {
    this.calls.push(`publish ${temporaryKey}`);
    const moves = [...this.objects.keys()]
      .filter(
        (key) => key === temporaryKey || key.startsWith(`${temporaryKey}/`),
      )
      .map((key) => [key, finalKey + key.slice(temporaryKey.length)] as const);
    if (!moves.length)
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (
      [...this.objects.keys()].some(
        (key) => key === finalKey || key.startsWith(`${finalKey}/`),
      )
    )
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    for (const [from, to] of moves) {
      this.objects.set(to, this.objects.get(from)!);
      this.objects.delete(from);
    }
  }
  async delete(key: string) {
    this.calls.push(`delete ${key}`);
    this.objects.delete(key);
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openplans-blob-guard-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const inScope = <T>(
  level: "none" | "request" | "memory" | "stored",
  fn: () => Promise<T>,
) =>
  runWithScope(async () => {
    restrictCacheLevel(level);
    return fn();
  });
const pluginConfig = () =>
  loadConfig(
    { OPENPLANS_DATA_DIR: root },
    { version: 1, blobs: { provider: "synthetic" } },
  );
function selectUnguarded(select: typeof selectBlobStore = selectBlobStore) {
  const inner = new UnguardedStore();
  const tables = providerTables(undefined, {
    blobStores: { synthetic: () => inner },
  });
  return { inner, store: select(pluginConfig(), tables) };
}

describe("blob store contract from the test kit", () => {
  it("passes for the core local store", async () => {
    expect(
      await verdicts({
        create: () => new LocalBlobStore(root),
        prepare: async (prefix) => {
          await mkdir(join(root, prefix), { recursive: true });
        },
      }),
    ).toEqual(passing);
  });

  it("passes for an unguarded plugin store, bare and behind the core wrap", async () => {
    expect(await verdicts({ create: () => new UnguardedStore() })).toEqual(
      passing,
    );
    expect(await verdicts({ create: () => selectUnguarded().store })).toEqual(
      passing,
    );
  });

  it("negative control: a store whose put replaces a key fails exclusive-put", async () => {
    class Replacing extends UnguardedStore {
      override async put(
        key: string,
        body: AsyncIterable<Uint8Array>,
        meta: { sha256?: string },
      ) {
        this.objects.delete(key);
        return super.put(key, body, meta);
      }
    }
    expect(await verdicts({ create: () => new Replacing() })).toEqual({
      ...passing,
      "exclusive-put": false,
    });
  });
});

describe("core scope wrap for plugin blob stores (design 5.10.4)", () => {
  it("the local store is handed out bare, so the fetch cache keeps its local paths", () => {
    const store = selectBlobStore(loadConfig({ OPENPLANS_DATA_DIR: root }));
    expect(store).toBeInstanceOf(LocalBlobStore);
  });

  it("a plugin store is handed out wrapped, with only the BlobStore methods", () => {
    const { inner, store } = selectUnguarded();
    expect(store).not.toBe(inner);
    expect(Object.keys(store).sort()).toEqual([
      "delete",
      "get",
      "list",
      "publish",
      "put",
      "stat",
    ]);
  });

  it.each(["none", "request"] as const)(
    "%s: put and publish are refused before the plugin store is called",
    async (level) => {
      const { inner, store } = selectUnguarded();
      await store.put("raw/x/payload.part", chunks(payload), {});
      inner.calls.length = 0;
      for (const write of [
        (): Promise<unknown> => store.put("raw/x/other", chunks(payload), {}),
        () => store.publish("raw/x/payload.part", "raw/x/payload"),
      ])
        await expect(inScope(level, write)).rejects.toMatchObject({
          code: "storage_forbidden",
        });
      expect(inner.calls).toEqual([]);
      expect([...inner.objects.keys()]).toEqual(["raw/x/payload.part"]);
      // Reads stay allowed.
      expect(
        await inScope(level, async () =>
          read(await store.get("raw/x/payload.part")),
        ),
      ).toEqual(payload);
      expect(
        await inScope(level, () => store.stat("raw/x/payload.part")),
      ).toMatchObject({ bytes: payload.length });
    },
  );

  it("memory, stored and no scope still write", async () => {
    const { inner, store } = selectUnguarded();
    await inScope("memory", () => store.put("raw/x/a", chunks(payload), {}));
    await inScope("stored", () => store.put("raw/x/b", chunks(payload), {}));
    await store.put("raw/x/c.part", chunks(payload), {});
    await store.publish("raw/x/c.part", "raw/x/c");
    expect([...inner.objects.keys()].sort()).toEqual([
      "raw/x/a",
      "raw/x/b",
      "raw/x/c",
    ]);
  });

  it("negative control: with the wrap removed a none-scope put reaches the plugin store", async () => {
    const mutant = await plantMutant(
      providersFile,
      "return factory === localBlobStoreFactory ? store : guardBlobStore(store);",
      "return store;",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof ProvidersModule;
      const { inner, store } = selectUnguarded(module.selectBlobStore);
      expect(store).toBe(inner);
      await inScope("none", () =>
        store.put("raw/x/payload", chunks(payload), {}),
      );
      expect([...inner.objects.keys()]).toEqual(["raw/x/payload"]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("negative control: with the wrap's scope check removed a request-scope publish reaches the plugin store", async () => {
    const mutant = await plantMutant(
      providersFile,
      "if (scopeForbidsStorage())",
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof ProvidersModule;
      const { inner, store } = selectUnguarded(module.selectBlobStore);
      await store.put("raw/x/payload.part", chunks(payload), {});
      await inScope("request", () =>
        store.publish("raw/x/payload.part", "raw/x/payload"),
      );
      expect(inner.calls).toContain("publish raw/x/payload.part");
      expect([...inner.objects.keys()]).toEqual(["raw/x/payload"]);
    } finally {
      await mutant.cleanup();
    }
  });
});
