import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  rebaseImports,
  replaceSyntax,
} from "../../../scripts/source-mutation.mjs";

/** Mutate a disposable copy; the source file is never written. */
export async function plantMutant(
  file: string | URL,
  before: string,
  after: string,
) {
  const original = typeof file === "string" ? pathToFileURL(file) : file;
  const source = replaceSyntax(await readFile(original, "utf8"), before, after);
  const directory = await mkdtemp(
    join(dirname(fileURLToPath(original)), ".openplans-mutant-"),
  );
  const path = join(directory, basename(fileURLToPath(original)));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
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
