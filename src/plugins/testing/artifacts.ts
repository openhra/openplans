import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  rebaseImports,
  replaceSyntax,
} from "../../../scripts/source-mutation.mjs";

/** The nearest node_modules folder at or above `directory`, if any. */
async function nearestNodeModules(directory: string) {
  for (let current = directory; ; current = dirname(current)) {
    const candidate = join(current, "node_modules");
    if (
      await stat(candidate).then(
        (info) => info.isDirectory(),
        () => false,
      )
    )
      return candidate;
    if (dirname(current) === current) return undefined;
  }
}

/**
 * Mutate a disposable copy; the source file is never written. The copy goes in its own folder
 * under the OS temp dir, so it never lands in the source tree, where a test running alongside
 * could scan it. Relative imports point back at the original's folder, and package imports
 * resolve through the original's nearest node_modules.
 */
export async function plantMutant(
  file: string | URL,
  before: string,
  after: string,
) {
  const original = typeof file === "string" ? pathToFileURL(file) : file;
  const source = replaceSyntax(await readFile(original, "utf8"), before, after);
  const directory = await mkdtemp(join(tmpdir(), "openplans-mutant-"));
  const path = join(directory, basename(fileURLToPath(original)));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const modules = await nearestNodeModules(dirname(fileURLToPath(original)));
    if (modules) await symlink(modules, join(directory, "node_modules"), "dir");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", private: true }),
    );
    await writeFile(path, rebaseImports(source, original));
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export { responseDigests } from "./digests.js";
export type { DigestRequest, ResponseDigest } from "./digests.js";
