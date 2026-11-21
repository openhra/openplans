import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { pluginManifestSchema } from "@openplans/plugin-sdk";
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
  validatePackageManifest,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import type { PackageManifest } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { packageContentDigest } from "../package-hash.js";
import { loadForTest } from "../testing/load.js";
import { writeArchive } from "./archive.js";
import {
  fileDigest,
  inventory,
  normalizePackageModes,
  readPackageJson,
} from "./files.js";
import {
  checkNpmManifest,
  coreHostPeers,
  coreHostPeerRoots,
  verifyDirectory,
  withVerifiedPackage,
} from "./verify.js";

function runtimePlugin(value: unknown): OpenPlansPlugin {
  if (
    !value ||
    typeof value !== "object" ||
    !("manifest" in value) ||
    !("setup" in value) ||
    typeof value.setup !== "function"
  )
    throw new Error("Built module must export a plugin");
  pluginManifestSchema.parse(value.manifest);
  return value as OpenPlansPlugin;
}

async function checkBuiltModule(
  root: string,
  descriptor: Exclude<PackageManifest, { kind: "data" }>,
): Promise<void> {
  const module = (await import(
    pathToFileURL(resolve(root, descriptor.entrypoint)).href
  )) as { default?: unknown };
  const plugin = runtimePlugin(module.default);
  const runtime = pluginManifestSchema.parse(plugin.manifest);
  for (const [field, actual, expected] of [
    ["name", runtime.name, descriptor.name],
    ["version", runtime.version, descriptor.version],
    ["apiVersion", runtime.apiVersion, descriptor.apiVersion],
    ["kinds", [...runtime.kinds].sort(), [...descriptor.kinds].sort()],
    ["capabilities", runtime.capabilities ?? {}, descriptor.capabilities],
  ] as const)
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(`Manifest/module ${field} mismatch`);
  const kit = await loadForTest(plugin, { packageRoot: root });
  await kit.close();
}

export async function packPlugin(input: string, outputDirectory: string) {
  const root = resolve(input);
  const descriptor = validatePackageManifest(
    await readPackageJson(join(root, PACKAGE_MANIFEST)),
  );
  if (descriptor.kind === "data")
    throw new Error(
      "plugin pack accepts built code packages; data uses original-file chunks",
    );
  const pkg = checkNpmManifest(
    await readPackageJson(join(root, "package.json")),
    true,
  );
  if (
    pkg.name !== descriptor.name ||
    pkg.version !== descriptor.version ||
    pkg.main !== descriptor.entrypoint
  )
    throw new Error("Package identity or entrypoint mismatch");
  if (
    !isDeepStrictEqual(descriptor.hostPeers, await coreHostPeers()) ||
    !isDeepStrictEqual(pkg.peerDependencies, descriptor.hostPeers)
  )
    throw new Error("Exact core host peers are required");
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Package root cannot be a symbolic link");
  const temporary = await mkdtemp(join(tmpdir(), "openplans-package-pack-"));
  const payload = join(temporary, "payload");
  await mkdir(payload);
  try {
    // Author-only files are excluded. Hidden runtime files and native modules fail inventory.
    for (const name of await readdir(root)) {
      if (/^\.env(?:\.|$)/i.test(name))
        throw new Error("Environment files are refused");
      if (
        !["dist", "migrations", "assets", "attestations"].includes(name) &&
        !/^(?:LICENSE|NOTICE|README)(?:\.[A-Za-z0-9]+)?$/.test(name)
      )
        continue;
      await cp(join(root, name), join(payload, name), {
        recursive: true,
        dereference: false,
      });
    }
    const {
      scripts: _scripts,
      devDependencies: _devDependencies,
      ...runtimePackage
    } = pkg;
    await writeFile(
      join(payload, "package.json"),
      JSON.stringify(runtimePackage, null, 2) + "\n",
    );
    const files = await inventory(payload, PACKAGE_LIMITS.codeExpandedBytes);
    const manifest = { ...descriptor, files };
    await writeFile(
      join(payload, PACKAGE_MANIFEST),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await normalizePackageModes(payload);
    const verified = await verifyDirectory(payload);
    // Author checks resolve only the peers supplied by this core.
    const peersDirectory = join(temporary, "node_modules");
    await mkdir(join(peersDirectory, "@openplans"), { recursive: true });
    for (const [name, root] of Object.entries(await coreHostPeerRoots())) {
      await symlink(root, join(peersDirectory, name), "dir");
    }
    await checkBuiltModule(payload, manifest);
    if ((await packageContentDigest(payload)) !== verified.digest)
      throw new Error("Plugin setup changed package files");
    await mkdir(outputDirectory, { recursive: true });
    const filename = `${descriptor.name.slice(1).replace("/", "-")}-${descriptor.version}.tgz`;
    const output = join(outputDirectory, filename);
    // Never overwrite an existing immutable package version.
    try {
      await lstat(output);
      throw new Error("Package output already exists");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const partial = join(temporary, filename);
    await writeArchive(payload, verified.files, partial);
    const packed = await withVerifiedPackage(
      partial,
      async (_root, value) => value,
    );
    const receipt = {
      schemaVersion: 1,
      name: descriptor.name,
      version: descriptor.version,
      artifactSha256: await fileDigest(partial, (await lstat(partial)).size),
      bytes: (await lstat(partial)).size,
      manifestSha256: packed.manifestSha256,
      digest: packed.digest,
      legacySha256: packed.legacySha256,
    };
    // Copy with exclusive creation across filesystems before removing the private source.
    const { constants } = await import("node:fs");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(partial, output, constants.COPYFILE_EXCL);
    try {
      await writeFile(
        `${output}.json`,
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      await rm(output, { force: true });
      throw error;
    }
    return { output, ...receipt };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
