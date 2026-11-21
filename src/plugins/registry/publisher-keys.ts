import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { trustedPublishingSchema } from "./provenance.js";

export const PUBLISHER_YEAR = 365 * 86_400;
export const REAUTHORIZE = 90 * 86_400;
const time = z.number().int().nonnegative();
export const publisherKeySchema = z.strictObject({
  keyid: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  public: z.string().regex(/^[a-f0-9]{64}$/),
  enrolledAt: time,
  notBefore: time,
  notAfter: time,
  authorizations: z
    .array(z.strictObject({ notBefore: time, notAfter: time }))
    .min(1)
    .max(8),
  retiredAt: time.nullable(),
  revokedAt: time.nullable(),
});
export const publisherSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  namespaces: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
    .min(1)
    .max(32),
  firstParty: z.boolean(),
  suspended: z.boolean(),
  generation: z.number().int().positive(),
  keys: z.array(publisherKeySchema).max(32),
  trustedPublishing: z.array(trustedPublishingSchema).max(32).optional(),
});
export const publisherSignatureSchema = z.strictObject({
  keyid: publisherKeySchema.shape.keyid,
  signedAt: time,
  sig: z.string().regex(/^[a-f0-9]{128}$/),
});
export const yankSchema = z.strictObject({
  at: time,
  reason: z.enum(["publisher_key_revoked", "operator"]),
});
export const tombstoneSchema = z.strictObject({
  at: time,
  reason: z.enum(["secrets", "rights", "abuse"]),
});
export type Publisher = z.infer<typeof publisherSchema>;
export type PublisherKey = z.infer<typeof publisherKeySchema>;
export type PublisherSignature = z.infer<typeof publisherSignatureSchema>;
export interface PackageBinding {
  name: string;
  version: string;
  sha256: string;
}
export function signaturePayload(binding: PackageBinding, signedAt: number) {
  return Buffer.from(
    JSON.stringify([
      "openplans-package-v1",
      binding.name,
      binding.version,
      binding.sha256,
      signedAt,
    ]),
  );
}
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
export function verifyPublisherSignature(
  publisher: Publisher,
  binding: PackageBinding,
  signature: PublisherSignature,
  publishedAt: number,
) {
  const key = publisher.keys.find((entry) => entry.keyid === signature.keyid);
  check(key, "publisher_key_unknown");
  check(
    publisher.namespaces.includes(binding.name.slice(1).split("/")[0]!) &&
      (!binding.name.startsWith("@openplans/") || publisher.firstParty),
    "publisher_namespace",
  );
  check(
    signature.signedAt <= publishedAt && publishedAt - signature.signedAt <= 60,
    "publisher_retro_signing",
  );
  check(
    key.notAfter > key.notBefore &&
      key.notAfter - key.notBefore <= PUBLISHER_YEAR &&
      key.enrolledAt <= key.notBefore,
    "publisher_key_window",
  );
  for (const at of [signature.signedAt, publishedAt]) {
    check(
      at >= key.enrolledAt &&
        at >= key.notBefore &&
        at < key.notAfter &&
        (key.retiredAt === null || at <= key.retiredAt),
      "publisher_key_window",
    );
    check(
      key.authorizations.some(
        (window) =>
          window.notBefore >= key.enrolledAt &&
          window.notAfter > window.notBefore &&
          window.notAfter - window.notBefore <= REAUTHORIZE &&
          at >= window.notBefore &&
          at < window.notAfter,
      ),
      "publisher_reauthorization_lapsed",
    );
  }
  check(
    verify(
      null,
      signaturePayload(binding, signature.signedAt),
      createPublicKey({
        format: "jwk",
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(key.public, "hex").toString("base64url"),
        },
      }),
      Buffer.from(signature.sig, "hex"),
    ),
    "publisher_signature",
  );
  return {
    revoked: key.revokedAt !== null && signature.signedAt > key.revokedAt,
  };
}
