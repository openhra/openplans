import { z } from "zod";
import { pluginManifestSchema } from "./index.js";

export const PACKAGE_MANIFEST = "openplans-package.json";
export const DATA_CHUNK_BYTES = 64 * 1024 * 1024;
export const PACKAGE_LIMITS = {
  codeCompressedBytes: 20 * 1024 * 1024,
  codeExpandedBytes: 100 * 1024 * 1024,
  dataCompressedBytes: 20 * 1024 ** 3,
  dataExpandedBytes: 100 * 1024 ** 3,
  files: 5_000,
  chunks: 4_096,
  descriptorBytes: 1024 * 1024,
} as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Canonical ASCII paths also avoid platform-specific case and Unicode aliases.
export const packagePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^(?!.*(?:^|\/)[nN][oO][dD][eE]_[mM][oO][dD][uU][lL][eE][sS](?:\/|$))(?!.*\.[nN][oO][dD][eE]$)[A-Za-z0-9_@+-][A-Za-z0-9_@+.-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9_@+.-]*)*$/,
  );
const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .regex(/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/);
const evidence = z.strictObject({ path: packagePathSchema, sha256: digest });
const version = pluginManifestSchema.shape.version;
const inventoryFile = z.strictObject({
  path: packagePathSchema,
  bytes,
  sha256: digest,
});
const common = {
  schemaVersion: z.literal(1),
  name: z
    .string()
    .max(101)
    .regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/),
  version,
  summary: z.string().min(1).max(240),
  licence: z.string().min(1).max(200),
  attribution: z.string().min(1).max(2048),
  apiVersion: pluginManifestSchema.shape.apiVersion,
  kinds: pluginManifestSchema.shape.kinds.max(32),
  capabilities: pluginManifestSchema.shape.capabilities.unwrap(),
  hostPeers: z.record(
    z.string().regex(/^(?:hono|zod|@openplans\/plugin-sdk)$/),
    version,
  ),
  bundledDependencies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(101),
        version,
        licence: z.string().min(1).max(200),
        file: packagePathSchema,
        sha256: digest,
      }),
    )
    .max(128),
  planYears: z.array(z.number().int().min(2000).max(2200)).max(100),
  provenance: z.strictObject({
    builtAt: z.iso.datetime(),
    builder: z.enum(["local", "github-actions"]),
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    attestation: evidence.optional(),
  }),
  // Authors may omit this inventory. Pack writes it; install requires it.
  files: z.array(inventoryFile).max(PACKAGE_LIMITS.files).optional(),
};
const code = {
  ...common,
  planYears: common.planYears.max(0),
  entrypoint: packagePathSchema,
};
const dataFile = z.strictObject({
  path: packagePathSchema,
  bytes,
  expandedBytes: bytes,
  sha256: digest,
  origin: z.strictObject({
    url: httpsUrl,
    sha256: digest.nullable().optional(),
    retrievedAt: z.iso.datetime(),
    admission: evidence,
  }),
  redistribution: z.strictObject({
    status: z.literal("allowed"),
    termsUrl: httpsUrl,
    evidence,
  }),
  chunks: z
    .array(
      z.strictObject({
        sha256: digest,
        bytes: z.number().int().min(1).max(DATA_CHUNK_BYTES),
      }),
    )
    .min(1)
    .max(PACKAGE_LIMITS.chunks),
});

export const packageManifestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...code, kind: z.literal("plugin") }),
  z.strictObject({
    ...code,
    kind: z.literal("ui-addon"),
    kinds: z.tuple([z.literal("routes")]),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("data"),
    kinds: common.kinds.max(0),
    capabilities: z.strictObject({}),
    hostPeers: z.strictObject({}),
    bundledDependencies: common.bundledDependencies.max(0),
    data: z.strictObject({
      format: z.literal("original-public-files"),
      files: z.array(dataFile).min(1).max(PACKAGE_LIMITS.files),
    }),
  }),
]);
export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageFile = z.infer<typeof inventoryFile>;

/** The JSON Schema and TypeScript validator share these declarations. */
export function packageManifestJsonSchema() {
  return z.toJSONSchema(packageManifestSchema, {
    target: "draft-2020-12",
    io: "input",
  });
}

export function validatePackageManifest(value: unknown): PackageManifest {
  const manifest = packageManifestSchema.parse(value);
  const unique = (values: readonly string[]) =>
    new Set(values).size === values.length;
  if (
    !unique(manifest.kinds) ||
    !unique(manifest.planYears.map(String)) ||
    !unique(manifest.files?.map((file) => file.path.toLowerCase()) ?? []) ||
    !unique(manifest.bundledDependencies.map((item) => item.name))
  )
    throw new Error("Duplicate package declarations");
  if (
    manifest.planYears.some(
      (year, index) => index > 0 && year <= manifest.planYears[index - 1]!,
    )
  )
    throw new Error("Plan years must be sorted");
  if (manifest.kind !== "data") return manifest;
  let compressed = 0;
  let expanded = 0;
  let chunkCount = 0;
  if (!unique(manifest.data.files.map((file) => file.path.toLowerCase())))
    throw new Error("Duplicate data file");
  for (const file of manifest.data.files) {
    compressed += file.bytes;
    expanded += file.expandedBytes;
    chunkCount += file.chunks.length;
    if (
      file.chunks.reduce((total, chunk) => total + chunk.bytes, 0) !==
        file.bytes ||
      file.chunks.some(
        (chunk, index) =>
          index < file.chunks.length - 1 && chunk.bytes !== DATA_CHUNK_BYTES,
      )
    )
      throw new Error(
        "Data chunks must cover the original file in 64 MiB chunks",
      );
  }
  if (
    compressed > PACKAGE_LIMITS.dataCompressedBytes ||
    expanded > PACKAGE_LIMITS.dataExpandedBytes ||
    chunkCount > PACKAGE_LIMITS.chunks
  )
    throw new Error("Data package size cap exceeded");
  return manifest;
}
