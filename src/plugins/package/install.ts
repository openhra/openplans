import type { Provenance } from "../registry/provenance.js";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, parse } from "node:path";
import { copyPackageFiles, normalizePackageModes } from "./files.js";
import { inspectPlugin, readPluginLock, writePluginLock } from "../lock.js";
import type { Environment } from "../../config/index.js";
import {
  coreHostPeerRoots,
  verifyDirectory,
  withVerifiedPackage,
} from "./verify.js";

async function realDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Plugin destination must not contain links");
  }
}

async function bindHostPeers(root: string): Promise<void> {
  const modules = join(root, "node_modules");
  await realDirectory(join(modules, "@openplans"));
  for (const [name, target] of Object.entries(await coreHostPeerRoots())) {
    const binding = join(modules, name);
    try {
      await symlink(target, binding, "dir");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      if (
        !(await lstat(binding)).isSymbolicLink() ||
        (await realpath(binding)) !== (await realpath(target))
      )
        throw new Error("Core host peer binding mismatch");
    }
  }
}

async function refusePeerShadow(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error("Plugin parent directories cannot shadow core host peers");
}

export interface InstallPluginOptions {
  provenance?: Provenance & { sha256: string };
  origin?: "local" | `registry:${string}`;
  expectedIdentity?: { name: string; version: string };
  lockfile?: string;
  approvedList?: string;
  env?: Environment;
  beforeCommit?: () => void;
}

export async function refuseApprovalTarget(
  lockfile: string,
  approvedList: string | undefined,
): Promise<void> {
  if (!approvedList) return;
  const canonical = async (path: string) =>
    realpath(path).catch(async () =>
      join(
        await realpath(dirname(path)).catch(() => resolve(dirname(path))),
        basename(path),
      ),
    );
  if (
    resolve(lockfile) === resolve(approvedList) ||
    (await canonical(lockfile)) === (await canonical(approvedList))
  )
    throw new Error("Plugin lockfile cannot be the approved list");
  const lockInfo = await lstat(lockfile).catch(() => undefined);
  const approvalInfo = await lstat(approvedList).catch(() => undefined);
  if (
    lockInfo &&
    approvalInfo &&
    lockInfo.dev === approvalInfo.dev &&
    lockInfo.ino === approvalInfo.ino
  )
    throw new Error("Plugin lockfile cannot alias the approved list");
}

/** Installation records bytes in the lockfile and never grants approval or loads code. */
export async function installPlugin(
  input: string,
  pluginsDirectory: string,
  options: InstallPluginOptions = {},
) {
  return withVerifiedPackage(input, async (root, verified) => {
    if (
      options.expectedIdentity &&
      (verified.manifest.name !== options.expectedIdentity.name ||
        verified.manifest.version !== options.expectedIdentity.version)
    )
      throw new Error("Registry package identity mismatch");
    if (verified.manifest.kind === "data")
      throw new Error(
        "Data packages must use source admission and importer activation",
      );
    const [namespace, name] = verified.manifest.name.slice(1).split("/") as [
      string,
      string,
    ];
    await mkdir(pluginsDirectory, { recursive: true, mode: 0o755 });
    if ((await lstat(pluginsDirectory)).isSymbolicLink())
      throw new Error("Plugin destination cannot be a link");
    const pluginsRoot = await realpath(pluginsDirectory);
    const parent = join(pluginsRoot, namespace, name);
    await realDirectory(parent);
    await refusePeerShadow(join(pluginsRoot, namespace, "node_modules"));
    await refusePeerShadow(join(parent, "node_modules"));
    await bindHostPeers(pluginsRoot);
    const lockfile = resolve(
      options.lockfile ?? join(pluginsRoot, "plugins.lock.json"),
    );
    await mkdir(dirname(lockfile), { recursive: true });
    await refuseApprovalTarget(lockfile, options.approvedList);
    const reservation = join(
      parent,
      `${verified.manifest.version}.install-lock`,
    );
    await mkdir(reservation, { mode: 0o700 });
    const inventoryReservation = `${lockfile}.install-lock`;
    let hasInventoryReservation = false;
    let temporary: string | undefined;
    let installed = false;
    const destination = join(parent, verified.manifest.version);
    try {
      await mkdir(inventoryReservation, { mode: 0o700 });
      hasInventoryReservation = true;
      const previous = await readPluginLock(lockfile).catch(
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return { version: 1 as const, packages: [] };
          throw error;
        },
      );
      const pinned = previous.packages.find(
        (item) => item.name === verified.manifest.name,
      );
      if (pinned && pinned.origin !== (options.origin ?? "local"))
        throw new Error("registry_package_origin_conflict");
      try {
        await lstat(destination);
        throw new Error("Package version is already installed");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      temporary = await mkdtemp(join(parent, ".install-"));
      await copyPackageFiles(root, temporary, verified.files);
      await normalizePackageModes(temporary);
      const staged = await verifyDirectory(temporary);
      if (
        staged.manifestSha256 !== verified.manifestSha256 ||
        staged.digest !== verified.digest ||
        !staged.digest
      )
        throw new Error("Installed package digest mismatch");
      await rename(temporary, destination);
      temporary = undefined;
      installed = true;
      const entrypoint = join(destination, verified.manifest.entrypoint);
      const { entry } = await inspectPlugin(
        entrypoint,
        pluginsRoot,
        options.env ?? {},
        options.origin ?? "local",
      );
      if (
        entry.digest !== staged.digest ||
        entry.legacySha256 !== staged.legacySha256
      )
        throw new Error("Installed package inspection mismatch");
      const entries = previous.packages.filter(
        (item) => item.name !== entry.name,
      );
      entries.push(entry);
      if (options.provenance) entry.provenance = options.provenance;
      options.beforeCommit?.();
      await writePluginLock(lockfile, entries);
      return {
        state: "installed",
        approval: "not_granted",
        lockfile,
        ...entry,
        directory: destination,
        manifestSha256: staged.manifestSha256,
        configEntry: { package: entrypoint, enabled: false },
      };
    } catch (error) {
      if (installed) await rm(destination, { recursive: true, force: true });
      throw error;
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      if (hasInventoryReservation)
        await rm(inventoryReservation, { recursive: true, force: true });
      await rm(reservation, { recursive: true, force: true });
    }
  });
}
