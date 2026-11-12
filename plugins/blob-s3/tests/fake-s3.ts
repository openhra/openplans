import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  canonicalQuery,
  sha256Hex,
  signingKey,
  stringToSign,
} from "../src/sigv4.js";

/**
 * A loopback, in-process stand-in for an S3-compatible bucket: path-style object PUT, GET,
 * HEAD, DELETE, copy, multipart upload (start, part, complete, abort) and ListObjectsV2 with
 * prefix, delimiter and continuation tokens. It
 * checks every request's Signature Version 4 from what arrives on the wire and rejects a
 * mismatch with 403, as a real server does. Synthetic: it holds only what tests write.
 */
export interface FakeObject {
  body: Buffer;
  meta: Record<string, string>;
}
export interface FakeUpload {
  key: string;
  meta: Record<string, string>;
  parts: Map<number, { body: Buffer; etag: string }>;
}
export interface FakeS3 {
  url: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  objects: Map<string, FakeObject>;
  /** Multipart uploads started and not yet completed or aborted, by upload id. */
  uploads: Map<string, FakeUpload>;
  /** Uploads aborted, by upload id. */
  aborted: string[];
  /**
   * Leaves this part number out when the next upload completes, as a faulty server or proxy
   * might, while still answering 200.
   */
  dropPartOnComplete?: number;
  /** Method and path (no query) of every request, in order. */
  requests: { method: string; path: string; query: string }[];
  /** Raw Authorization headers seen, so tests can check they never leak elsewhere. */
  authorizations: string[];
  /** Objects per list page when the request asks for more. */
  pageLimit: number;
  /** When set, the next matching request gets this status and an XML error body. */
  failNext?: {
    method: string;
    status: number;
    code: string;
    copy?: boolean;
    /** Only a request whose query contains this text. */
    query?: string;
  };
  /** Answers copies with a different body than the source, once. */
  corruptNextCopy: boolean;
  close(): Promise<void>;
}

const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function error(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { "content-type": "application/xml" });
  // Like a real server, a signature error echoes request details; the client must not.
  res.end(
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>synthetic</Message><StringToSign>echoed</StringToSign></Error>`,
  );
}

function decodeQuery(raw: string): [string, string][] {
  if (!raw) return [];
  return raw.split("&").map((part) => {
    const [name, value = ""] = part.split("=");
    return [decodeURIComponent(name!), decodeURIComponent(value)];
  });
}

function verify(
  fake: FakeS3,
  req: IncomingMessage,
  rawPath: string,
  rawQuery: string,
  body: Buffer,
): string | null {
  const authorization = req.headers.authorization ?? "";
  fake.authorizations.push(authorization);
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (!match) return "AccessDenied";
  const [, accessKey, day, region, signedHeaders, signature] = match;
  if (accessKey !== fake.credentials.accessKeyId) return "InvalidAccessKeyId";
  if (region !== fake.region) return "SignatureDoesNotMatch";
  const date = String(req.headers["x-amz-date"] ?? "");
  if (date.slice(0, 8) !== day) return "SignatureDoesNotMatch";
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== sha256Hex(body)) return "XAmzContentSHA256Mismatch";
  const names = signedHeaders!.split(";");
  for (const required of ["host", "x-amz-date", "x-amz-content-sha256"])
    if (!names.includes(required)) return "SignatureDoesNotMatch";
  for (const name of Object.keys(req.headers))
    if (name.startsWith("x-amz-") && !names.includes(name))
      return "SignatureDoesNotMatch";
  // Built from the wire, independently of the client's canonical request.
  const canonical = [
    req.method,
    rawPath,
    canonicalQuery(decodeQuery(rawQuery)),
    names
      .map(
        (name) =>
          `${name}:${String(req.headers[name] ?? "")
            .trim()
            .replace(/ +/g, " ")}\n`,
      )
      .join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const expected = createHmac(
    "sha256",
    signingKey(fake.credentials.secretAccessKey, day!, region!, "s3"),
  )
    .update(stringToSign(date, `${day}/${region}/s3/aws4_request`, canonical))
    .digest("hex");
  return expected === signature ? null : "SignatureDoesNotMatch";
}

function objectHeaders(object: FakeObject) {
  return {
    "content-length": String(object.body.length),
    "content-type": "application/octet-stream",
    ...Object.fromEntries(
      Object.entries(object.meta).map(([name, value]) => [
        `x-amz-meta-${name}`,
        value,
      ]),
    ),
  };
}

function list(fake: FakeS3, res: ServerResponse, query: URLSearchParams) {
  const prefix = query.get("prefix") ?? "";
  const delimiter = query.get("delimiter");
  const max = Math.min(Number(query.get("max-keys") ?? 1000), fake.pageLimit);
  const after = query.get("continuation-token")
    ? Buffer.from(query.get("continuation-token")!, "base64url").toString()
    : "";
  const entries: { name: string; prefix: boolean }[] = [];
  const seen = new Set<string>();
  for (const name of [...fake.objects.keys()].sort()) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    const entry =
      cut >= 0
        ? { name: prefix + rest.slice(0, cut + 1), prefix: true }
        : { name, prefix: false };
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    entries.push(entry);
  }
  const remaining = entries.filter((entry) => entry.name > after);
  const page = remaining.slice(0, max);
  const truncated = remaining.length > page.length;
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${fake.bucket}</Name>` +
      `<Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
      page
        .filter((entry) => !entry.prefix)
        .map(
          (entry) =>
            `<Contents><Key>${xmlEscape(entry.name)}</Key><Size>${fake.objects.get(entry.name)!.body.length}</Size></Contents>`,
        )
        .join("") +
      page
        .filter((entry) => entry.prefix)
        .map(
          (entry) =>
            `<CommonPrefixes><Prefix>${xmlEscape(entry.name)}</Prefix></CommonPrefixes>`,
        )
        .join("") +
      `<IsTruncated>${truncated}</IsTruncated>` +
      (truncated
        ? `<NextContinuationToken>${Buffer.from(page.at(-1)!.name).toString("base64url")}</NextContinuationToken>`
        : "") +
      `</ListBucketResult>`,
  );
}

/** S3's smallest part, except for the last one. */
const MIN_PART = 5 * 1024 * 1024;
let uploadCounter = 0;

function multipart(
  fake: FakeS3,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  query: URLSearchParams,
  body: Buffer,
) {
  if (req.method === "POST" && query.has("uploads")) {
    const meta: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers))
      if (name.startsWith("x-amz-meta-")) meta[name.slice(11)] = String(value);
    const id = `synthetic-upload-${++uploadCounter}`;
    fake.uploads.set(id, { key, meta, parts: new Map() });
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(
      `<InitiateMultipartUploadResult><Bucket>${fake.bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  }
  const id = query.get("uploadId") ?? "";
  const upload = fake.uploads.get(id);
  if (!upload || upload.key !== key) return error(res, 404, "NoSuchUpload");
  if (req.method === "PUT") {
    const number = Number(query.get("partNumber"));
    if (!Number.isInteger(number) || number < 1 || number > 10_000)
      return error(res, 400, "InvalidArgument");
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    upload.parts.set(number, { body, etag });
    res.writeHead(200, { etag });
    return res.end();
  }
  if (req.method === "DELETE") {
    fake.uploads.delete(id);
    fake.aborted.push(id);
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST") return error(res, 405, "MethodNotAllowed");
  if (req.headers["if-none-match"] === "*" && fake.objects.has(key))
    return error(res, 412, "PreconditionFailed");
  const listed = [
    ...body.toString("utf8").matchAll(/<Part>([\s\S]*?)<\/Part>/g),
  ].map((match) => ({
    number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(match[1]!)?.[1]),
    etag: (/<ETag>([\s\S]*?)<\/ETag>/.exec(match[1]!)?.[1] ?? "").replace(
      /&quot;/g,
      '"',
    ),
  }));
  if (!listed.length) return error(res, 400, "MalformedXML");
  const bodies: Buffer[] = [];
  for (const [index, entry] of listed.entries()) {
    const part = upload.parts.get(entry.number);
    if (!part || part.etag !== entry.etag)
      return error(res, 400, "InvalidPart");
    if (index && entry.number <= listed[index - 1]!.number)
      return error(res, 400, "InvalidPartOrder");
    if (index < listed.length - 1 && part.body.length < MIN_PART)
      return error(res, 400, "EntityTooSmall");
    if (entry.number !== fake.dropPartOnComplete) bodies.push(part.body);
  }
  fake.dropPartOnComplete = undefined;
  fake.objects.set(key, { body: Buffer.concat(bodies), meta: upload.meta });
  fake.uploads.delete(id);
  res.writeHead(200, { "content-type": "application/xml" });
  return res.end(
    `<CompleteMultipartUploadResult><Key>${xmlEscape(key)}</Key><ETag>"synthetic-${listed.length}"</ETag></CompleteMultipartUploadResult>`,
  );
}

export async function startFakeS3(): Promise<FakeS3> {
  const fake: FakeS3 = {
    url: "",
    region: "us-test-1",
    bucket: "synthetic-bucket",
    credentials: {
      accessKeyId: "SYNTHETICKEYID",
      secretAccessKey: "synthetic/secret+value",
    },
    objects: new Map(),
    uploads: new Map(),
    aborted: [],
    requests: [],
    authorizations: [],
    pageLimit: 2,
    corruptNextCopy: false,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      const [rawPath = "/", rawQuery = ""] = (req.url ?? "/").split("?");
      fake.requests.push({
        method: req.method ?? "",
        path: rawPath,
        query: rawQuery,
      });
      const problem = verify(fake, req, rawPath, rawQuery, body);
      if (problem) return error(res, 403, problem);
      const copySource = req.headers["x-amz-copy-source"];
      const injected = fake.failNext;
      if (
        injected &&
        injected.method === req.method &&
        (injected.copy === undefined ||
          injected.copy === Boolean(copySource)) &&
        (injected.query === undefined || rawQuery.includes(injected.query))
      ) {
        fake.failNext = undefined;
        return error(res, injected.status, injected.code);
      }
      const segments = rawPath.split("/");
      if (segments[1] !== fake.bucket) return error(res, 404, "NoSuchBucket");
      const key = decodeURIComponent(segments.slice(2).join("/"));
      if (!key) {
        if (req.method === "GET")
          return list(fake, res, new URLSearchParams(rawQuery));
        return error(res, 405, "MethodNotAllowed");
      }
      const query = new URLSearchParams(rawQuery);
      if (query.has("uploads") || query.has("uploadId"))
        return multipart(fake, req, res, key, query, body);
      const object = fake.objects.get(key);
      switch (req.method) {
        case "HEAD":
        case "GET":
          if (!object) return error(res, 404, "NoSuchKey");
          res.writeHead(200, objectHeaders(object));
          return res.end(req.method === "GET" ? object.body : undefined);
        case "PUT": {
          if (req.headers["if-none-match"] === "*" && object)
            return error(res, 412, "PreconditionFailed");
          if (typeof copySource === "string") {
            const [, bucket, ...rest] = copySource.split("/");
            const source = fake.objects.get(decodeURIComponent(rest.join("/")));
            if (bucket !== fake.bucket || !source)
              return error(res, 404, "NoSuchKey");
            const copied = {
              body: Buffer.from(source.body),
              meta: { ...source.meta },
            };
            if (fake.corruptNextCopy) {
              fake.corruptNextCopy = false;
              copied.body = Buffer.concat([copied.body, Buffer.from("x")]);
            }
            fake.objects.set(key, copied);
            res.writeHead(200, { "content-type": "application/xml" });
            return res.end(
              "<CopyObjectResult><ETag>synthetic</ETag></CopyObjectResult>",
            );
          }
          const meta: Record<string, string> = {};
          for (const [name, value] of Object.entries(req.headers))
            if (name.startsWith("x-amz-meta-"))
              meta[name.slice(11)] = String(value);
          fake.objects.set(key, { body, meta });
          res.writeHead(200);
          return res.end();
        }
        case "DELETE":
          fake.objects.delete(key);
          res.writeHead(204);
          return res.end();
        default:
          return error(res, 405, "MethodNotAllowed");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
