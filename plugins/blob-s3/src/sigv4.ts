import { createHash, createHmac } from "node:crypto";

/** SHA-256 of an empty body, the payload hash of every bodiless request. */
export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  /** Already URI-encoded path, as sent on the wire. */
  path: string;
  /** Query parameters before encoding. Order does not matter. */
  query?: readonly (readonly [string, string])[];
  /** Header names in any case. Every header given here is signed. */
  headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
}

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding: only unreserved characters stay as they are. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/"))
      out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b));
/** Sorted by encoded name, then by encoded value. */
const byNameThenValue = (
  [a, x]: readonly [string, string],
  [b, y]: readonly [string, string],
) => byCodeUnit(a, b) || byCodeUnit(x, y);

export function canonicalQuery(
  query: readonly (readonly [string, string])[] = [],
): string {
  return query
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(byNameThenValue)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** Lower-case names, values trimmed with inner runs of spaces folded to one. */
function canonicalHeaders(headers: Readonly<Record<string, string>>) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/ +/g, " "),
    ])
    .sort(([a], [b]) => (a! < b! ? -1 : 1));
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

export function canonicalRequest(request: SignableRequest): string {
  const headers = canonicalHeaders(request.headers);
  return [
    request.method,
    request.path,
    canonicalQuery(request.query),
    headers.text,
    headers.signed,
    request.payloadHash,
  ].join("\n");
}

export function signingKey(
  secretAccessKey: string,
  day: string,
  region: string,
  service: string,
): Buffer {
  const dated = hmac(`AWS4${secretAccessKey}`, day);
  return hmac(hmac(hmac(dated, region), service), "aws4_request");
}

export function stringToSign(
  amzDate: string,
  scope: string,
  canonical: string,
): string {
  return ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
}

/** `20150830T123600Z` for a date. */
export const amzDate = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Signature Version 4 for a request whose headers already hold `host` and `x-amz-date`.
 * Returns the `Authorization` header value and the signature alone.
 */
export function sign(
  request: SignableRequest,
  credentials: Credentials,
  region: string,
  service: string,
): { authorization: string; signature: string } {
  const date = Object.entries(request.headers).find(
    ([name]) => name.toLowerCase() === "x-amz-date",
  )?.[1];
  if (!date || !/^\d{8}T\d{6}Z$/.test(date))
    throw new Error("x-amz-date header is required for signing");
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const canonical = canonicalRequest(request);
  const signature = createHmac(
    "sha256",
    signingKey(credentials.secretAccessKey, day, region, service),
  )
    .update(stringToSign(date, scope, canonical))
    .digest("hex");
  const signed = canonicalHeaders(request.headers).signed;
  return {
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}
