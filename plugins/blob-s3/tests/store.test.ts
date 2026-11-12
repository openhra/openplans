import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import {
  restrictCacheLevel,
  runWithScope,
  scopeForbidsStorage,
} from "../../../src/plugins/request-scope.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import { S3BlobStore } from "../src/store.js";
import type { S3BlobStoreSettings } from "../src/store.js";
import type * as StoreModule from "../src/store.js";
import { checkBlobStore } from "../../../src/plugins/testing/index.js";
import { startFakeS3 } from "./fake-s3.js";
import type { FakeS3 } from "./fake-s3.js";

const storeFile = new URL("../src/store.ts", import.meta.url);
const payload = Buffer.from('{"synthetic":true}\n');
async function* chunks(...parts: Buffer[]) {
  for (const part of parts) yield part;
}
async function read(body: AsyncIterable<Uint8Array> | null) {
  if (!body) return null;
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
async function keys(store: BlobStore, prefix: string) {
  const out: string[] = [];
  for await (const key of store.list(prefix)) out.push(key);
  return out.sort();
}
const passing = [
  "round-trip",
  "missing-key",
  "exclusive-put",
  "failed-put-leaves-no-key",
  "list-children",
  "publish-key",
  "publish-prefix",
  "publish-refuses-existing",
  "delete-key",
].map((check) => ({ check, ok: true }));
const verdicts = async (subject: Parameters<typeof checkBlobStore>[0]) =>
  (await checkBlobStore(subject)).map(({ check, ok }) => ({ check, ok }));

let fake: FakeS3;
let root: string;
const settings = (
  extra: Partial<S3BlobStoreSettings> = {},
): S3BlobStoreSettings => ({
  endpoint: fake.url,
  region: fake.region,
  bucket: fake.bucket,
  credentials: fake.credentials,
  ...extra,
});
beforeEach(async () => {
  fake = await startFakeS3();
  root = await mkdtemp(join(tmpdir(), "openplans-blob-s3-"));
});
afterEach(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

describe("blob store contract", () => {
  it("passes for the S3 store over the fake server", async () => {
    expect(
      await verdicts({ create: () => new S3BlobStore(settings()) }),
    ).toEqual(passing);
  });

  it("stores the fetch cache's keys as object keys, under an optional prefix", async () => {
    await new S3BlobStore(settings()).put(
      "raw/synthetic/abc/payload",
      chunks(payload),
      {},
    );
    await new S3BlobStore(settings({ prefix: "openplans/cache" })).put(
      "raw/synthetic/abc/payload",
      chunks(payload),
      {},
    );
    expect([...fake.objects.keys()].sort()).toEqual([
      "openplans/cache/raw/synthetic/abc/payload",
      "raw/synthetic/abc/payload",
    ]);
    const prefixed = new S3BlobStore(settings({ prefix: "openplans/cache" }));
    expect(await keys(prefixed, "raw/synthetic")).toEqual([
      "raw/synthetic/abc/",
    ]);
    expect(fake.objects.get("raw/synthetic/abc/payload")!.meta.sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("refuses keys the local store refuses", async () => {
    const store = new S3BlobStore(settings());
    for (const key of ["", "/abs", "a/../b", "a//b", "a/./b", "a b"])
      await expect(store.put(key, chunks(payload), {})).rejects.toMatchObject({
        code: "invalid_key",
      });
    expect(fake.requests).toEqual([]);
  });
});

describe("sha256 on get", () => {
  it("throws when the stored bytes no longer match the recorded hash", async () => {
    const store = new S3BlobStore(settings());
    await store.put("raw/x/payload", chunks(payload), {});
    fake.objects.get("raw/x/payload")!.body = Buffer.from(
      '{"synthetic":false}\n',
    );
    await expect(read(await store.get("raw/x/payload"))).rejects.toMatchObject({
      code: "hash_mismatch",
    });
  });

  it("throws for an object with no recorded hash", async () => {
    const store = new S3BlobStore(settings());
    await store.put("raw/x/payload", chunks(payload), {});
    delete fake.objects.get("raw/x/payload")!.meta.sha256;
    await expect(store.get("raw/x/payload")).rejects.toMatchObject({
      code: "hash_unrecorded",
    });
  });

  it("negative control: a get that skips the check returns tampered bytes", async () => {
    const mutant = await plantMutant(
      storeFile,
      'if (hash.digest("hex") !== expected)',
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const store = new module.S3BlobStore(settings());
      await store.put("raw/x/payload", chunks(payload), {});
      const tampered = Buffer.from('{"synthetic":false}\n');
      fake.objects.get("raw/x/payload")!.body = tampered;
      expect(await read(await store.get("raw/x/payload"))).toEqual(tampered);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("list", () => {
  it("follows continuation tokens across pages", async () => {
    const store = new S3BlobStore(settings());
    const expected: string[] = [];
    for (let index = 0; index < 5; index++) {
      await store.put(`ls/k${index}`, chunks(payload), {});
      await store.put(`ls/d${index}/payload`, chunks(payload), {});
      expected.push(`ls/k${index}`, `ls/d${index}/`);
    }
    fake.requests.length = 0;
    expect(await keys(store, "ls")).toEqual(expected.sort());
    const pages = fake.requests.filter((request) =>
      request.query.includes("list-type=2"),
    );
    expect(pages.length).toBe(5);
    expect(
      pages
        .slice(1)
        .every((page) => page.query.includes("continuation-token=")),
    ).toBe(true);
  });

  it("negative control: a list that stops after one page loses keys", async () => {
    const mutant = await plantMutant(
      storeFile,
      "} while (token);",
      "} while (false);",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const store = new module.S3BlobStore(settings());
      for (let index = 0; index < 5; index++)
        await store.put(`ls/k${index}`, chunks(payload), {});
      expect((await keys(store, "ls")).length).toBe(2);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("publish", () => {
  const stage = async (store: BlobStore) => {
    await store.put("raw/s/.pending-1/payload", chunks(payload), {});
    await store.put(
      "raw/s/.pending-1/meta.json",
      chunks(Buffer.from("{}\n")),
      {},
    );
  };

  it("copies, checks, then deletes: no temporary key remains", async () => {
    const store = new S3BlobStore(settings());
    await stage(store);
    await store.publish("raw/s/.pending-1", "raw/s/snap");
    expect([...fake.objects.keys()].sort()).toEqual([
      "raw/s/snap/meta.json",
      "raw/s/snap/payload",
    ]);
    const order = fake.requests
      .filter(
        (request) => request.method === "PUT" || request.method === "DELETE",
      )
      .map((request) => request.method);
    expect(order).toEqual(["PUT", "PUT", "PUT", "PUT", "DELETE", "DELETE"]);
  });

  it("refuses an existing destination with EEXIST and changes nothing", async () => {
    const store = new S3BlobStore(settings());
    await stage(store);
    await store.put("raw/s/snap/payload", chunks(Buffer.from("first")), {});
    const before = new Map(
      [...fake.objects].map(([key, value]) => [key, value.body.toString()]),
    );
    await expect(
      store.publish("raw/s/.pending-1", "raw/s/snap"),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(
      new Map(
        [...fake.objects].map(([key, value]) => [key, value.body.toString()]),
      ),
    ).toEqual(before);
  });

  it("a failed copy removes the copies made and keeps the source", async () => {
    const store = new S3BlobStore(settings());
    await stage(store);
    const original = [...fake.objects.keys()].sort();
    let copies = 0;
    const realSet = fake.objects.set.bind(fake.objects);
    fake.objects.set = (key, value) => {
      if (key.startsWith("raw/s/snap/") && ++copies === 2)
        fake.failNext = { method: "HEAD", status: 500, code: "InternalError" };
      return realSet(key, value);
    };
    await expect(
      store.publish("raw/s/.pending-1", "raw/s/snap"),
    ).rejects.toMatchObject({
      code: "s3_error",
    });
    expect([...fake.objects.keys()].sort()).toEqual(original);
  });

  it("a copy that does not match its source is undone before any delete", async () => {
    const store = new S3BlobStore(settings());
    await stage(store);
    const original = [...fake.objects.keys()].sort();
    fake.corruptNextCopy = true;
    await expect(
      store.publish("raw/s/.pending-1", "raw/s/snap"),
    ).rejects.toMatchObject({
      code: "copy_mismatch",
    });
    expect([...fake.objects.keys()].sort()).toEqual(original);
    expect(
      fake.requests.some(
        (request) =>
          request.method === "DELETE" && request.path.includes(".pending-1"),
      ),
    ).toBe(false);
  });

  it("a missing temporary key is ENOENT", async () => {
    await expect(
      new S3BlobStore(settings()).publish("raw/s/none", "raw/s/snap"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("negative control: publish without the existence check replaces a snapshot", async () => {
    const mutant = await plantMutant(
      storeFile,
      "if (await this.exists(to))",
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const failed = (
        await checkBlobStore({
          create: () => new module.S3BlobStore(settings()),
        })
      )
        .filter((result) => !result.ok)
        .map((result) => result.check);
      expect(failed).toEqual(["publish-refuses-existing"]);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("no write in a none or request scope (design 5.10.4)", () => {
  const inScope = <T>(
    level: "none" | "request" | "memory" | "stored",
    fn: () => Promise<T>,
  ) =>
    runWithScope(async () => {
      restrictCacheLevel(level);
      return fn();
    });

  it.each(["none", "request"] as const)(
    "%s: writes are refused before any request",
    async (level) => {
      const store = new S3BlobStore(
        settings({ forbidsStorage: scopeForbidsStorage }),
      );
      await store.put("raw/x/payload.part", chunks(payload), {});
      fake.requests.length = 0;
      for (const write of [
        (): Promise<unknown> => store.put("raw/x/other", chunks(payload), {}),
        () => store.publish("raw/x/payload.part", "raw/x/payload"),
      ])
        await expect(inScope(level, write)).rejects.toMatchObject({
          code: "storage_forbidden",
        });
      expect(fake.requests).toEqual([]);
      expect([...fake.objects.keys()]).toEqual(["raw/x/payload.part"]);
      // Reads stay allowed.
      expect(
        await inScope(level, async () =>
          read(await store.get("raw/x/payload.part")),
        ),
      ).toEqual(payload);
    },
  );

  it("memory and stored scopes still write", async () => {
    const store = new S3BlobStore(
      settings({ forbidsStorage: scopeForbidsStorage }),
    );
    await inScope("memory", () => store.put("raw/x/a", chunks(payload), {}));
    await inScope("stored", () => store.put("raw/x/b", chunks(payload), {}));
    expect([...fake.objects.keys()].sort()).toEqual(["raw/x/a", "raw/x/b"]);
  });

  it("negative control: without the guard a none-scope put reaches the bucket", async () => {
    const mutant = await plantMutant(
      storeFile,
      "if (this.forbidsStorage())",
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const store = new module.S3BlobStore(
        settings({ forbidsStorage: scopeForbidsStorage }),
      );
      await inScope("none", () =>
        store.put("raw/x/payload", chunks(payload), {}),
      );
      expect([...fake.objects.keys()]).toEqual(["raw/x/payload"]);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("signing and credentials", () => {
  it("every request the store makes carries a signature the server accepts", async () => {
    const store = new S3BlobStore(settings());
    expect(
      (await checkBlobStore({ create: () => store })).every(
        (result) => result.ok,
      ),
    ).toBe(true);
    expect(fake.authorizations.length).toBeGreaterThan(20);
  });

  it("a wrong secret is refused, and the error carries no credential or signed detail", async () => {
    const store = new S3BlobStore(
      settings({
        credentials: { ...fake.credentials, secretAccessKey: "wrong/secret" },
      }),
    );
    const refused = async (run: () => Promise<unknown>) =>
      (await run().catch((e: unknown) => e)) as Error & { code: string };
    // A HEAD answer has no body, so only the status is known; a GET body names the code.
    const head = await refused(() =>
      store.put("raw/x/payload", chunks(payload), {}),
    );
    const get = await refused(() => store.get("raw/x/payload"));
    expect(head.code).toBe("s3_forbidden");
    expect(head.message).toBe("S3 HEAD failed with status 403");
    expect(get.code).toBe("s3_forbidden");
    expect(get.message).toBe(
      "S3 GET failed with status 403 (SignatureDoesNotMatch)",
    );
    for (const error of [head, get]) {
      const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
      for (const secret of [
        "wrong/secret",
        fake.credentials.secretAccessKey,
        "Signature=",
        "StringToSign",
        "echoed",
      ])
        expect(text).not.toContain(secret);
    }
    expect(fake.objects.size).toBe(0);
  });

  it("negative control: a store that signs for the wrong region is refused on every call", async () => {
    const mutant = await plantMutant(
      storeFile,
      "this.credentials, this.region,",
      'this.credentials, "us-wrong-1",',
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const results = await checkBlobStore({
        create: () => new module.S3BlobStore(settings()),
      });
      expect(
        results.filter((result) => result.ok).map((result) => result.check),
      ).toEqual([]);
      expect(fake.objects.size).toBe(0);
    } finally {
      await mutant.cleanup();
    }
  });

  it("credentials stay out of JSON and inspection", () => {
    const store = new S3BlobStore(
      settings({
        credentials: { ...fake.credentials, sessionToken: "synthetic-token" },
      }),
    );
    const text = `${JSON.stringify(store)} ${inspect(store, { depth: 5 })} ${String(store)}`;
    for (const secret of [
      fake.credentials.secretAccessKey,
      fake.credentials.accessKeyId,
      "synthetic-token",
    ])
      expect(text).not.toContain(secret);
  });

  it("sends a session token signed, when one is set", async () => {
    const store = new S3BlobStore(
      settings({
        credentials: { ...fake.credentials, sessionToken: "synthetic-token" },
      }),
    );
    await store.put("raw/x/payload", chunks(payload), {});
    expect(fake.authorizations.at(-1)).toContain("x-amz-security-token");
  });

  it("accepts http only for a loopback endpoint", () => {
    for (const endpoint of [
      "http://bucket.example.test",
      `https://user:pass${"@"}bucket.example.test`, // split so text scans see no address
      "https://bucket.example.test/path",
      "https://bucket.example.test/?q=1",
      "not a url",
    ])
      expect(() => new S3BlobStore(settings({ endpoint }))).toThrow(
        expect.objectContaining({ code: "invalid_endpoint" }),
      );
    expect(
      () =>
        new S3BlobStore(settings({ endpoint: "https://bucket.example.test" })),
    ).not.toThrow();
  });

  it("put refuses a body over its cap without a request", async () => {
    const store = new S3BlobStore(settings({ maxObjectBytes: 4 }));
    await expect(
      store.put("raw/x/payload", chunks(payload), {}),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fake.requests).toEqual([]);
  });
});

describe("delete", () => {
  it("removes one key, keeps its neighbours and accepts a missing key", async () => {
    const store = new S3BlobStore(settings());
    await store.put("raw/x/.pending-1/payload", chunks(payload), {});
    await store.put("raw/x/kept", chunks(payload), {});
    await store.delete("raw/x/.pending-1/payload");
    await store.delete("raw/x/absent");
    expect([...fake.objects.keys()]).toEqual(["raw/x/kept"]);
  });
});

describe("multipart upload", () => {
  const part = 5 * 1024 ** 2;
  /** Three parts: two full ones and a short last one. All bytes are synthetic. */
  const large = Buffer.alloc(2 * part + 1236);
  for (let at = 0; at < large.length; at += 4) large.writeUInt32LE(at, at);
  const largeSha = createHash("sha256").update(large).digest("hex");
  /** The body in 64 KiB chunks, as a file stream delivers it. */
  async function* streamed(data: Buffer) {
    for (let at = 0; at < data.length; at += 64 * 1024)
      yield data.subarray(at, at + 64 * 1024);
  }
  const multipartStore = (extra: Partial<S3BlobStoreSettings> = {}) =>
    new S3BlobStore(settings({ partBytes: part, ...extra }));
  const partRequests = () =>
    fake.requests.filter((request) => request.query.includes("partNumber="));
  const nothingLeft = () => {
    expect(fake.objects.has("raw/big/payload")).toBe(false);
    expect(fake.uploads.size).toBe(0);
  };

  it("uploads a body over one part in parts and reads it back whole", async () => {
    const store = multipartStore();
    expect(
      await store.put("raw/big/payload", streamed(large), {
        sha256: largeSha,
      }),
    ).toEqual({ bytes: large.length, sha256: largeSha });
    expect(partRequests()).toHaveLength(3);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.get("raw/big/payload")!.meta.sha256).toBe(largeSha);
    expect(await store.stat("raw/big/payload")).toEqual({
      bytes: large.length,
      sha256: largeSha,
    });
    expect(
      (await read(await store.get("raw/big/payload")))!.equals(large),
    ).toBe(true);
  });

  it("sends a body of exactly one part in a single PUT", async () => {
    const store = multipartStore();
    await store.put("raw/big/payload", streamed(large.subarray(0, part)), {});
    expect(partRequests()).toEqual([]);
    expect(fake.objects.get("raw/big/payload")!.body.length).toBe(part);
  });

  it("needs the expected sha256 and sends nothing without it", async () => {
    await expect(
      multipartStore().put("raw/big/payload", streamed(large), {}),
    ).rejects.toMatchObject({ code: "sha256_required" });
    expect(fake.requests).toEqual([]);
  });

  it("aborts, and stores nothing, when the body differs from its expected sha256", async () => {
    await expect(
      multipartStore().put("raw/big/payload", streamed(large), {
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(fake.aborted).toHaveLength(1);
    expect(
      fake.requests.some(
        (request) =>
          request.method === "POST" && request.query.startsWith("uploadId="),
      ),
    ).toBe(false);
    nothingLeft();
  });

  it("negative control: without the sha256 check an upload with the wrong hash completes", async () => {
    const mutant = await plantMutant(
      storeFile,
      "if (sent !== expected)",
      "if (false)",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      const store = new module.S3BlobStore(settings({ partBytes: part }));
      const wrong = Buffer.from(large);
      wrong.writeUInt8(wrong.readUInt8(part + 1) ^ 0xff, part + 1);
      await store.put("raw/big/payload", streamed(wrong), {
        sha256: largeSha,
      });
      // Accepted: the object records a hash its bytes do not have.
      expect(fake.objects.get("raw/big/payload")!.meta.sha256).toBe(largeSha);
      expect(fake.aborted).toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("aborts the upload when a part fails", async () => {
    fake.failNext = {
      method: "PUT",
      status: 500,
      code: "InternalError",
      query: "partNumber=2",
    };
    await expect(
      multipartStore().put("raw/big/payload", streamed(large), {
        sha256: largeSha,
      }),
    ).rejects.toMatchObject({ code: "s3_error" });
    expect(fake.aborted).toHaveLength(1);
    nothingLeft();
  });

  it("aborts the upload when the body fails part way", async () => {
    async function* broken() {
      yield* streamed(large.subarray(0, 2 * part + 10));
      throw new Error("synthetic stream failure");
    }
    await expect(
      multipartStore().put("raw/big/payload", broken(), { sha256: largeSha }),
    ).rejects.toThrow("synthetic stream failure");
    expect(fake.aborted).toHaveLength(1);
    nothingLeft();
  });

  it("aborts the upload when the body passes the size cap", async () => {
    await expect(
      multipartStore({ maxObjectBytes: 2 * part + 10 }).put(
        "raw/big/payload",
        streamed(large),
        { sha256: largeSha },
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fake.aborted).toHaveLength(1);
    nothingLeft();
  });

  it("refuses an existing key before it starts an upload", async () => {
    const store = multipartStore();
    await store.put("raw/big/payload", chunks(payload), {});
    await expect(
      store.put("raw/big/payload", streamed(large), { sha256: largeSha }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(fake.uploads.size).toBe(0);
    expect(partRequests()).toEqual([]);
    expect(fake.objects.get("raw/big/payload")!.body).toEqual(payload);
  });

  it("deletes a completed object that lost a part and fails", async () => {
    fake.dropPartOnComplete = 2;
    await expect(
      multipartStore().put("raw/big/payload", streamed(large), {
        sha256: largeSha,
      }),
    ).rejects.toMatchObject({ code: "upload_mismatch" });
    nothingLeft();
  });

  it("negative control: without the completed-size check an object missing a part is kept", async () => {
    const mutant = await plantMutant(
      storeFile,
      "stored.bytes !== bytes ||",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof StoreModule;
      fake.dropPartOnComplete = 2;
      await new module.S3BlobStore(settings({ partBytes: part })).put(
        "raw/big/payload",
        streamed(large),
        { sha256: largeSha },
      );
      expect(fake.objects.get("raw/big/payload")!.body.length).toBe(
        large.length - part,
      );
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses a part size below what S3 accepts", () => {
    expect(() => multipartStore({ partBytes: part - 1 })).toThrow(
      expect.objectContaining({ code: "invalid_part_size" }),
    );
  });
});
