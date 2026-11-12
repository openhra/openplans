import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "@openplans/plugin-sdk";
import { FetchError } from "../errors.js";
import {
  LocalBlobStore,
  checkedKey,
  refuseInRestrictedScope,
} from "./local.js";
import type { FetchBlobStore } from "./local.js";

/** The key a reader finds a snapshot by. It is published last, after every other key checks out. */
const commitName = "meta.json";
const staged = (key: string) =>
  checkedKey(key)
    .split("/")
    .some((part) => part.startsWith(".pending-"));
const parentOf = (key: string) => key.slice(0, key.lastIndexOf("/"));
const exists = () =>
  Object.assign(new Error("Blob key already exists"), { code: "EEXIST" });

async function* bytesOf(data: Buffer): AsyncGenerator<Buffer> {
  yield data;
}
async function readAll(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
async function hashOf(
  body: AsyncIterable<Uint8Array>,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}
const hashFile = (path: string) => hashOf(createReadStream(path));

/**
 * Design 5.7: the fetch cache over a store that offers only the SDK interface, such as an object
 * store. Staged keys (any `.pending-` segment) live in a private spool under
 * `<dataDir>/blob-spool`, so the download, its size and hash checks and ZIP inspection all run on
 * local files. Publishing a staged prefix uploads each file with `put` under a fresh temporary
 * key and moves it with `publish`, `meta.json` last: a reader sees the snapshot only once its
 * payload is in place. Published keys are read with the store's own `get`, which checks the
 * recorded hash, into `<dataDir>/blob-read`, and `localPath` names that copy. Host leases,
 * quarantine markers and readmissions stay under the data directory itself (`controlDir`).
 */
export class RemoteFetchStore implements FetchBlobStore {
  private readonly spool: LocalBlobStore;
  private readonly readRoot: string;

  constructor(
    readonly store: BlobStore,
    private readonly dataDir: string,
  ) {
    this.spool = new LocalBlobStore(join(dataDir, "blob-spool"));
    this.readRoot = join(dataDir, "blob-read");
  }

  /** A staged key's spool file, or the local copy `materialize` writes for a published key. */
  localPath(key: string): string {
    return staged(key)
      ? this.spool.localPath(key)
      : join(this.readRoot, ...checkedKey(key).split("/"));
  }

  controlDir(prefix: string): string {
    return join(this.dataDir, ...checkedKey(prefix).split("/"));
  }

  stage(prefix: string): Promise<string> {
    return this.spool.stage(prefix);
  }

  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { sha256?: string } = {},
  ): Promise<{ bytes: number; sha256: string }> {
    if (staged(key)) return this.spool.put(key, body, meta);
    refuseInRestrictedScope();
    return this.store.put(key, body, meta);
  }

  get(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    return staged(key) ? this.spool.get(key) : this.store.get(key);
  }

  stat(key: string): Promise<{ bytes: number; sha256: string | null } | null> {
    return staged(key) ? this.spool.stat(key) : this.store.stat(key);
  }

  list(prefix: string): AsyncIterable<string> {
    return staged(prefix) ? this.spool.list(prefix) : this.store.list(prefix);
  }

  async publish(temporaryKey: string, finalKey: string): Promise<void> {
    if (staged(temporaryKey) && staged(finalKey))
      return this.spool.publish(temporaryKey, finalKey);
    refuseInRestrictedScope();
    if (!staged(temporaryKey))
      return this.store.publish(temporaryKey, finalKey);
    await this.upload(temporaryKey, finalKey);
    await this.spool.discard(temporaryKey);
  }

  /**
   * Gives `aliasKey` the bytes of `key`, as the local store's hard link does. An existing
   * `aliasKey` is kept as it is.
   */
  async alias(key: string, aliasKey: string): Promise<void> {
    if (staged(key) && staged(aliasKey)) return this.spool.alias(key, aliasKey);
    refuseInRestrictedScope();
    if (await this.store.stat(aliasKey)) return;
    const body = await this.store.get(key);
    if (!body)
      throw Object.assign(new Error("Blob key does not exist"), {
        code: "ENOENT",
      });
    const data = await readAll(body);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const temporary = this.temporaryKey(aliasKey);
    const unmoved = new Set<string>();
    try {
      await this.store.put(temporary, bytesOf(data), { sha256 });
      unmoved.add(temporary);
      try {
        await this.store.publish(temporary, aliasKey);
        unmoved.delete(temporary);
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    } finally {
      await this.removePending(unmoved);
    }
  }

  /**
   * Removes a spool prefix. Nothing remote is touched here: the step that put a remote
   * temporary key removes it.
   */
  async discard(temporaryKey: string): Promise<void> {
    if (staged(temporaryKey)) await this.spool.discard(temporaryKey);
  }

  /**
   * Removes a staged spool key. The fetch cache never deletes a published key, so any key
   * without a `.pending-` segment is refused.
   */
  async delete(key: string): Promise<void> {
    if (!staged(key))
      throw new FetchError(
        "cache_error",
        "The fetch cache deletes only its own temporary keys",
      );
    await this.spool.delete(key);
  }

  /**
   * Best-effort removal of the remote `.pending-` keys this store wrote and did not publish. A
   * failed delete leaves the key for later cleanup; readers skip it either way. It never throws,
   * so the caller's own error is what surfaces.
   */
  private async removePending(keys: Set<string>): Promise<void> {
    for (const key of keys) {
      if (!staged(key)) continue;
      try {
        await this.store.delete(key);
      } catch {
        // Kept: a later run can remove it.
      }
    }
  }

  /**
   * Copies a published key to `localPath(key)` through the store's `get`, checking `expected`
   * when given. A local copy that already matches `expected` is kept unless `fresh` is set. The
   * copy appears by rename, so a reader never sees a partial file.
   */
  async materialize(
    key: string,
    expected?: { bytes: number; sha256: string },
    fresh = false,
  ): Promise<void> {
    refuseInRestrictedScope();
    const target = this.localPath(key);
    if (expected && !fresh && (await this.matches(target, expected))) return;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.part-${randomBytes(8).toString("hex")}`;
    try {
      const body = await this.store.get(key);
      if (!body) throw new Error("Stored blob is missing");
      const file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of body) {
          hash.update(chunk);
          bytes += chunk.length;
          await file.writeFile(chunk);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (
        expected &&
        (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
      )
        throw new FetchError(
          "cache_error",
          "Stored blob differs from its snapshot metadata",
        );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async matches(
    path: string,
    expected: { bytes: number; sha256: string },
  ): Promise<boolean> {
    try {
      if ((await stat(path)).size !== expected.bytes) return false;
    } catch {
      return false;
    }
    return (await hashFile(path)).sha256 === expected.sha256;
  }

  /** A fresh key beside `key` that readers skip: its last segment starts with `.pending-`. */
  private temporaryKey(key: string): string {
    return `${parentOf(key)}/.pending-${randomBytes(8).toString("hex")}`;
  }

  private async upload(stagedKey: string, finalKey: string): Promise<void> {
    const directory = this.spool.localPath(stagedKey);
    const names = (await readdir(directory)).sort(
      (a, b) => Number(a === commitName) - Number(b === commitName),
    );
    // A complete snapshot at `finalKey` is the cache's concurrent-writer case, as with rename.
    if (await this.store.stat(`${finalKey}/${commitName}`)) throw exists();
    const temporary = this.temporaryKey(finalKey);
    // Keys put under `temporary` and not yet moved. Whatever happens, none outlives this call.
    const pending = new Set<string>();
    try {
      for (const name of names) {
        const key = `${finalKey}/${name}`;
        const local = await hashFile(join(directory, name));
        if (await this.adopt(key, local)) continue;
        const written = await this.store.put(
          `${temporary}/${name}`,
          createReadStream(join(directory, name)),
          { sha256: local.sha256 },
        );
        pending.add(`${temporary}/${name}`);
        if (written.bytes !== local.bytes || written.sha256 !== local.sha256)
          throw new FetchError(
            "cache_error",
            "Stored blob differs from the downloaded file",
          );
        try {
          await this.store.publish(`${temporary}/${name}`, key);
          pending.delete(`${temporary}/${name}`);
        } catch (error) {
          if (
            (error as { code?: string }).code !== "EEXIST" ||
            name === commitName ||
            !(await this.adopt(key, local))
          )
            throw error;
        }
      }
    } finally {
      await this.removePending(pending);
    }
  }

  /**
   * True when `key` already holds these bytes, left by an interrupted or concurrent writer
   * before its `meta.json` appeared. Other content at `key` is a conflict.
   */
  private async adopt(
    key: string,
    local: { bytes: number; sha256: string },
  ): Promise<boolean> {
    const remote = await this.store.stat(key);
    if (!remote) return false;
    if (key.endsWith(`/${commitName}`) || remote.bytes !== local.bytes)
      throw exists();
    let sha256 = remote.sha256;
    if (sha256 === null) {
      const body = await this.store.get(key);
      sha256 = body ? (await hashOf(body)).sha256 : null;
    }
    if (sha256 !== local.sha256) throw exists();
    return true;
  }
}
