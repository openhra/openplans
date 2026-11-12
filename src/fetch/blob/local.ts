import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { BlobStore } from "@openplans/plugin-sdk";
import { scopeForbidsStorage } from "../../plugins/request-scope.js";
import { FetchError } from "../errors.js";

/**
 * The filesystem calls the local store makes. Tests replace them to model a crash at any
 * step; production uses node:fs/promises. The store never calls `cp`: it is listed so the same
 * crash model also covers a store that copies instead of renaming.
 */
export interface LocalBlobFs {
  mkdir: typeof nodeFs.mkdir;
  mkdtemp: typeof nodeFs.mkdtemp;
  open: typeof nodeFs.open;
  rename: typeof nodeFs.rename;
  link: typeof nodeFs.link;
  rm: typeof nodeFs.rm;
  readdir: typeof nodeFs.readdir;
  stat: typeof nodeFs.stat;
  cp: typeof nodeFs.cp;
}
const defaultFs: LocalBlobFs = {
  mkdir: nodeFs.mkdir,
  mkdtemp: nodeFs.mkdtemp,
  open: nodeFs.open,
  rename: nodeFs.rename,
  link: nodeFs.link,
  rm: nodeFs.rm,
  readdir: nodeFs.readdir,
  stat: nodeFs.stat,
  cp: nodeFs.cp,
};

/**
 * A blob store the fetch cache can run on. Beyond the SDK interface it names a filesystem path
 * for each key, because fetch results hand callers a payload path and ZIP inspection reads one.
 */
export interface FetchBlobStore extends BlobStore {
  /** Filesystem path of `key`. */
  localPath(key: string): string;
  /** Creates an empty temporary prefix under `prefix` that no other writer shares. */
  stage(prefix: string): Promise<string>;
  /** Gives the published `key` a second name. An existing `aliasKey` is kept as it is. */
  alias(key: string, aliasKey: string): Promise<void>;
  /** Removes a temporary prefix and everything under it. */
  discard(temporaryKey: string): Promise<void>;
  /**
   * Where host-local control files for `prefix` live (quarantine markers, readmissions), when
   * that differs from `localPath(prefix)`.
   */
  controlDir?(prefix: string): string;
  /**
   * Makes `localPath(key)` hold the published key's bytes, for a store whose keys are not local
   * files. A store whose keys are files has no such step.
   */
  materialize?(
    key: string,
    expected?: { bytes: number; sha256: string },
    fresh?: boolean,
  ): Promise<void>;
}

const segment = /^[A-Za-z0-9._-]{1,255}$/;
/** Keys are relative POSIX paths of plain segments: no `..`, no empty or absolute parts. */
export function checkedKey(key: string): string {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (
    !parts.length ||
    parts.some((part) => !segment.test(part) || part === "." || part === "..")
  )
    throw new FetchError("cache_error", "Invalid blob key");
  return key;
}
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export function refuseInRestrictedScope(): void {
  // Design 5.10.4: a `none` or `request` answer never reaches disk, whoever asks the store.
  if (scopeForbidsStorage())
    throw new FetchError(
      "storage_forbidden",
      "The request's cache level forbids storing a payload",
    );
}

/**
 * Design 5.7: the `local` provider. A key is a path under `root`, so the fetch cache keeps the
 * tree it always wrote: `raw/<source>/<snapshot>/payload`, `meta.json` and the
 * `<snapshot>.meta.json` sidecar. `publish` is a rename, which is atomic on one filesystem.
 */
export class LocalBlobStore implements FetchBlobStore {
  constructor(
    readonly root: string,
    private readonly fs: LocalBlobFs = defaultFs,
  ) {
    if (!isAbsolute(root))
      throw new FetchError(
        "invalid_options",
        "Data cache directory must be absolute",
      );
  }

  localPath(key: string): string {
    return join(this.root, ...checkedKey(key).split("/"));
  }

  async stage(prefix: string): Promise<string> {
    refuseInRestrictedScope();
    const directory = this.localPath(prefix);
    await this.fs.mkdir(directory, { recursive: true });
    const staged = await this.fs.mkdtemp(join(directory, ".pending-"));
    return `${prefix}/${staged.slice(directory.length + sep.length)}`;
  }

  /** Writes a new key; never replaces one. A failed write leaves no key behind. */
  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { sha256?: string } = {},
  ): Promise<{ bytes: number; sha256: string }> {
    refuseInRestrictedScope();
    const path = this.localPath(key);
    const file = await this.fs.open(path, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    let written = false;
    try {
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
      const sha256 = hash.digest("hex");
      if (meta.sha256 !== undefined && meta.sha256 !== sha256)
        throw new FetchError("cache_error", "Blob hash differs from expected");
      written = true;
      return { bytes, sha256 };
    } finally {
      if (!written) await this.fs.rm(path, { force: true });
    }
  }

  /** Opens the key now, so a missing key is `null` rather than a later stream error. */
  async get(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    let file: nodeFs.FileHandle;
    try {
      file = await this.fs.open(this.localPath(key), "r");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    return file.createReadStream();
  }

  async stat(
    key: string,
  ): Promise<{ bytes: number; sha256: string | null } | null> {
    try {
      const info = await this.fs.stat(this.localPath(key));
      return { bytes: info.size, sha256: null };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /**
   * The direct children of `prefix`, in directory order: `prefix/name` for a file and
   * `prefix/name/` for a directory, like an object store's delimiter listing.
   */
  async *list(prefix: string): AsyncIterable<string> {
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(this.localPath(prefix), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries)
      yield `${prefix}/${entry.name}${entry.isDirectory() ? "/" : ""}`;
  }

  async publish(temporaryKey: string, finalKey: string): Promise<void> {
    refuseInRestrictedScope();
    const from = this.localPath(temporaryKey);
    const to = this.localPath(finalKey);
    await this.fs.rename(from, to);
  }

  async alias(key: string, aliasKey: string): Promise<void> {
    refuseInRestrictedScope();
    try {
      await this.fs.link(this.localPath(key), this.localPath(aliasKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /** Removes one file. A missing key is not an error; a directory is refused, as `rm` refuses it. */
  async delete(key: string): Promise<void> {
    await this.fs.rm(this.localPath(key), { force: true });
  }

  async discard(temporaryKey: string): Promise<void> {
    await this.fs.rm(this.localPath(temporaryKey), {
      recursive: true,
      force: true,
    });
  }
}
