import { createHash } from "node:crypto";

export interface ResponseDigest {
  status: number;
  body_sha256: string;
  headers: Record<string, string | null>;
}
export const stableHeaders = [
  "content-type",
  "cache-control",
  "x-cache",
  "x-openplans-gaps",
  "x-quote-tier",
] as const;

/** Reads bytes exactly as returned. This helper has no recording or normalization mode. */
export async function responseDigest(
  response: Response,
): Promise<ResponseDigest> {
  return {
    status: response.status,
    body_sha256: createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex"),
    headers: Object.fromEntries(
      stableHeaders.map((name) => [name, response.headers.get(name)]),
    ),
  };
}
