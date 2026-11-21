import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import {
  PACKAGE_LIMITS,
  packagePathSchema,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import type { PackageFile } from "@openplans/plugin-sdk/dist/package-manifest.js";

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const order = (a: string, b: string) => Number(a > b) - Number(a < b);

export function safePath(path: string): string {
  return packagePathSchema.parse(path);
}

/** Reject duplicate keys before JSON.parse can silently replace security declarations. */
export function parsePackageJson(bytes: Uint8Array): unknown {
  if (bytes.length > PACKAGE_LIMITS.descriptorBytes)
    throw new Error("Package descriptor size cap exceeded");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g;
  const items = [...text.matchAll(tokens)].map((match) => match[0]);
  for (let index = 0; index < items.length; index++) {
    const token = items[index]!;
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && items[index + 1] === ":") {
      const key: unknown = JSON.parse(token);
      const keys = stack.at(-1);
      if (typeof key !== "string" || !keys || keys.has(key))
        throw new Error("Duplicate JSON key");
      keys.add(key);
    }
  }
  return JSON.parse(text) as unknown;
}

export async function readPackageDocument(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > PACKAGE_LIMITS.descriptorBytes)
      throw new Error("Package descriptor size cap exceeded");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > PACKAGE_LIMITS.descriptorBytes)
        throw new Error("Package descriptor size cap exceeded");
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    return { value: parsePackageJson(body), sha256: sha256(body) };
  } finally {
    await handle.close();
  }
}

export async function readPackageJson(path: string): Promise<unknown> {
  return (await readPackageDocument(path)).value;
}

export async function fileDigest(
  path: string,
  maxBytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > maxBytes)
      throw new Error("Package input exceeded its inspected size");
    hash.update(buffer);
  }
  if (bytes !== maxBytes)
    throw new Error("Package input changed while hashing");
  return hash.digest("hex");
}

export async function inventory(
  root: string,
  maxBytes: number,
): Promise<PackageFile[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Package root must be a real directory");
  const files: PackageFile[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  const walk = async (directory: string, prefix: string) => {
    for (const name of (await readdir(directory)).sort(order)) {
      const path = safePath(prefix + name);
      const full = join(directory, name);
      const info = await lstat(full);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.nlink > 1 && info.isFile())
      )
        throw new Error("Package links and special files are refused");
      if (paths.has(path.toLowerCase()))
        throw new Error("Duplicate package path");
      paths.add(path.toLowerCase());
      if (paths.size > PACKAGE_LIMITS.files * 2)
        throw new Error("Package entry count cap exceeded");
      if (info.isDirectory()) {
        await walk(full, `${path}/`);
        continue;
      }
      bytes += info.size;
      if (files.length >= PACKAGE_LIMITS.files || bytes > maxBytes)
        throw new Error("Package file count or expanded size cap exceeded");
      files.push({
        path,
        bytes: info.size,
        sha256: await fileDigest(full, info.size),
      });
    }
  };
  await walk(root, "");
  return files.sort((a, b) => order(a.path, b.path));
}

/** Copy only inspected regular files, with byte bounds even if the input changes. */
export async function copyPackageFiles(
  root: string,
  destination: string,
  files: readonly PackageFile[],
): Promise<void> {
  for (const file of files) {
    const handle = await open(
      join(root, safePath(file.path)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size !== file.bytes)
        throw new Error("Package input changed");
      await mkdir(dirname(join(destination, file.path)), {
        recursive: true,
        mode: 0o755,
      });
      let bytes = 0;
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            done(
              bytes > file.bytes
                ? new Error("Package input grew while copying")
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(join(destination, file.path), {
          flags: "wx",
          mode: 0o644,
        }),
      );
      if (bytes !== file.bytes) throw new Error("Package input changed");
    } finally {
      await handle.close();
    }
  }
}

/** Canonical permissions apply only to the private payload copy. */
export async function normalizePackageModes(root: string): Promise<void> {
  let entries = 0;
  const walk = async (full: string, path: string): Promise<void> => {
    if (++entries > PACKAGE_LIMITS.files * 2 + 1)
      throw new Error("Package entry count cap exceeded");
    const info = await lstat(full);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("Package links and special files are refused");
    await chmod(full, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory())
      for (const name of await readdir(full)) {
        const child = safePath(path ? `${path}/${name}` : name);
        await walk(join(full, name), child);
      }
  };
  await walk(root, "");
}
