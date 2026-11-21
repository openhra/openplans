import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreConfig, Environment } from "../../config/index.js";
import {
  inspectPlugin,
  pluginLockPath,
  readPluginApprovals,
  readPluginLock,
  resolvePluginFile,
  writePluginLock,
} from "../lock.js";
import { refuseApprovalTarget } from "./install.js";
import { registryStatus } from "../registry/client.js";
import type { RegistryOptions } from "../registry/client.js";

export async function listInstalledPlugins(
  config: CoreConfig,
  base: string,
  env: Environment,
  registryOptions: Omit<RegistryOptions, "url">,
) {
  const lock = await readPluginLock(pluginLockPath(config, base)).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { packages: [] };
      throw error;
    },
  );
  const approvals = config.plugins.approvedList
    ? await readPluginApprovals(
        resolve(base, config.plugins.approvedList),
      ).catch(() => undefined)
    : undefined;
  const catalogs = new Map<
    string,
    Awaited<ReturnType<typeof registryStatus>>
  >();
  const packages = [];
  for (const entry of lock.packages) {
    const approval = approvals?.find((item) => item.name === entry.name);
    const actual = await inspectPlugin(
      entry.package,
      base,
      env,
      entry.origin,
    ).catch(() => undefined);
    const integrity =
      actual &&
      isDeepStrictEqual(
        {
          ...actual.entry,
          ...(entry.provenance ? { provenance: entry.provenance } : {}),
        },
        entry,
      )
        ? "verified"
        : "drift";
    let catalog: Awaited<ReturnType<typeof registryStatus>> | undefined;
    if (entry.origin.startsWith("registry:")) {
      const url = entry.origin.slice("registry:".length);
      catalog = catalogs.get(url);
      if (!catalog) {
        catalog = await registryStatus({ ...registryOptions, url }).catch(
          () => ({
            freshness: "unknown" as const,
            expires: null,
            entries: [],
            warning:
              "Registry origin is no longer trusted. Install and update are blocked.",
          }),
        );
        catalogs.set(url, catalog);
      }
    }
    const notice = catalog?.entries.find(
      (item) => item.name === entry.name && item.version === entry.version,
    );
    let approvalState = "unconfigured";
    if (config.plugins.approvedList) {
      approvalState = approvals ? "unapproved" : "invalid";
      if (
        approval &&
        approval.version === entry.version &&
        approval.digest === entry.digest &&
        approval.sha256 === entry.legacySha256 &&
        integrity === "verified"
      )
        approvalState = "approved";
    }
    packages.push({
      ...entry,
      integrity,
      approval: approvalState,
      enabled: config.plugins.entries.some(
        (item) => item.enabled && item.package === entry.package,
      ),
      catalog: catalog
        ? {
            freshness: catalog.freshness,
            expires: catalog.expires,
            warning: catalog.warning,
          }
        : null,
      notices: {
        yanked: notice?.yanked ?? null,
        revoked:
          notice?.yanked?.reason === "publisher_key_revoked"
            ? notice.yanked
            : null,
        removed: notice?.tombstone ?? null,
      },
    });
  }
  return { packages };
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** Remove managed package bytes and its candidate lock; never edit config or approvals. */
export async function removeInstalledPlugin(
  name: string,
  pluginsDirectory: string,
  config: CoreConfig,
  base: string,
  env: Environment,
) {
  const lockfile = pluginLockPath(config, base);
  await refuseApprovalTarget(
    lockfile,
    config.plugins.approvedList
      ? resolve(base, config.plugins.approvedList)
      : undefined,
  );
  const reservation = `${lockfile}.install-lock`;
  await mkdir(reservation, { mode: 0o700 });
  let staged: string | undefined;
  let destination: string | undefined;
  try {
    const lock = await readPluginLock(lockfile);
    const entry = lock.packages.find((item) => item.name === name);
    if (!entry) throw new Error("plugin_package_not_installed");
    if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name))
      throw new Error("plugin_remove_unmanaged");
    const store = await realpath(pluginsDirectory);
    destination = join(store, name.slice(1));
    if (
      (await lstat(destination)).isSymbolicLink() ||
      (await realpath(destination)) !== destination
    )
      throw new Error("plugin_remove_unmanaged");
    const actual = await inspectPlugin(entry.package, base, env, entry.origin);
    if (actual.root !== join(destination, entry.version))
      throw new Error("plugin_remove_unmanaged");
    for (const candidate of config.plugins.entries.filter(
      (item) => item.enabled,
    )) {
      if (candidate.package === name || candidate.package === entry.package)
        throw new Error("plugin_remove_enabled");
      // Fail closed if any enabled entry cannot be resolved without importing code.
      const file = await resolvePluginFile(candidate.package, base);
      if (inside(destination, file)) throw new Error("plugin_remove_enabled");
      // A configured file URL or absolute old-version path may resolve through an alias.
      const lexical = candidate.package.startsWith("file:")
        ? fileURLToPath(candidate.package)
        : resolve(base, candidate.package);
      if (inside(destination, lexical))
        throw new Error("plugin_remove_enabled");
    }
    staged = join(dirname(destination), `.remove-${randomUUID()}`);
    await rename(destination, staged);
    try {
      await writePluginLock(
        lockfile,
        lock.packages.filter((item) => item.name !== name),
      );
    } catch (error) {
      await rename(staged, destination);
      staged = undefined;
      throw error;
    }
    await rm(staged, { recursive: true });
    staged = undefined;
    return { state: "removed", name, approval: "unchanged", lockfile };
  } finally {
    await rm(reservation, { recursive: true, force: true });
  }
}
