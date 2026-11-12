import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { BlobStore } from "@openplans/plugin-sdk";
import { amzDate, EMPTY_SHA256, sha256Hex, sign, uriEncode } from "./sigv4.js";
import type { Credentials } from "./sigv4.js";

export interface S3BlobStoreSettings {
  /** `https://host[:port]`. Plain `http:` is accepted only for a loopback host. */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  /** Optional key prefix inside the bucket, made of plain key segments. */
  prefix?: string;
  /**
   * Largest body `put` accepts, 5 GiB by default: `publish` moves an object with one copy
   * request, which S3 limits to 5 GiB.
   */
  maxObjectBytes?: number;
  /**
   * Bodies up to this size go up in one PUT; larger ones go up as a multipart upload in parts of
   * this size. `put` holds at most two parts in memory to hash and sign them. 64 MiB by default;
   * at least 5 MiB, the smallest part S3 accepts.
   */
  partBytes?: number;
  /** Per-request time limit. */
  timeoutMs?: number;
  /** Objects per list page the store asks for (the server may return fewer). */
  pageSize?: number;
  /**
   * True when the caller's request scope forbids storing (cache level `none` or `request`).
   * Every write checks it first and makes no request when it is true.
   */
  forbidsStorage?: () => boolean;
  /** Clock for request dates. */
  now?: () => Date;
}

export const DEFAULT_MAX_OBJECT_BYTES = 5 * 1024 ** 3;
export const DEFAULT_PART_BYTES = 64 * 1024 ** 2;
export const MIN_PART_BYTES = 5 * 1024 ** 2;
/** S3 allows at most this many parts in one upload. */
const MAX_PARTS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** An error with a `code`, like the Node fs errors the local store raises. */
export class BlobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BlobError";
  }
}

const segment = /^[A-Za-z0-9._-]{1,255}$/;
/** The local store's key rule: relative POSIX paths of plain segments, no `.` or `..`. */
export function checkedKey(key: string): string {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (
    !parts.length ||
    parts.some((part) => !segment.test(part) || part === "." || part === "..")
  )
    throw new BlobError("invalid_key", "Invalid blob key");
  return key;
}

/** Checks an endpoint and returns its URL. Never echoes the value in an error. */
export function checkedEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BlobError("invalid_endpoint", "S3 endpoint is not a URL");
  }
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK.has(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new BlobError(
      "invalid_endpoint",
      "S3 endpoint must be an https origin (http only for loopback) with no path, query or credentials",
    );
  return url;
}

interface Response {
  status: number;
  headers: IncomingMessage["headers"];
  body: IncomingMessage;
}

const header = (headers: IncomingMessage["headers"], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

async function readCapped(body: AsyncIterable<Uint8Array>, cap: number) {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > cap)
      throw new BlobError("too_large", "S3 response exceeds its size cap");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/**
 * Reads a body in parts of a fixed size. Each part is one buffer; the last may be shorter, and
 * an empty part means the body ended. The running total is checked against `cap` as it grows.
 */
class PartReader {
  private carry: Buffer = Buffer.alloc(0);
  private ended = false;
  total = 0;

  constructor(
    private readonly iterator: AsyncIterator<Uint8Array>,
    private readonly cap: number,
  ) {}

  async next(size: number): Promise<Buffer> {
    const parts = [this.carry];
    let held = this.carry.length;
    while (held < size && !this.ended) {
      const step = await this.iterator.next();
      if (step.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(step.value)
        ? step.value
        : Buffer.from(step.value);
      this.total += chunk.length;
      if (this.total > this.cap)
        throw new BlobError("too_large", "Blob exceeds its size cap");
      parts.push(chunk);
      held += chunk.length;
    }
    const all = parts.length === 1 ? parts[0]! : Buffer.concat(parts, held);
    this.carry = all.subarray(Math.min(size, all.length));
    return all.subarray(0, Math.min(size, all.length));
  }

  /** Stops the source when `put` gives up before the body ends. */
  async close(): Promise<void> {
    if (!this.ended) await this.iterator.return?.();
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
/** XML text with the five predefined entities and numeric references decoded. */
function xmlText(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_, hex?: string, dec?: string, name?: string) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return ENTITIES[name!.toLowerCase()]!;
    },
  );
}
const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tags = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map(
    (match) => match[1]!,
  );

/** Only the error code: S3 error bodies can echo the string to sign. */
async function failure(response: Response, what: string): Promise<never> {
  let code = "";
  try {
    const xml = (await readCapped(response.body, 64 * 1024)).toString("utf8");
    code = /^[A-Za-z]{1,64}$/.test(tags(xml, "Code")[0] ?? "")
      ? tags(xml, "Code")[0]!
      : "";
  } catch {
    response.body.destroy();
  }
  throw new BlobError(
    response.status === 403 ? "s3_forbidden" : "s3_error",
    `S3 ${what} failed with status ${response.status}${code ? ` (${code})` : ""}`,
  );
}

/**
 * Design 5.7: the `s3` blob provider. It stores the local store's keys as objects in one
 * bucket, signs every request with Signature Version 4 and records each object's SHA-256 in
 * `x-amz-meta-sha256`, which `get` checks while the body streams.
 */
export class S3BlobStore implements BlobStore {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly credentials: Credentials;
  private readonly prefix: string;
  private readonly maxObjectBytes: number;
  private readonly partBytes: number;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly forbidsStorage: () => boolean;
  private readonly now: () => Date;

  constructor(settings: S3BlobStoreSettings) {
    this.endpoint = checkedEndpoint(settings.endpoint);
    if (!/^[a-z0-9-]{1,64}$/.test(settings.region))
      throw new BlobError("invalid_region", "S3 region is not valid");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket))
      throw new BlobError("invalid_bucket", "S3 bucket name is not valid");
    if (
      !settings.credentials.accessKeyId ||
      !settings.credentials.secretAccessKey
    )
      throw new BlobError("missing_credentials", "S3 credentials are missing");
    this.region = settings.region;
    this.bucket = settings.bucket;
    this.credentials = Object.freeze({ ...settings.credentials });
    this.prefix = settings.prefix ? `${checkedKey(settings.prefix)}/` : "";
    this.maxObjectBytes = settings.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.partBytes = settings.partBytes ?? DEFAULT_PART_BYTES;
    if (
      !Number.isSafeInteger(this.partBytes) ||
      this.partBytes < MIN_PART_BYTES ||
      this.partBytes > DEFAULT_MAX_OBJECT_BYTES
    )
      throw new BlobError(
        "invalid_part_size",
        "S3 part size must be between 5 MiB and 5 GiB",
      );
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = settings.pageSize ?? 1000;
    this.forbidsStorage = settings.forbidsStorage ?? (() => false);
    this.now = settings.now ?? (() => new Date());
  }

  /** Keeps credentials out of logs, inspection and JSON. */
  toJSON() {
    return { provider: "s3", bucket: this.bucket };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `S3BlobStore { bucket: ${this.bucket} }`;
  }

  private refuseInRestrictedScope(): void {
    // Design 5.10.4: a `none` or `request` answer is never stored, whoever asks the store.
    if (this.forbidsStorage())
      throw new BlobError(
        "storage_forbidden",
        "The request's cache level forbids storing a payload",
      );
  }

  private objectKey(key: string): string {
    return `${this.prefix}${checkedKey(key)}`;
  }
  private objectPath(objectKey: string): string {
    return `/${this.bucket}/${uriEncode(objectKey, true)}`;
  }

  private send(
    method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE",
    path: string,
    options: {
      query?: [string, string][];
      headers?: Record<string, string>;
      body?: Buffer;
    } = {},
  ): Promise<Response> {
    const body = options.body;
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      "x-amz-date": amzDate(this.now()),
      "x-amz-content-sha256": payloadHash,
      ...(this.credentials.sessionToken
        ? { "x-amz-security-token": this.credentials.sessionToken }
        : {}),
      ...options.headers,
    };
    if (body) headers["content-length"] = String(body.length);
    const { authorization } = sign(
      { method, path, query: options.query, headers, payloadHash },
      this.credentials,
      this.region,
      "s3",
    );
    const search = (options.query ?? [])
      .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
      .join("&");
    const request =
      this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname.replace(/^\[|\]$/g, ""),
          port: this.endpoint.port || undefined,
          method,
          path: search ? `${path}?${search}` : path,
          headers: { ...headers, authorization },
          timeout: this.timeoutMs,
        },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
          }),
      );
      outgoing.on("timeout", () =>
        outgoing.destroy(new BlobError("s3_timeout", `S3 ${method} timed out`)),
      );
      // Network errors name the host at most, never the signed request.
      outgoing.on("error", (error) =>
        reject(
          error instanceof BlobError
            ? error
            : new BlobError("s3_unreachable", `S3 ${method} request failed`),
        ),
      );
      outgoing.end(body);
    });
  }

  private async head(
    objectKey: string,
  ): Promise<{ bytes: number; sha256: string | null } | null> {
    const response = await this.send("HEAD", this.objectPath(objectKey));
    response.body.resume();
    if (response.status === 404) return null;
    if (response.status !== 200) return failure(response, "HEAD");
    const sha256 = header(response.headers, "x-amz-meta-sha256") ?? null;
    return {
      bytes: Number(header(response.headers, "content-length") ?? 0),
      sha256: sha256 && SHA256.test(sha256) ? sha256 : null,
    };
  }

  /**
   * Writes a new key; never replaces one. A failed write leaves no key behind. A body larger
   * than `partBytes` goes up as a multipart upload and needs `meta.sha256`, because S3 records an
   * object's metadata before its first part.
   */
  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { sha256?: string } = {},
  ): Promise<{ bytes: number; sha256: string }> {
    this.refuseInRestrictedScope();
    const objectKey = this.objectKey(key);
    const reader = new PartReader(
      body[Symbol.asyncIterator](),
      this.maxObjectBytes,
    );
    try {
      const first = await reader.next(this.partBytes);
      const second =
        first.length < this.partBytes
          ? Buffer.alloc(0)
          : await reader.next(this.partBytes);
      if (!second.length) return await this.putSingle(objectKey, first, meta);
      if (meta.sha256 === undefined || !SHA256.test(meta.sha256))
        throw new BlobError(
          "sha256_required",
          "A multipart upload needs the body's expected SHA-256",
        );
      return await this.putMultipart(
        objectKey,
        reader,
        [first, second],
        meta.sha256,
      );
    } finally {
      await reader.close();
    }
  }

  private async putSingle(
    objectKey: string,
    content: Buffer,
    meta: { sha256?: string },
  ): Promise<{ bytes: number; sha256: string }> {
    const sha256 = sha256Hex(content);
    if (meta.sha256 !== undefined && meta.sha256 !== sha256)
      throw new BlobError("hash_mismatch", "Blob hash differs from expected");
    // If-None-Match makes the write exclusive where the server supports it; the HEAD covers
    // servers that ignore the header.
    if (await this.head(objectKey))
      throw new BlobError("EEXIST", "Blob key already exists");
    const response = await this.send("PUT", this.objectPath(objectKey), {
      headers: {
        "if-none-match": "*",
        "x-amz-meta-sha256": sha256,
        "content-type": "application/octet-stream",
      },
      body: content,
    });
    if (response.status === 412) {
      response.body.resume();
      throw new BlobError("EEXIST", "Blob key already exists");
    }
    if (response.status !== 200) return failure(response, "PUT");
    response.body.resume();
    return { bytes: content.length, sha256 };
  }

  /**
   * One multipart upload. Every part is signed with its own SHA-256, which the server checks;
   * the whole body's SHA-256 must equal `expected` before the upload is completed; and the
   * completed object must have the size sent and the hash recorded. Any failure aborts the
   * upload, so no part outlives it, and a completed object that fails the last check is deleted.
   */
  private async putMultipart(
    objectKey: string,
    reader: PartReader,
    pending: Buffer[],
    expected: string,
  ): Promise<{ bytes: number; sha256: string }> {
    if (await this.head(objectKey))
      throw new BlobError("EEXIST", "Blob key already exists");
    const path = this.objectPath(objectKey);
    const created = await this.send("POST", path, {
      query: [["uploads", ""]],
      headers: {
        "x-amz-meta-sha256": expected,
        "content-type": "application/octet-stream",
      },
    });
    if (created.status !== 200) return failure(created, "multipart start");
    const uploadId = xmlText(
      tags(
        (await readCapped(created.body, 64 * 1024)).toString("utf8"),
        "UploadId",
      )[0] ?? "",
    );
    if (!uploadId)
      throw new BlobError("s3_error", "S3 multipart start returned no upload");
    const hash = createHash("sha256");
    const parts: { number: number; etag: string }[] = [];
    let bytes = 0;
    try {
      for (
        let part = pending.shift();
        part?.length;
        part = pending.shift() ?? (await reader.next(this.partBytes))
      ) {
        const number = parts.length + 1;
        if (number > MAX_PARTS)
          throw new BlobError("too_large", "Blob needs too many parts");
        hash.update(part);
        bytes += part.length;
        const response = await this.send("PUT", path, {
          query: [
            ["partNumber", String(number)],
            ["uploadId", uploadId],
          ],
          body: part,
        });
        if (response.status !== 200) return await failure(response, "part");
        response.body.resume();
        const etag = header(response.headers, "etag");
        if (!etag) throw new BlobError("s3_error", "S3 part has no ETag");
        parts.push({ number, etag });
      }
      const sent = hash.digest("hex");
      if (sent !== expected)
        throw new BlobError("hash_mismatch", "Blob hash differs from expected");
      const list = parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.number}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
        )
        .join("");
      const response = await this.send("POST", path, {
        query: [["uploadId", uploadId]],
        headers: { "content-type": "application/xml", "if-none-match": "*" },
        body: Buffer.from(
          `<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`,
        ),
      });
      if (response.status === 412) {
        response.body.resume();
        throw new BlobError("EEXIST", "Blob key already exists");
      }
      if (response.status !== 200) return await failure(response, "complete");
      // Like a copy, a completion can fail after the 200 status line.
      const xml = (await readCapped(response.body, 64 * 1024)).toString("utf8");
      if (tags(xml, "Code").length)
        throw new BlobError("s3_error", "S3 multipart completion failed");
    } catch (error) {
      await this.abort(path, uploadId);
      throw error;
    }
    const stored = await this.head(objectKey);
    if (!stored || stored.bytes !== bytes || stored.sha256 !== expected) {
      if (stored) await this.remove(objectKey).catch(() => {});
      throw new BlobError(
        "upload_mismatch",
        "S3 object does not match the uploaded body",
      );
    }
    return { bytes, sha256: expected };
  }

  /** Best effort: a failed abort leaves parts the bucket's lifecycle rule must expire. */
  private async abort(path: string, uploadId: string): Promise<void> {
    try {
      const response = await this.send("DELETE", path, {
        query: [["uploadId", uploadId]],
      });
      response.body.resume();
    } catch {
      // The caller's error is the one that matters.
    }
  }

  /**
   * Starts the download now, so a missing key is `null`. The body's SHA-256 is checked against
   * the recorded one as it streams; a mismatch, a short body or a missing record throws before
   * the iteration ends.
   */
  async get(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const response = await this.send(
      "GET",
      this.objectPath(this.objectKey(key)),
    );
    if (response.status === 404) {
      response.body.resume();
      return null;
    }
    if (response.status !== 200) return failure(response, "GET");
    const expected = header(response.headers, "x-amz-meta-sha256");
    if (!expected || !SHA256.test(expected)) {
      response.body.destroy();
      throw new BlobError(
        "hash_unrecorded",
        "Blob has no recorded SHA-256 to verify",
      );
    }
    return verified(response.body, expected);
  }

  async stat(
    key: string,
  ): Promise<{ bytes: number; sha256: string | null } | null> {
    return this.head(this.objectKey(key));
  }

  /** One ListObjectsV2 walk, following continuation tokens until the listing ends. */
  private async *walk(
    prefix: string,
    delimiter: boolean,
  ): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const query: [string, string][] = [
        ["list-type", "2"],
        ["prefix", prefix],
        ["max-keys", String(this.pageSize)],
        ...(delimiter ? [["delimiter", "/"] as [string, string]] : []),
        ...(token ? [["continuation-token", token] as [string, string]] : []),
      ];
      const response = await this.send("GET", `/${this.bucket}`, { query });
      if (response.status !== 200) return failure(response, "list");
      const xml = (await readCapped(response.body, MAX_LIST_BYTES)).toString(
        "utf8",
      );
      for (const entry of tags(xml, "Contents"))
        for (const name of tags(entry, "Key")) yield xmlText(name);
      for (const entry of tags(xml, "CommonPrefixes"))
        for (const name of tags(entry, "Prefix")) yield xmlText(name);
      const truncated = tags(xml, "IsTruncated")[0] === "true";
      const next = tags(xml, "NextContinuationToken")[0];
      if (truncated && !next)
        throw new BlobError(
          "s3_error",
          "S3 list page has no continuation token",
        );
      token = truncated ? xmlText(next!) : undefined;
    } while (token);
  }

  /**
   * The direct children of `prefix`, as the local store lists them: `prefix/name` for an
   * object and `prefix/name/` for a deeper prefix.
   */
  async *list(prefix: string): AsyncIterable<string> {
    const base = `${this.objectKey(prefix)}/`;
    for await (const name of this.walk(base, true))
      if (name.startsWith(base)) yield name.slice(this.prefix.length);
  }

  /** Every object under `objectKey/`, at any depth. */
  private async tree(objectKey: string): Promise<string[]> {
    const names: string[] = [];
    for await (const name of this.walk(`${objectKey}/`, false))
      names.push(name);
    return names;
  }

  /**
   * Moves a key, or every key under a prefix, to `finalKey` by copy, check, then delete.
   * Refuses with `EEXIST` when `finalKey` already exists as a key or a prefix, as a rename onto a
   * non-empty directory does. Each copy is checked by size and SHA-256 before any source is
   * deleted; a failed copy removes the copies already made.
   */
  async publish(temporaryKey: string, finalKey: string): Promise<void> {
    this.refuseInRestrictedScope();
    const from = this.objectKey(temporaryKey);
    const to = this.objectKey(finalKey);
    const single = await this.head(from);
    const moves = single
      ? [{ from, to, source: single }]
      : await Promise.all(
          (await this.tree(from)).map(async (name) => ({
            from: name,
            to: `${to}${name.slice(from.length)}`,
            source: await this.head(name),
          })),
        );
    if (!moves.length || moves.some((move) => !move.source))
      throw new BlobError("ENOENT", "Temporary blob key does not exist");
    if (await this.exists(to))
      throw new BlobError("EEXIST", "Blob key already exists");
    const copied: string[] = [];
    try {
      for (const move of moves) {
        await this.copy(move.from, move.to);
        copied.push(move.to);
        const copy = await this.head(move.to);
        if (
          !copy ||
          copy.bytes !== move.source!.bytes ||
          copy.sha256 !== move.source!.sha256
        )
          throw new BlobError(
            "copy_mismatch",
            "S3 copy does not match its source",
          );
      }
    } catch (error) {
      for (const name of copied) await this.remove(name).catch(() => {});
      throw error;
    }
    for (const move of moves) await this.remove(move.from);
    if ((await this.head(from)) || (await this.tree(from)).length)
      throw new BlobError("s3_error", "Temporary blob key is still present");
  }

  /** True when `objectKey` is an object or a non-empty prefix. */
  private async exists(objectKey: string): Promise<boolean> {
    if (await this.head(objectKey)) return true;
    for await (const _name of this.walk(`${objectKey}/`, true)) {
      void _name;
      return true;
    }
    return false;
  }

  private async copy(from: string, to: string): Promise<void> {
    const response = await this.send("PUT", this.objectPath(to), {
      headers: {
        "x-amz-copy-source": this.objectPath(from),
        "x-amz-metadata-directive": "COPY",
      },
    });
    const xml = (await readCapped(response.body, 64 * 1024)).toString("utf8");
    // A copy can fail after the 200 status line; the body then holds an Error element.
    if (response.status !== 200 || tags(xml, "Code").length)
      throw new BlobError(
        "s3_error",
        `S3 copy failed with status ${response.status}`,
      );
  }

  /** Removes one key. A missing key is not an error. */
  async delete(key: string): Promise<void> {
    await this.remove(this.objectKey(key));
  }

  private async remove(objectKey: string): Promise<void> {
    const response = await this.send("DELETE", this.objectPath(objectKey));
    if (![200, 204, 404].includes(response.status))
      return failure(response, "DELETE");
    response.body.resume();
  }
}

async function* verified(
  body: AsyncIterable<Uint8Array>,
  expected: string,
): AsyncIterable<Uint8Array> {
  const hash = createHash("sha256");
  for await (const chunk of body) {
    hash.update(chunk);
    yield chunk;
  }
  if (hash.digest("hex") !== expected)
    throw new BlobError(
      "hash_mismatch",
      "Blob content does not match its recorded SHA-256",
    );
}
