import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** A package larger than this is not hashed; its hash shows as unknown. */
export const PACKAGE_HASH_MAX_FILES = 10_000;
export const PACKAGE_HASH_MAX_BYTES = 200 * 1024 * 1024;
const PACKAGE_ROOT_LEVELS = 8;

/** The nearest directory at or above `file` that holds a package.json. */
export async function packageRoot(file: string): Promise<string | undefined> {
  let directory = dirname(file);
  for (let level = 0; level < PACKAGE_ROOT_LEVELS; level++) {
    try {
      if ((await lstat(join(directory, "package.json"))).isFile())
        return directory;
    } catch {
      // Not here; try the parent.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/**
 * The package hash the status page and the approved plugin list use. Every regular file and
 * symbolic link under the package root, except `node_modules` and names starting with a dot,
 * sorted by relative path with `/` separators, contributes one line:
 * `<path>\0<sha256 of the bytes>\n` (a link: `<path>\0link:<target>\n`). The hash is the
 * SHA-256 of those lines. Undefined when the tree cannot be read or exceeds the limits.
 */
export async function packageSha256(root: string): Promise<string | undefined> {
  const entries: { path: string; line: string }[] = [];
  let bytes = 0;
  const walk = async (directory: string): Promise<boolean> => {
    for (const name of await readdir(directory)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(directory, name);
      const path = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isDirectory()) {
        if (!(await walk(full))) return false;
        continue;
      }
      if (entries.length >= PACKAGE_HASH_MAX_FILES) return false;
      if (info.isSymbolicLink())
        entries.push({ path, line: `${path}\0link:${await readlink(full)}\n` });
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > PACKAGE_HASH_MAX_BYTES) return false;
        const digest = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        entries.push({ path, line: `${path}\0${digest}\n` });
      }
    }
    return true;
  };
  try {
    if (!(await walk(root))) return undefined;
  } catch {
    return undefined;
  }
  const hash = createHash("sha256");
  // Code-unit order, independent of locale.
  entries.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
  for (const entry of entries) hash.update(entry.line);
  return hash.digest("hex");
}

/**
 * Strict package digest v1. SHA-256 of the UTF-8 JSON array of records, sorted by
 * path in code-unit order: [path, "directory", mode] or [path, "file", mode, size,
 * sha256]. Modes are stat.mode & 0o7777. The root is recorded as ".". All names,
 * including hidden files and node_modules, participate. Links, special files,
 * unreadable trees and trees above the existing bounds are refused, never skipped.
 */
export async function packageContentDigest(root: string): Promise<string> {
  return (await packageDigests(root)).digest;
}

type FileDigest = { stamp: string; digest: Promise<string> };
const runtimeDigests = new Map<string, Map<string, FileDigest>>();
const fileStamp = (info: BigIntStats) =>
  [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(
    ":",
  );

/** Both recipes share one tree walk. Runtime reuse still checks every file's metadata. */
export async function packageDigests(root: string, reuse = false) {
  const cached = reuse
    ? (runtimeDigests.get(root) ?? new Map<string, FileDigest>())
    : undefined;
  if (cached) runtimeDigests.set(root, cached);
  const records: (string | number)[][] = [];
  const legacy: { path: string; digest: string }[] = [];
  let bytes = 0;
  const walk = async (
    full: string,
    path: string,
    included: boolean,
  ): Promise<void> => {
    if (records.length >= PACKAGE_HASH_MAX_FILES)
      throw new Error("package_digest_file_limit");
    const info = await lstat(full, { bigint: true });
    if (info.isSymbolicLink()) throw new Error("package_digest_link");
    if (info.isDirectory()) {
      records.push([path, "directory", Number(info.mode & 0o7777n)]);
      for (const name of await readdir(full))
        await walk(
          join(full, name),
          path === "." ? name : `${path}/${name}`,
          included && !name.startsWith(".") && name !== "node_modules",
        );
    } else if (info.isFile()) {
      bytes += Number(info.size);
      if (bytes > PACKAGE_HASH_MAX_BYTES)
        throw new Error("package_digest_byte_limit");
      const stamp = fileStamp(info);
      let entry = cached?.get(path);
      if (entry?.stamp !== stamp) {
        const digest = (async () => {
          const data = await readFile(full);
          if (
            BigInt(data.length) !== info.size ||
            fileStamp(await lstat(full, { bigint: true })) !== stamp
          )
            throw new Error("package_digest_changed");
          return createHash("sha256").update(data).digest("hex");
        })();
        entry = { stamp, digest };
        cached?.set(path, entry);
        digest.catch(() => {
          if (cached && cached.get(path) === entry) cached.delete(path);
        });
      }
      const digest = await entry.digest;
      records.push([
        path,
        "file",
        Number(info.mode & 0o7777n),
        Number(info.size),
        digest,
      ]);
      if (included) legacy.push({ path, digest });
    } else throw new Error("package_digest_special_file");
  };
  await walk(root, ".", true);
  records.sort((a, b) => Number(a[0]! > b[0]!) - Number(a[0]! < b[0]!));
  legacy.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
  const hash = createHash("sha256");
  for (const entry of legacy) hash.update(`${entry.path}\0${entry.digest}\n`);
  return {
    digest: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    legacySha256: hash.digest("hex"),
  };
}
