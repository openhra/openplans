import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-openplans-signature";
export const EVENT_ID_HEADER = "x-openplans-event-id";

/** `sha256=` followed by the lower-case hex HMAC-SHA256 of the exact body bytes. */
export function signBody(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check of a received `X-OpenPlans-Signature` value against the raw body. */
export function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header))
    return false;
  const expected = Buffer.from(signBody(secret, body));
  const received = Buffer.from(header);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
