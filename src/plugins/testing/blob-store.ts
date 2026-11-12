import { createHash } from "node:crypto";
import type { BlobStore } from "@openplans/plugin-sdk";

/**
 * Blob store contract (design 5.7), checked against any `BlobStore`: every provider, core
 * `local` included, must behave the same for the keys the fetch cache writes. Returns one
 * result per check and never throws for a failed check.
 */
export interface BlobStoreSubject {
  create(): BlobStore | Promise<BlobStore>;
  /** Makes `prefix` writable. A filesystem store creates the directory; an object store need not. */
  prepare?(prefix: string): Promise<void>;
}
export type BlobStoreCheck =
  | "round-trip"
  | "missing-key"
  | "exclusive-put"
  | "failed-put-leaves-no-key"
  | "list-children"
  | "publish-key"
  | "publish-prefix"
  | "publish-refuses-existing"
  | "delete-key";
export interface BlobStoreResult {
  check: BlobStoreCheck;
  ok: boolean;
  detail: string;
}

class ContractFailure extends Error {}
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new ContractFailure(detail);
};
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function* chunks(...parts: (Buffer | Error)[]) {
  for (const part of parts) {
    if (part instanceof Error) throw part;
    yield part;
  }
}
async function read(store: BlobStore, key: string) {
  const body = await store.get(key);
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
async function rejects(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { code?: string };
  }
  return null;
}

export async function checkBlobStore(
  subject: BlobStoreSubject,
): Promise<BlobStoreResult[]> {
  const prepare = subject.prepare ?? (async () => {});
  const payload = Buffer.from('{"synthetic":true}\n');
  const checks: [BlobStoreCheck, (store: BlobStore) => Promise<string>][] = [
    [
      "round-trip",
      async (store) => {
        await prepare("rt");
        const written = await store.put(
          "rt/payload",
          chunks(payload.subarray(0, 5), payload.subarray(5)),
          {},
        );
        expect(written.bytes === payload.length, "put reported the wrong size");
        expect(
          written.sha256 === sha(payload),
          "put reported the wrong sha256",
        );
        expect(
          (await read(store, "rt/payload"))?.equals(payload) === true,
          "get returned other bytes",
        );
        const info = await store.stat("rt/payload");
        expect(info?.bytes === payload.length, "stat reported the wrong size");
        expect(
          info?.sha256 === null || info?.sha256 === sha(payload),
          "stat reported a wrong sha256",
        );
        return "put, get and stat agree";
      },
    ],
    [
      "missing-key",
      async (store) => {
        expect(
          (await store.get("absent/payload")) === null,
          "get of a missing key is not null",
        );
        expect(
          (await store.stat("absent/payload")) === null,
          "stat of a missing key is not null",
        );
        expect(
          (await keys(store, "absent")).length === 0,
          "list of a missing prefix is not empty",
        );
        return "missing keys read as null";
      },
    ],
    [
      "exclusive-put",
      async (store) => {
        await prepare("ex");
        await store.put("ex/payload", chunks(payload), {});
        const error = await rejects(() =>
          store.put("ex/payload", chunks(Buffer.from("other")), {}),
        );
        expect(
          error?.code === "EEXIST",
          "a second put to a key did not fail with EEXIST",
        );
        expect(
          (await read(store, "ex/payload"))?.equals(payload) === true,
          "a refused put changed the key",
        );
        return "put never replaces a key";
      },
    ],
    [
      "failed-put-leaves-no-key",
      async (store) => {
        await prepare("fp");
        expect(
          (await rejects(() =>
            store.put("fp/mismatch", chunks(payload), {
              sha256: "0".repeat(64),
            }),
          )) !== null,
          "a put with the wrong expected sha256 succeeded",
        );
        expect(
          (await rejects(() =>
            store.put(
              "fp/broken",
              chunks(payload, new Error("synthetic stream failure")),
              {},
            ),
          )) !== null,
          "a put whose body failed succeeded",
        );
        expect(
          (await store.stat("fp/mismatch")) === null,
          "a mismatched put left a key",
        );
        expect(
          (await store.stat("fp/broken")) === null,
          "a failed put left a key",
        );
        return "failed puts leave nothing";
      },
    ],
    [
      "list-children",
      async (store) => {
        await prepare("ls");
        await prepare("ls/deeper");
        await store.put("ls/a", chunks(payload), {});
        await store.put("ls/b", chunks(payload), {});
        await store.put("ls/deeper/c", chunks(payload), {});
        const listed = await keys(store, "ls");
        expect(
          JSON.stringify(listed) ===
            JSON.stringify(["ls/a", "ls/b", "ls/deeper/"]),
          `list returned ${JSON.stringify(listed)}`,
        );
        return "list yields direct children";
      },
    ],
    [
      "publish-key",
      async (store) => {
        await prepare("pk");
        await store.put("pk/payload.part", chunks(payload), {});
        await store.publish("pk/payload.part", "pk/payload");
        expect(
          (await store.stat("pk/payload.part")) === null,
          "publish left the temporary key",
        );
        expect(
          (await read(store, "pk/payload"))?.equals(payload) === true,
          "published key has other bytes",
        );
        return "a key moves";
      },
    ],
    [
      "publish-prefix",
      async (store) => {
        await prepare("pp/.pending-1");
        await store.put("pp/.pending-1/payload", chunks(payload), {});
        await store.put(
          "pp/.pending-1/meta.json",
          chunks(Buffer.from("{}\n")),
          {},
        );
        await store.publish("pp/.pending-1", "pp/snapshot");
        expect(
          JSON.stringify(await keys(store, "pp")) ===
            JSON.stringify(["pp/snapshot/"]),
          "publish left a temporary key or lost the destination",
        );
        expect(
          JSON.stringify(await keys(store, "pp/snapshot")) ===
            JSON.stringify(["pp/snapshot/meta.json", "pp/snapshot/payload"]),
          "published prefix lost a key",
        );
        expect(
          (await read(store, "pp/snapshot/payload"))?.equals(payload) === true,
          "published payload differs",
        );
        return "a prefix moves whole";
      },
    ],
    [
      "publish-refuses-existing",
      async (store) => {
        await prepare("pe/.pending-1");
        await prepare("pe/snapshot");
        await store.put("pe/snapshot/payload", chunks(payload), {});
        await store.put(
          "pe/.pending-1/payload",
          chunks(Buffer.from("other")),
          {},
        );
        const error = await rejects(() =>
          store.publish("pe/.pending-1", "pe/snapshot"),
        );
        expect(
          error?.code === "EEXIST" || error?.code === "ENOTEMPTY",
          "publish onto an existing destination did not fail with EEXIST",
        );
        expect(
          (await read(store, "pe/snapshot/payload"))?.equals(payload) === true,
          "publish replaced an existing key",
        );
        expect(
          (await store.stat("pe/.pending-1/payload")) !== null,
          "a refused publish lost its source",
        );
        return "publish never replaces a destination";
      },
    ],
    [
      "delete-key",
      async (store) => {
        await prepare("dk/.pending-1");
        await store.put("dk/.pending-1/payload", chunks(payload), {});
        await store.put("dk/kept", chunks(payload), {});
        await store.delete("dk/.pending-1/payload");
        expect(
          (await store.stat("dk/.pending-1/payload")) === null,
          "stat still finds a deleted key",
        );
        expect(
          (await store.get("dk/.pending-1/payload")) === null,
          "get still reads a deleted key",
        );
        expect(
          (await read(store, "dk/kept"))?.equals(payload) === true,
          "delete changed another key",
        );
        expect(
          (await rejects(() => store.delete("dk/absent"))) === null,
          "delete of a missing key failed",
        );
        return "a key goes, its neighbours stay";
      },
    ],
  ];
  const results: BlobStoreResult[] = [];
  for (const [check, run] of checks) {
    try {
      results.push({
        check,
        ok: true,
        detail: await run(await subject.create()),
      });
    } catch (error) {
      results.push({
        check,
        ok: false,
        detail:
          error instanceof ContractFailure
            ? error.message
            : `threw: ${(error as Error).message}`,
      });
    }
  }
  return results;
}
