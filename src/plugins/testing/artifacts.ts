import { createHash } from "node:crypto";
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

export interface DigestRequest {
  id: string;
  path: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
}
export interface ResponseDigest {
  status: number;
  body_sha256: string;
  headers: Record<string, string | null>;
}

/** Hash raw response bytes and retain the compatibility headers. */
export async function responseDigests(
  app: {
    request(path: string, init?: RequestInit): Response | Promise<Response>;
  },
  corpus: readonly DigestRequest[],
): Promise<Record<string, ResponseDigest>> {
  const result: Record<string, ResponseDigest> = {};
  for (const entry of corpus) {
    if (Object.hasOwn(result, entry.id))
      throw new Error(`Duplicate corpus id: ${entry.id}`);
    const response = await app.request(entry.path, {
      method: entry.method ?? "GET",
      headers: entry.headers,
      body: entry.body,
    });
    result[entry.id] = {
      status: response.status,
      body_sha256: createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex"),
      headers: Object.fromEntries(
        [
          "content-type",
          "cache-control",
          "x-cache",
          "x-openplans-gaps",
          "x-quote-tier",
        ].map((name) => [name, response.headers.get(name)]),
      ),
    };
  }
  return result;
}
