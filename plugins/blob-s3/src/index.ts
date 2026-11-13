import { z } from "zod";
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { assertEndpointAdmitted } from "./admission.js";
import { BlobError, checkedEndpoint, S3BlobStore } from "./store.js";

export { assertEndpointAdmitted } from "./admission.js";
export {
  BlobError,
  checkedEndpoint,
  checkedKey,
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_PART_BYTES,
  MIN_PART_BYTES,
  S3BlobStore,
} from "./store.js";
export type { S3BlobStoreSettings } from "./store.js";
export {
  amzDate,
  canonicalQuery,
  canonicalRequest,
  EMPTY_SHA256,
  sha256Hex,
  sign,
  signingKey,
  stringToSign,
  uriEncode,
} from "./sigv4.js";
export type { Credentials, SignableRequest } from "./sigv4.js";

/** Declared secrets. The session token is optional: list it under `optionalSecrets`. */
export const SECRETS = {
  endpoint: "OPENPLANS_BLOB_S3_ENDPOINT",
  region: "OPENPLANS_BLOB_S3_REGION",
  bucket: "OPENPLANS_BLOB_S3_BUCKET",
  accessKeyId: "OPENPLANS_BLOB_S3_ACCESS_KEY_ID",
  secretAccessKey: "OPENPLANS_BLOB_S3_SECRET_ACCESS_KEY",
  sessionToken: "OPENPLANS_BLOB_S3_SESSION_TOKEN",
} as const;

export const PROVIDER_NAME = "s3";

const options = z
  .strictObject({
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,255}(?:\/[A-Za-z0-9._-]{1,255})*$/)
      .optional(),
    maxObjectBytes: z.number().int().positive().optional(),
    partBytes: z
      .number()
      .int()
      .min(5 * 1024 ** 2)
      .max(5 * 1024 ** 3)
      .optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  })
  .optional();
type Options = z.infer<typeof options>;

/**
 * Registers the `s3` blob provider. Select it with `blobs.provider: "s3"`. Setup refuses when a
 * secret is missing or invalid, or when the endpoint host is not admitted in the operator
 * access manifest. Nothing here logs a secret.
 */
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/blob-s3",
    version: "0.1.1",
    apiVersion: "0.1",
    kinds: ["blobStores"],
    capabilities: {
      secrets: Object.values(SECRETS),
      writes: ["blobs"],
    },
    options,
  },
  async setup(ctx) {
    const read = (name: string) => ctx.secrets.get(name);
    const endpoint = read(SECRETS.endpoint);
    const region = read(SECRETS.region);
    const bucket = read(SECRETS.bucket);
    const accessKeyId = read(SECRETS.accessKeyId);
    const secretAccessKey = read(SECRETS.secretAccessKey);
    const sessionToken = read(SECRETS.sessionToken);
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey)
      throw new BlobError(
        "missing_settings",
        "S3 blob store settings are incomplete",
      );
    const url = checkedEndpoint(endpoint);
    await assertEndpointAdmitted(
      url.hostname,
      ctx.config.access.operatorManifest,
    );
    const settings = (ctx.options ?? {}) as NonNullable<Options>;
    const create = () =>
      new S3BlobStore({
        endpoint,
        region,
        bucket,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        },
        prefix: settings.prefix,
        maxObjectBytes: settings.maxObjectBytes,
        partBytes: settings.partBytes,
        timeoutMs: settings.timeoutMs,
      });
    // Fail at startup, not on first use, when a setting is malformed.
    create();
    ctx.blobStores.provide(PROVIDER_NAME, () => create());
  },
};
export default plugin;
