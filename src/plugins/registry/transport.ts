import { constants } from "node:fs";
import { open, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Fetcher } from "tuf-js";
import { PACKAGE_LIMITS } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { fetchTransient, FetchError } from "../../fetch/index.js";
import type { TransientFetchOptions } from "../../fetch/index.js";

export const REGISTRY_LIMITS = Object.freeze({
  root: 1024 * 1024,
  metadata: 4 * 1024 * 1024,
  artifact: PACKAGE_LIMITS.codeCompressedBytes,
  targets: 1000,
});

export function registryUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["file:", "https:", "http:"].includes(url.protocol) ||
    (url.protocol === "file:" && url.host) ||
    (url.protocol === "http:" && url.hostname !== "127.0.0.1")
  )
    throw new Error("registry_url_refused");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function safeTargetPath(path: string): void {
  if (
    path.length > 512 ||
    !path
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_@.-]+$/.test(part) && part !== "." && part !== "..",
      ) ||
    path.startsWith("/")
  )
    throw new Error("registry_target_path_refused");
}

/** Only this transport admits remote registry reads; TUF still verifies their bytes. */
export class RegistryFetcher implements Fetcher {
  constructor(
    private readonly base: URL,
    private readonly quarantine: string,
    private readonly dataDir: string,
    private readonly admission: Pick<
      TransientFetchOptions,
      "admission" | "projectUrl"
    > = {},
  ) {}

  private async stream(input: string, maximum: number): Promise<Readable> {
    const url = new URL(input);
    if (url.origin !== this.base.origin || !url.href.startsWith(this.base.href))
      throw new Error("registry_transport_origin_refused");
    const suffix = url.pathname.slice(this.base.pathname.length);
    safeTargetPath(suffix);
    if (url.protocol === "file:") {
      const path = fileURLToPath(url);
      const base = await realpath(fileURLToPath(this.base));
      const actual = await realpath(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          throw new DownloadHTTPError("Registry file absent", 404);
        throw error;
      });
      const inside = relative(base, actual);
      if (
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new Error("registry_file_outside_root");
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maximum)
          throw new Error("registry_download_size_refused");
        return handle.createReadStream();
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    if (url.protocol === "http:") {
      // Plain HTTP is confined to an explicitly configured IPv4 loopback fixture server.
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new DownloadHTTPError(
          "Registry HTTP read refused",
          response.status,
        );
      }
      const reader = response.body.getReader();
      return Readable.from(
        (async function* () {
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              yield result.value;
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        })(),
      );
    }
    try {
      const result = await fetchTransient(url.href, {
        ...this.admission,
        dataDir: this.dataDir,
        allowHosts: [this.base.hostname],
        maxBytes: maximum,
        maxDecompressedBytes: maximum,
        maxRedirects: 0,
        maxAttempts: 1,
        expectedContent: "binary",
      });
      return Readable.from([result.body]);
    } catch (error) {
      if (
        error instanceof FetchError &&
        error.code === "http_status" &&
        error.status
      )
        throw new DownloadHTTPError("Registry HTTP read refused", error.status);
      throw error;
    }
  }

  async downloadFile<T>(
    url: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0)
      throw new Error("registry_download_size_refused");
    const metadata =
      /\/(?:timestamp|(?:\d+\.)?(?:root|snapshot|targets))\.json$/.test(
        new URL(url).pathname,
      );
    const maximum = Math.min(
      maxLength,
      metadata ? REGISTRY_LIMITS.metadata : REGISTRY_LIMITS.artifact,
    );
    await mkdir(this.quarantine, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.quarantine, "read-"));
    try {
      const file = join(directory, "bytes");
      const handle = await open(file, "wx", 0o600);
      let received = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(
            received > maximum
              ? new Error("registry_download_size_refused")
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          await this.stream(url, maximum),
          bounded,
          handle.createWriteStream(),
        );
      } finally {
        await handle.close();
      }
      return await handler(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    return this.downloadFile(url, maxLength, (file) => readFile(file));
  }
}

export async function boundedRead(
  path: string,
  limit: number,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error("registry_local_file_refused");
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error("registry_local_file_refused");
    return bytes;
  } finally {
    await handle.close();
  }
}
