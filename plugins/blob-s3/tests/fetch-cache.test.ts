import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import {
  RemoteFetchStore,
  configureHostBlobStore,
} from "../../../src/fetch/blob/index.js";
import type * as RemoteModule from "../../../src/fetch/blob/remote.js";
import {
  cachedPayloadPath,
  fetchToCache,
  readCachedText,
  sidecarNames,
} from "../../../src/fetch/index.js";
import { cachedHash } from "../../../src/ingest/geo/sources.js";
import type { FetchOptions, Transport } from "../../../src/fetch/index.js";
import { guardBlobStore } from "../../../src/plugins/providers.js";
import {
  restrictCacheLevel,
  runWithScope,
} from "../../../src/plugins/request-scope.js";
import {
  checkBlobStore,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { fixtures } from "../../../tests/fixtures/fetch/generate.mjs";
import { S3BlobStore } from "../src/store.js";
import { startFakeS3 } from "./fake-s3.js";
import type { FakeS3 } from "./fake-s3.js";

/** The fetch cache over the S3 store, against the loopback fake server. All data is synthetic. */
const remoteFile = new URL(
  "../../../src/fetch/blob/remote.ts",
  import.meta.url,
);
const body = Buffer.from('{"synthetic":true,"rows":[1,2,3]}\n');
const sha = createHash("sha256").update(body).digest("hex");
const url = "https://publisher.test/plans.json";
/** Same length as `body`, so only the hash can tell them apart. */
const other = Buffer.from(body.toString("utf8").replace("1", "7"));

let fake: FakeS3;
let root: string;
let requests: number;
const transport: Transport = async () => {
  requests++;
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([body]),
  };
};
const s3 = (partBytes?: number) =>
  new S3BlobStore({
    endpoint: fake.url,
    region: fake.region,
    bucket: fake.bucket,
    credentials: fake.credentials,
    ...(partBytes && { partBytes }),
  });
const pendingKeys = () =>
  objectKeys().filter((key) => key.includes(".pending-"));
const optionsFor = (
  store: BlobStore | undefined,
  extra: Partial<FetchOptions> = {},
): FetchOptions => ({
  source: "synthetic",
  allowHosts: ["publisher.test"],
  expectedContent: "json",
  dataDir: root,
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  transport,
  maxAttempts: 1,
  ...(store && { blobStore: store }),
  ...extra,
});
const objectKeys = () => [...fake.objects.keys()].sort();
async function files(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile())
      out.push(relative(root, join(entry.parentPath, entry.name)));
  return out.sort();
}
const inScope = <T>(level: "none" | "request", run: () => Promise<T>) =>
  runWithScope(async () => {
    restrictCacheLevel(level);
    return run();
  });

/** A store that fails one `publish` call, counted from 1, after passing the others through. */
function failingPublish(store: BlobStore, failAt: number): BlobStore {
  let calls = 0;
  return {
    put: (...args) => store.put(...args),
    get: (key) => store.get(key),
    stat: (key) => store.stat(key),
    list: (prefix) => store.list(prefix),
    delete: (key) => store.delete(key),
    async publish(from, to) {
      if (++calls === failAt)
        throw Object.assign(new Error("synthetic failure"), { code: "EIO" });
      return store.publish(from, to);
    },
  };
}
/** A consistent store whose `get` serves other bytes for payload keys: no hash error of its own. */
function swappedPayload(store: BlobStore): BlobStore {
  return {
    put: (...args) => store.put(...args),
    stat: (key) => store.stat(key),
    list: (prefix) => store.list(prefix),
    publish: (from, to) => store.publish(from, to),
    delete: (key) => store.delete(key),
    async get(key) {
      if (!key.endsWith("/payload")) return store.get(key);
      return Readable.from([other]);
    },
  };
}

beforeEach(async () => {
  fake = await startFakeS3();
  root = await mkdtemp(join(tmpdir(), "openplans-fetch-s3-"));
  requests = 0;
});
afterEach(async () => {
  configureHostBlobStore(undefined);
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

describe("fetch cache over the S3 store", () => {
  it("the store under test passes the kit's blob contract", async () => {
    expect(
      (await checkBlobStore({ create: s3 })).filter((result) => !result.ok),
    ).toEqual([]);
  });

  it("downloads into the same keys the local store writes, and reads them back", async () => {
    const result = await fetchToCache(url, optionsFor(guardBlobStore(s3())));
    expect(result).toMatchObject({ outcome: "downloaded", snapshotId: sha });
    if (result.outcome === "not_modified") throw new Error("unexpected");
    expect(objectKeys()).toEqual([
      `raw/synthetic/${sha}.meta.json`,
      `raw/synthetic/${sha}/meta.json`,
      `raw/synthetic/${sha}/payload`,
    ]);
    const meta = Buffer.from(`${JSON.stringify(result.metadata, null, 2)}\n`);
    expect(fake.objects.get(`raw/synthetic/${sha}/payload`)!.body).toEqual(
      body,
    );
    expect(fake.objects.get(`raw/synthetic/${sha}/meta.json`)!.body).toEqual(
      meta,
    );
    expect(fake.objects.get(`raw/synthetic/${sha}.meta.json`)!.body).toEqual(
      meta,
    );
    expect(result.metadata).toMatchObject({ sha256: sha, bytes: body.length });
    // The paths name verified local copies; the spool is empty and no local raw tree exists.
    expect(await readFile(result.path)).toEqual(body);
    expect(await readFile(result.metadataPath)).toEqual(meta);
    expect(await files(root)).toEqual([
      `blob-read/raw/synthetic/${sha}.meta.json`,
      `blob-read/raw/synthetic/${sha}/payload`,
    ]);
    // Credentials never reach a result, a stored object or a local file.
    const secret = fake.credentials.secretAccessKey;
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const object of fake.objects.values())
      expect(object.body.toString("latin1")).not.toContain(secret);
  });

  it("reuses a stored snapshot with no request, reading it back through the store", async () => {
    await fetchToCache(url, optionsFor(s3()));
    await rm(join(root, "blob-read"), { recursive: true });
    const before = objectKeys();
    const hit = await fetchToCache(
      url,
      optionsFor(s3(), { expectedSha256: sha }),
    );
    expect(hit).toMatchObject({ outcome: "reused", snapshotId: sha });
    if (hit.outcome === "not_modified") throw new Error("unexpected");
    expect(requests).toBe(1);
    expect(await readFile(hit.path)).toEqual(body);
    // A second download of the same bytes finds the snapshot and writes nothing new.
    const again = await fetchToCache(url, optionsFor(s3()));
    expect(again.outcome).toBe("reused");
    expect(objectKeys()).toEqual(before);
  });

  it("inspects a ZIP from the spool on download and from the read copy on reuse", async () => {
    const zip = fixtures.valid() as Buffer;
    const zipSha = createHash("sha256").update(zip).digest("hex");
    const zipTransport: Transport = async () => {
      requests++;
      return {
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([zip]),
      };
    };
    const zipOptions = (extra: Partial<FetchOptions> = {}) =>
      optionsFor(s3(), {
        expectedContent: "zip",
        transport: zipTransport,
        ...extra,
      });
    const first = await fetchToCache(url, zipOptions());
    expect(first.outcome).toBe("downloaded");
    await rm(join(root, "blob-read"), { recursive: true });
    const hit = await fetchToCache(url, zipOptions({ expectedSha256: zipSha }));
    if (hit.outcome === "not_modified") throw new Error("unexpected");
    expect(hit.outcome).toBe("reused");
    expect(await readFile(hit.path)).toEqual(zip);
    expect(requests).toBe(1);
    const bomb = fixtures.bomb() as Buffer;
    await expect(
      fetchToCache(
        url,
        optionsFor(s3(), {
          expectedContent: "zip",
          transport: async () => ({
            status: 200,
            headers: { "content-type": "application/zip" },
            body: Readable.from([bomb]),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^zip_/) });
    expect(
      objectKeys().every(
        (key) => !key.includes(createHash("sha256").update(bomb).digest("hex")),
      ),
    ).toBe(true);
  });

  it("stores a payload over one part as a multipart upload and reuses it", async () => {
    const large = Buffer.alloc(11 * 1024 ** 2 + 17, 0x61);
    const largeSha = createHash("sha256").update(large).digest("hex");
    const largeTransport: Transport = async () => {
      requests++;
      return {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: Readable.from([large]),
      };
    };
    const options = (extra: Partial<FetchOptions> = {}) =>
      optionsFor(guardBlobStore(s3(5 * 1024 ** 2)), {
        expectedContent: "binary",
        transport: largeTransport,
        ...extra,
      });
    const result = await fetchToCache(url, options());
    expect(result).toMatchObject({
      outcome: "downloaded",
      snapshotId: largeSha,
    });
    expect(
      fake.requests.filter((request) => request.query.startsWith("partNumber")),
    ).toHaveLength(3);
    expect(
      fake.objects.get(`raw/synthetic/${largeSha}/payload`)!.body.equals(large),
    ).toBe(true);
    expect(fake.uploads.size).toBe(0);
    expect(pendingKeys()).toEqual([]);
    await rm(join(root, "blob-read"), { recursive: true });
    const hit = await fetchToCache(url, options({ expectedSha256: largeSha }));
    expect(hit.outcome).toBe("reused");
    if (hit.outcome === "not_modified") throw new Error("unexpected");
    expect(requests).toBe(1);
    expect((await readFile(hit.path)).equals(large)).toBe(true);
  });

  it("uses the host's configured store when a call names none", async () => {
    configureHostBlobStore(guardBlobStore(s3()));
    const result = await fetchToCache(url, optionsFor(undefined));
    expect(result.outcome).toBe("downloaded");
    expect(objectKeys()).toContain(`raw/synthetic/${sha}/payload`);
  });

  it("refuses stored bytes that differ from the recorded hash", async () => {
    await fetchToCache(url, optionsFor(s3()));
    await rm(join(root, "blob-read"), { recursive: true });
    fake.objects.get(`raw/synthetic/${sha}/payload`)!.body = other;
    await expect(
      fetchToCache(url, optionsFor(s3(), { expectedSha256: sha })),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(await files(root)).toEqual([]);
  });

  it("refuses a read-back that differs from the download", async () => {
    await expect(
      fetchToCache(url, optionsFor(swappedPayload(s3()))),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(await files(root)).toEqual([]);
  });

  it("negative control: a read-back without the hash check hands out other bytes", async () => {
    const mutant = await plantMutant(
      remoteFile,
      'bytes !== expected.bytes || hash.digest("hex") !== expected.sha256',
      "false",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RemoteModule;
      const result = await fetchToCache(
        url,
        optionsFor(new module.RemoteFetchStore(swappedPayload(s3()), root)),
      );
      if (result.outcome === "not_modified") throw new Error("unexpected");
      expect(await readFile(result.path)).not.toEqual(body);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("atomic visibility", () => {
  it("a failed publish leaves no snapshot a reader can find, and a retry completes it", async () => {
    // Publish 1 moves the payload, 2 moves meta.json: fail the second.
    await expect(
      fetchToCache(url, optionsFor(failingPublish(s3(), 2))),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(fake.objects.has(`raw/synthetic/${sha}/meta.json`)).toBe(false);
    expect(fake.objects.has(`raw/synthetic/${sha}.meta.json`)).toBe(false);
    expect(await files(root)).toEqual([]);
    // The unpublished meta.json was deleted; the published payload stays for the retry to adopt.
    expect(pendingKeys()).toEqual([]);
    expect(objectKeys()).toEqual([`raw/synthetic/${sha}/payload`]);
    // A hash-pinned read finds nothing to reuse and downloads again.
    const retry = await fetchToCache(
      url,
      optionsFor(s3(), { expectedSha256: sha }),
    );
    expect(retry.outcome).toBe("downloaded");
    expect(requests).toBe(2);
    expect(objectKeys()).toEqual([
      `raw/synthetic/${sha}.meta.json`,
      `raw/synthetic/${sha}/meta.json`,
      `raw/synthetic/${sha}/payload`,
    ]);
  });

  it("a failed payload publish leaves no key at the snapshot", async () => {
    await expect(
      fetchToCache(url, optionsFor(failingPublish(s3(), 1))),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(
      objectKeys().filter((key) => key.startsWith(`raw/synthetic/${sha}`)),
    ).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it("negative control: without the cleanup a failed publish leaves .pending- objects", async () => {
    const mutant = await plantMutant(
      remoteFile,
      "await this.removePending(pending);",
      "void pending;",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RemoteModule;
      await expect(
        fetchToCache(
          url,
          optionsFor(
            new module.RemoteFetchStore(failingPublish(s3(), 2), root),
          ),
        ),
      ).rejects.toThrow();
      expect(pendingKeys()).toHaveLength(1);
    } finally {
      await mutant.cleanup();
    }
  });

  it("deletes only its own temporary keys, never a published one", async () => {
    await fetchToCache(url, optionsFor(s3()));
    const remote = new RemoteFetchStore(s3(), root);
    await expect(
      remote.delete(`raw/synthetic/${sha}/payload`),
    ).rejects.toMatchObject({ code: "cache_error" });
    await expect(
      remote.delete(`raw/synthetic/${sha}.meta.json`),
    ).rejects.toMatchObject({ code: "cache_error" });
    expect(objectKeys()).toHaveLength(3);
    const staged = await remote.stage("raw/synthetic");
    await remote.put(`${staged}/payload`, Readable.from([body]));
    await remote.delete(`${staged}/payload`);
    expect(await remote.stat(`${staged}/payload`)).toBeNull();
    expect(objectKeys()).toHaveLength(3);
  });

  it("negative control: publishing meta.json first leaves a partial snapshot visible", async () => {
    const mutant = await plantMutant(
      remoteFile,
      "Number(a === commitName) - Number(b === commitName)",
      "Number(b === commitName) - Number(a === commitName)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RemoteModule;
      await expect(
        fetchToCache(
          url,
          optionsFor(
            new module.RemoteFetchStore(failingPublish(s3(), 2), root),
          ),
        ),
      ).rejects.toThrow();
      expect(fake.objects.has(`raw/synthetic/${sha}/meta.json`)).toBe(true);
      expect(fake.objects.has(`raw/synthetic/${sha}/payload`)).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("no write in a none or request scope", () => {
  /** An unguarded plugin store that records every call. */
  function counting(store: BlobStore) {
    const calls: string[] = [];
    const counted: BlobStore = {
      put: (...args) => (calls.push("put"), store.put(...args)),
      get: (key) => (calls.push("get"), store.get(key)),
      stat: (key) => (calls.push("stat"), store.stat(key)),
      list: (prefix) => (calls.push("list"), store.list(prefix)),
      publish: (from, to) => (calls.push("publish"), store.publish(from, to)),
      delete: (key) => (calls.push("delete"), store.delete(key)),
    };
    return { calls, store: counted };
  }

  it.each(["none", "request"] as const)(
    "%s: fetchToCache and every remote write refuse before the store or disk",
    async (level) => {
      const { calls, store } = counting(s3());
      await expect(
        inScope(level, () => fetchToCache(url, optionsFor(store))),
      ).rejects.toMatchObject({ code: "storage_forbidden" });
      const remote = new RemoteFetchStore(store, root);
      const staged = await remote.stage("raw/synthetic");
      await remote.put(`${staged}/payload`, Readable.from([body]), {});
      for (const write of [
        (): Promise<unknown> => remote.stage("raw/synthetic"),
        () => remote.put("raw/synthetic/x", Readable.from([body]), {}),
        () => remote.publish(staged, `raw/synthetic/${sha}`),
        () => remote.alias("raw/synthetic/x", "raw/synthetic/y"),
        () => remote.materialize("raw/synthetic/x"),
      ])
        await expect(inScope(level, write)).rejects.toMatchObject({
          code: "storage_forbidden",
        });
      expect(calls).toEqual([]);
      expect(fake.requests).toEqual([]);
      expect(await files(join(root, "blob-spool"))).toEqual([
        `blob-spool/${staged}/payload`,
      ]);
    },
  );

  it("negative control: without its guard, publish uploads inside a none scope", async () => {
    const mutant = await plantMutant(
      remoteFile,
      "return this.spool.publish(temporaryKey, finalKey);\n    refuseInRestrictedScope();",
      "return this.spool.publish(temporaryKey, finalKey);",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RemoteModule;
      const { calls, store } = counting(s3());
      const remote = new module.RemoteFetchStore(store, root);
      const staged = await remote.stage("raw/synthetic");
      await remote.put(`${staged}/payload`, Readable.from([body]), {});
      await inScope("none", () =>
        remote.publish(staged, `raw/synthetic/${sha}`),
      ).catch(() => {});
      expect(calls).toContain("put");
      expect(fake.objects.has(`raw/synthetic/${sha}/payload`)).toBe(true);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("snapshot reads outside fetchToCache", () => {
  it("resolve sidecars and payloads through a remote store", async () => {
    const result = await fetchToCache(url, optionsFor(s3()));
    if (result.outcome === "not_modified") throw new Error("unexpected");
    await rm(join(root, "blob-read"), { recursive: true });
    const read = { blobStore: s3() };
    expect(await sidecarNames(root, "synthetic", read)).toEqual([
      `${sha}.meta.json`,
    ]);
    expect(
      JSON.parse(
        await readCachedText(root, "synthetic", `${sha}.meta.json`, read),
      ),
    ).toEqual(result.metadata);
    const path = await cachedPayloadPath(
      root,
      "synthetic",
      sha,
      { bytes: body.length, sha256: sha },
      read,
    );
    expect(path).toBe(
      join(root, "blob-read", "raw", "synthetic", sha, "payload"),
    );
    expect(await readFile(path)).toEqual(body);
    // A copy that differs from the expected hash is refused.
    await rm(path);
    await expect(
      cachedPayloadPath(
        root,
        "synthetic",
        sha,
        { bytes: body.length, sha256: "0".repeat(64) },
        read,
      ),
    ).rejects.toMatchObject({ code: "cache_error" });
  });

  it("an ingest lookup finds a snapshot held only in the host's remote store", async () => {
    configureHostBlobStore(s3());
    await fetchToCache(url, optionsFor(undefined));
    expect(await files(root)).not.toContain(`raw/synthetic/${sha}.meta.json`);
    expect(await cachedHash(root, "synthetic", url)).toBe(sha);
    configureHostBlobStore(undefined);
    expect(await cachedHash(root, "synthetic", url)).toBeUndefined();
  });

  it("with the local store the payload path is the cached file under raw/", async () => {
    await fetchToCache(url, optionsFor(undefined));
    expect(await cachedPayloadPath(root, "synthetic", sha)).toBe(
      join(root, "raw", "synthetic", sha, "payload"),
    );
    expect(await sidecarNames(root, "synthetic")).toEqual([`${sha}.meta.json`]);
    expect(await cachedHash(root, "synthetic", url)).toBe(sha);
  });
});
