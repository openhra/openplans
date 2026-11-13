import { createHash, timingSafeEqual } from "node:crypto";
import { compatKeyHeaderName } from "../../config/access.js";

/** Optional additional credential header; validate once before the app listens. */
export function compatKeyHeader(
  value: string | undefined = compatKeyHeaderName(),
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
    throw new Error(
      "OPENPLANS_COMPAT_KEY_HEADER must be a single RFC 7230 token",
    );
  }
  return value;
}

/** Hash to fixed-size buffers so comparison time does not disclose key length. */
export function credentialMatches(
  header: string | undefined,
  token: string,
): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return (
    timingSafeEqual(digest(header ?? ""), digest(token)) &&
    Boolean(header) &&
    Boolean(token)
  );
}
