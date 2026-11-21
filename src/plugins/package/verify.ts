import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
  validatePackageManifest,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import type {
  PackageManifest,
  PackageFile,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import { packageRoot } from "../package-hash.js";
import {
  copyPackageFiles,
  inventory,
  normalizePackageModes,
  order,
  readPackageJson,
  sha256,
} from "./files.js";
import { inspectPlugin, matchesDeclaration } from "../lock.js";
import type { PluginLockEntry } from "../lock.js";
import { unpackArchive } from "./archive.js";

const npmManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    type: z.literal("module"),
    main: z.string(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    dependencies: z.unknown().optional(),
    optionalDependencies: z.unknown().optional(),
    bundledDependencies: z.unknown().optional(),
    bundleDependencies: z.unknown().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export function checkNpmManifest(value: unknown, author = false) {
  const pkg = npmManifestSchema.parse(value);
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ])
    if (Object.hasOwn(pkg, key))
      throw new Error(
        "Runtime dependencies are refused; bundle pure JavaScript and declare host peers",
      );
  if (
    Object.keys(pkg.scripts ?? {}).some(
      (name) =>
        !author ||
        !["build", "test", "lint", "typecheck", "format"].includes(name),
    )
  )
    throw new Error("Package lifecycle scripts are refused");
  return pkg;
}

export async function coreHostPeers(): Promise<Record<string, string>> {
  const core = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(
      await readPackageJson(
        fileURLToPath(new URL("../../../package.json", import.meta.url)),
      ),
    );
  return Object.fromEntries(
    ["@openplans/plugin-sdk", "hono", "zod"].map((name) => [
      name,
      core.dependencies[name]!,
    ]),
  );
}
/** Resolve host peers without importing them or any package payload. */
export async function coreHostPeerRoots(): Promise<Record<string, string>> {
  const peers = await coreHostPeers();
  const roots: Record<string, string> = {};
  for (const [name, version] of Object.entries(peers)) {
    const root = await packageRoot(fileURLToPath(import.meta.resolve(name)));
    if (!root) throw new Error("Core host peer package root is missing");
    const pkg = z
      .object({ name: z.string(), version: z.string() })
      .parse(await readPackageJson(join(root, "package.json")));
    if (pkg.name !== name || pkg.version !== version)
      throw new Error("Core host peer inventory mismatch");
    roots[name] = root;
  }
  return roots;
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = Object.keys(left).sort(order);
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort(order)) &&
    keys.every((key) => left[key] === right[key])
  );
}
export async function checkCodeMetadata(
  root: string,
  manifest: PackageManifest,
): Promise<PluginLockEntry> {
  if (manifest.kind === "data") throw new Error("Expected a code package");
  const pkg = checkNpmManifest(
    await readPackageJson(join(root, "package.json")),
  );
  if (
    pkg.name !== manifest.name ||
    pkg.version !== manifest.version ||
    pkg.main !== manifest.entrypoint
  )
    throw new Error("Package identity or entrypoint mismatch");
  if (
    !sameRecord(manifest.hostPeers, await coreHostPeers()) ||
    !sameRecord(pkg.peerDependencies ?? {}, manifest.hostPeers)
  )
    throw new Error("Exact core host peers are required");
  const inspected = await inspectPlugin(
    join(root, manifest.entrypoint),
    root,
    {},
    "local",
  );
  if (!matchesDeclaration(inspected.entry, manifest))
    throw new Error("Static package declaration mismatch");
  return inspected.entry;
}

export interface VerifiedPackage {
  manifest: PackageManifest;
  manifestSha256: string;
  digest?: string;
  legacySha256?: string;
  files: PackageFile[];
  evidence: "complete" | "unknown";
}

async function checkSecretMarkers(
  root: string,
  files: readonly PackageFile[],
): Promise<void> {
  const markers =
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][a-zA-Z0-9_+/-]{24,}["']/i;
  for (const file of files) {
    if (!/\.(?:[cm]?js|json|md|txt|ya?ml)$/i.test(file.path)) continue;
    let tail = "";
    for await (const chunk of createReadStream(join(root, file.path))) {
      const text = tail + (chunk as Buffer).toString("utf8");
      if (markers.test(text)) throw new Error("Package secret marker refused");
      tail = text.slice(-512);
    }
  }
}

async function checkData(
  root: string,
  manifest: Extract<PackageManifest, { kind: "data" }>,
  files: readonly PackageFile[],
): Promise<"complete" | "unknown"> {
  const actual = new Map(files.map((file) => [file.path, file]));
  const allowed = new Set([PACKAGE_MANIFEST]);
  let evidence: "complete" | "unknown" = "complete";
  for (const file of manifest.data.files) {
    if (!file.origin.sha256) evidence = "unknown";
    else if (file.origin.sha256 !== file.sha256)
      throw new Error("Upstream file hash mismatch");
    for (const item of [file.origin.admission, file.redistribution.evidence]) {
      allowed.add(item.path);
      if (!actual.get(item.path)?.bytes) evidence = "unknown";
      else if (actual.get(item.path)?.sha256 !== item.sha256)
        throw new Error("Data evidence hash mismatch");
    }
    const hash = createHash("sha256");
    for (const chunk of file.chunks) {
      const path = `chunks/${chunk.sha256}`;
      allowed.add(path);
      const found = actual.get(path);
      if (found?.sha256 !== chunk.sha256 || found.bytes !== chunk.bytes)
        throw new Error("Content-addressed data chunk mismatch");
      for await (const bytes of createReadStream(join(root, path)))
        hash.update(bytes as Buffer);
    }
    if (hash.digest("hex") !== file.sha256)
      throw new Error("Reassembled original file hash mismatch");
  }
  if (manifest.provenance.attestation) {
    const item = manifest.provenance.attestation;
    allowed.add(item.path);
  }
  if (files.some((file) => !allowed.has(file.path)))
    throw new Error(
      "Data package may contain only original chunks and evidence",
    );
  return evidence;
}

export async function verifyDirectory(root: string): Promise<VerifiedPackage> {
  const manifestPath = join(root, PACKAGE_MANIFEST);
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new Error("Manifest must be a regular file");
  const manifest = validatePackageManifest(await readPackageJson(manifestPath));
  const maxBytes =
    manifest.kind === "data"
      ? PACKAGE_LIMITS.dataCompressedBytes
      : PACKAGE_LIMITS.codeExpandedBytes;
  const files = await inventory(root, maxBytes);
  if (!manifest.files)
    throw new Error("Packed package file inventory is required");
  const expected = [...manifest.files].sort((a, b) => order(a.path, b.path));
  const payload = files.filter((file) => file.path !== PACKAGE_MANIFEST);
  if (
    JSON.stringify(payload) !==
    JSON.stringify(
      expected.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    )
  )
    throw new Error("Package file inventory mismatch");
  const attestation = manifest.provenance.attestation;
  if (
    attestation &&
    payload.find((file) => file.path === attestation.path)?.sha256 !==
      attestation.sha256
  )
    throw new Error("Provenance evidence hash mismatch");
  let inspected: PluginLockEntry | undefined;
  let evidence: "complete" | "unknown" = "complete";
  if (manifest.kind === "data")
    evidence = await checkData(root, manifest, files);
  else {
    inspected = await checkCodeMetadata(root, manifest);
    if (
      !payload.some(
        (file) =>
          file.path === manifest.entrypoint && /\.[cm]?js$/.test(file.path),
      )
    )
      throw new Error("Built JavaScript entrypoint is missing");
    for (const dependency of manifest.bundledDependencies)
      if (
        payload.find((file) => file.path === dependency.file)?.sha256 !==
        dependency.sha256
      )
        throw new Error("Bundled dependency inventory mismatch");
    await checkSecretMarkers(root, files);
  }
  return {
    manifest,
    files,
    evidence,
    manifestSha256: sha256(await readFile(manifestPath)),
    ...(inspected && {
      digest: inspected.digest,
      legacySha256: inspected.legacySha256,
    }),
  };
}

export async function withVerifiedPackage<T>(
  input: string,
  run: (root: string, verified: VerifiedPackage) => Promise<T>,
): Promise<T> {
  const info = await lstat(input);
  if (info.isSymbolicLink())
    throw new Error("Package input cannot be a symbolic link");
  if (!info.isDirectory() && !info.isFile())
    throw new Error("Package input must be a directory or .tgz file");
  const root = await mkdtemp(join(tmpdir(), "openplans-package-verify-"));
  try {
    if (info.isDirectory()) {
      const manifest = validatePackageManifest(
        await readPackageJson(join(input, PACKAGE_MANIFEST)),
      );
      const files = await inventory(
        input,
        manifest.kind === "data"
          ? PACKAGE_LIMITS.dataCompressedBytes
          : PACKAGE_LIMITS.codeExpandedBytes,
      );
      await copyPackageFiles(input, root, files);
    } else await unpackArchive(input, root);
    await normalizePackageModes(root);
    return await run(root, await verifyDirectory(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
