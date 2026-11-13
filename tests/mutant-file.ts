import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebaseImports } from "./source-mutation.js";

const packageRoot = new URL("../", import.meta.url);

/**
 * Plant a mutated copy of `original` in its own folder under the OS temp dir.
 *
 * Each call gets a fresh folder, so two test runs in one checkout never write,
 * import or delete each other's copy, and nothing lands in the source tree where
 * another run's lint or format check could see it. Relative imports are rebased to
 * the original's folder; a `node_modules` link and a module `package.json` let
 * package imports resolve as they do in the repo.
 */
export async function plantMutantFile(file: string | URL, source: string) {
  const original = typeof file === "string" ? pathToFileURL(file) : file;
  // Only static imports are rebased; a path built from the module's own location
  // would point into the temp folder.
  if (
    /new URL\([^)]*import\.meta\.url|import\.meta\.(dirname|filename)|\bimport\(\s*["'`]\.|__dirname/.test(
      source,
    )
  )
    throw new Error(
      `${basename(fileURLToPath(original))} resolves paths from its own location; it cannot be planted outside the repo`,
    );
  const { directory, cleanup } = await mutantFolder();
  try {
    const path = join(directory, basename(fileURLToPath(original)));
    await writeFile(path, rebaseImports(source, original));
    return { path, url: pathToFileURL(path), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Copy a built package (its package.json and one folder, such as dist) into a fresh
 * temp folder, so a test can edit the copy and load it as a package of its own.
 */
export async function plantMutantPackage(root: string | URL, folder: string) {
  const original = typeof root === "string" ? pathToFileURL(`${root}/`) : root;
  const { directory, cleanup } = await mutantFolder();
  try {
    await cp(
      new URL("package.json", original),
      join(directory, "package.json"),
    );
    await cp(new URL(`${folder}/`, original), join(directory, folder), {
      recursive: true,
    });
    return { path: join(directory, folder), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** A fresh temp folder where package imports resolve through the repo's node_modules. */
async function mutantFolder() {
  const directory = await mkdtemp(join(tmpdir(), "openplans-mutant-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await symlink(
      fileURLToPath(new URL("node_modules", packageRoot)),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", private: true }),
    );
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Plant a mutant, hand its file URL to `use`, and always remove it afterwards. */
export async function withMutantFile<T>(
  original: string | URL,
  source: string,
  use: (file: URL) => Promise<T>,
): Promise<T> {
  const mutant = await plantMutantFile(original, source);
  try {
    return await use(mutant.url);
  } finally {
    await mutant.cleanup();
  }
}

/**
 * Import a planted mutant and check it loaded: it must export something, and each
 * named export must be a function. A truncated or half-written copy then fails here
 * with a clear message instead of passing a negative control by accident.
 */
export async function importMutant<M extends object>(
  file: URL,
  ...names: (keyof M & string)[]
): Promise<M> {
  const module = (await import(/* @vite-ignore */ file.href)) as M;
  if (Object.keys(module).length === 0)
    throw new Error(`Planted mutant did not load: ${file.href} has no exports`);
  for (const name of names)
    if (typeof module[name] !== "function")
      throw new Error(`Planted mutant did not load: missing export ${name}`);
  return module;
}
