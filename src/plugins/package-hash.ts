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
