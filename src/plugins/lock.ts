import { provenanceSchema, verifyProvenance } from "./registry/provenance.js";
import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { pluginManifestSchema } from "@openplans/plugin-sdk";
import type { CoreConfig, Environment } from "../config/index.js";
import { packageDigests, packageRoot } from "./package-hash.js";
import { PluginRefusal } from "./refusal.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const declaration = z.strictObject({
  apiVersion: pluginManifestSchema.shape.apiVersion,
  kinds: pluginManifestSchema.shape.kinds,
  capabilities: pluginManifestSchema.shape.capabilities,
});
const metadata = declaration.extend({
  networkFromEnv: z.literal("OPENPLANS_WEBHOOK_HOST").optional(),
});
export const pluginLockEntrySchema = declaration.extend({
  capabilities: pluginManifestSchema.shape.capabilities.unwrap(),
  package: z.string().min(1),
  name: pluginManifestSchema.shape.name,
  version: pluginManifestSchema.shape.version,
  origin: z.string().refine((value) => {
    if (value === "bundled" || value === "local") return true;
    if (!value.startsWith("registry:")) return false;
    try {
      const url = new URL(value.slice("registry:".length));
      return (
        ["https:", "http:", "file:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }),
  digest: hash,
  legacySha256: hash,
  provenance: provenanceSchema.extend({ sha256: hash }).optional(),
});
export const pluginLockSchema = z
  .strictObject({
    version: z.literal(1),
    packages: z.array(pluginLockEntrySchema),
  })
  .superRefine((lock, context) => {
    if (
      new Set(lock.packages.map((entry) => entry.package)).size !==
        lock.packages.length ||
      new Set(lock.packages.map((entry) => entry.name)).size !==
        lock.packages.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate plugin identity",
      });
    for (const entry of lock.packages)
      if (entry.provenance) {
        try {
          verifyProvenance(
            {
              identity: entry.provenance.identity,
              statement: entry.provenance.statement,
            },
            {
              name: entry.name,
              version: entry.version,
              sha256: entry.provenance.sha256,
            },
          );
          if (!entry.origin.startsWith("registry:")) throw new Error("origin");
        } catch {
          context.addIssue({
            code: "custom",
            message: "Invalid registry provenance",
          });
        }
      }
  });
export type PluginLockEntry = z.infer<typeof pluginLockEntrySchema>;
export type PluginLock = z.infer<typeof pluginLockSchema>;
export interface InspectedPlugin {
  entry: PluginLockEntry;
  file: string;
  root: string;
}
const approvedSchema = z.array(
  z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    sha256: hash,
    digest: hash,
  }),
);
const bundledRoot = fileURLToPath(new URL("../../plugins/", import.meta.url));
export const pluginLockPath = (config: CoreConfig, base: string): string =>
  resolve(base, config.plugins.lockfile ?? "plugins.lock.json");

/** Resolve only; this module never imports plugin code. */
export async function resolvePluginFile(
  specifier: string,
  base: string,
): Promise<string> {
  let url = specifier;
  if (
    isAbsolute(specifier) ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  )
    url = pathToFileURL(resolve(base, specifier)).href;
  else if (!specifier.startsWith("file:")) url = import.meta.resolve(specifier);
  return realpath(fileURLToPath(url));
}

/** Used by locking, verification, the loader and package installation. */
export async function inspectPlugin(
  specifier: string,
  base: string,
  env: Environment = {},
  origin?: PluginLockEntry["origin"],
  reuseHashes = false,
): Promise<InspectedPlugin> {
  const file = await resolvePluginFile(specifier, base);
  const found = await packageRoot(file);
  if (!found) throw new Error("plugin_package_missing");
  const root = await realpath(found);
  const path = relative(root, file);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("plugin_entry_outside_package");
  const pkg = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const declared = metadata.parse(pkg.openplansPlugin);
  const { networkFromEnv, ...staticDeclaration } = declared;
  if (networkFromEnv) {
    const host = env[networkFromEnv]?.trim().toLowerCase();
    staticDeclaration.capabilities = {
      ...declared.capabilities,
      network: host && /^[a-z0-9.-]{1,253}$/.test(host) ? [host] : [],
    };
  }
  const bundled = relative(
    await realpath(bundledRoot).catch(() => bundledRoot),
    root,
  );
  const hashes = await packageDigests(root, reuseHashes);
  const entry = pluginLockEntrySchema.parse({
    package: specifier,
    name: pkg.name,
    version: pkg.version,
    origin:
      origin ??
      (bundled &&
      !bundled.startsWith(`..${sep}`) &&
      bundled !== ".." &&
      !isAbsolute(bundled)
        ? "bundled"
        : "local"),
    digest: hashes.digest,
    legacySha256: hashes.legacySha256,
    ...staticDeclaration,
    capabilities: staticDeclaration.capabilities ?? {},
  });
  return { entry, file, root };
}

async function readRegular(path: string): Promise<unknown> {
  if (!(await lstat(path)).isFile())
    throw new Error("plugin_inventory_not_regular");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function readPluginLock(path: string): Promise<PluginLock> {
  return pluginLockSchema.parse(await readRegular(path));
}

/** Shared exact approval reader for the loader and operator inventory. */
export async function readPluginApprovals(path: string) {
  const approved = approvedSchema.parse(await readRegular(path));
  if (new Set(approved.map((item) => item.name)).size !== approved.length)
    throw new Error("plugin_duplicate_approval");
  return approved;
}

/** Atomic candidate writer. This never writes or changes an approval file. */
export async function writePluginLock(
  path: string,
  entries: readonly PluginLockEntry[],
): Promise<void> {
  const lock = pluginLockSchema.parse({ version: 1, packages: entries });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function lockPlugins(
  config: CoreConfig,
  base: string,
  env: Environment,
): Promise<PluginLock> {
  if (
    config.plugins.approvedList &&
    resolve(base, config.plugins.approvedList) === pluginLockPath(config, base)
  )
    throw new Error("plugin_lock_is_approval_file");
  const previous = await readPluginLock(pluginLockPath(config, base)).catch(
    (error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  const packages = await Promise.all(
    config.plugins.entries
      .filter((item) => item.enabled)
      .map((item) =>
        inspectPlugin(item.package, base, env).then(({ entry }) => entry),
      ),
  );
  for (const entry of packages) {
    const pinned = previous?.packages.find(
      (item) =>
        item.package === entry.package &&
        item.name === entry.name &&
        item.version === entry.version &&
        item.digest === entry.digest,
    );
    if (pinned) {
      entry.origin = pinned.origin;
      if (pinned.provenance) entry.provenance = pinned.provenance;
    }
  }
  const lock: PluginLock = { version: 1, packages };
  await writePluginLock(pluginLockPath(config, base), packages);
  return lock;
}

function equal(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => Number(a > b) - Number(a < b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function matchesDeclaration(
  entry: PluginLockEntry,
  manifest: {
    name: string;
    version: string;
    apiVersion: string;
    kinds: readonly string[];
    capabilities?: unknown;
  },
): boolean {
  return (
    entry.name === manifest.name &&
    entry.version === manifest.version &&
    entry.apiVersion === manifest.apiVersion &&
    equal(entry.kinds, manifest.kinds) &&
    equal(entry.capabilities ?? {}, manifest.capabilities ?? {})
  );
}

const refuse = (name: string, reason: string): never => {
  throw new PluginRefusal(name, "plugin_approval_refused", reason);
};
export function approvalRequired(config: CoreConfig): boolean {
  return (
    config.plugins.requireApproval || Object.values(config.public).some(Boolean)
  );
}

export function warnUnconfiguredApproval(
  writeLog?: (line: string) => void,
): void {
  writeLog?.(
    JSON.stringify({
      plugin: "openplans",
      code: "plugin_approval_unconfigured",
    }),
  );
}

/** Every candidate passes before the caller may import any package. */
export async function verifyPlugins(
  config: CoreConfig,
  base: string,
  env: Environment,
  writeLog?: (line: string) => void,
): Promise<readonly InspectedPlugin[]> {
  const configured = config.plugins.entries.filter((item) => item.enabled);
  const approvedPath = config.plugins.approvedList;
  if (!approvedPath && approvalRequired(config))
    refuse("openplans", "approved_list_required");
  if (!approvedPath) {
    warnUnconfiguredApproval(writeLog);
    return [];
  }
  let approved: z.infer<typeof approvedSchema>;
  let lock: PluginLock;
  try {
    approved = await readPluginApprovals(resolve(base, approvedPath));
    lock = await readPluginLock(pluginLockPath(config, base));
  } catch {
    return refuse("openplans", "approval_inventory_invalid");
  }
  const checked: InspectedPlugin[] = [];
  for (const candidate of configured) {
    const locked = lock.packages.find(
      (item) => item.package === candidate.package,
    );
    if (!locked) return refuse(candidate.package, "package_unlisted");
    const approval = approved.find((item) => item.name === locked.name);
    if (!approval) return refuse(locked.name, "package_unlisted");
    if (approval.version !== locked.version)
      refuse(locked.name, "version_mismatch");
    if (
      approval.digest !== locked.digest ||
      approval.sha256 !== locked.legacySha256
    )
      refuse(locked.name, "digest_mismatch");
    let actual: InspectedPlugin;
    try {
      actual = await inspectPlugin(
        candidate.package,
        base,
        env,
        locked.origin,
        true,
      );
    } catch {
      return refuse(locked.name, "package_inspection_failed");
    }
    if (actual.entry.version !== locked.version)
      refuse(locked.name, "version_mismatch");
    if (
      !equal(
        {
          ...actual.entry,
          ...(locked.provenance ? { provenance: locked.provenance } : {}),
        },
        locked,
      )
    )
      refuse(locked.name, "digest_mismatch");
    checked.push(actual);
  }
  return checked;
}

/** Disk-only verification also works without approval, but never labels the result approved. */
export async function verifyPluginLock(
  config: CoreConfig,
  base: string,
  env: Environment,
): Promise<PluginLock> {
  const lock = await readPluginLock(pluginLockPath(config, base));
  const configured = config.plugins.entries.filter((item) => item.enabled);
  if (
    !equal(
      configured.map((item) => item.package),
      lock.packages.map((item) => item.package),
    )
  )
    throw new Error("plugin_lock_packages_mismatch");
  for (const locked of lock.packages) {
    const { entry } = await inspectPlugin(
      locked.package,
      base,
      env,
      locked.origin,
    );
    if (
      !equal(
        {
          ...entry,
          ...(locked.provenance ? { provenance: locked.provenance } : {}),
        },
        locked,
      )
    )
      throw new PluginRefusal(
        locked.name,
        "plugin_approval_refused",
        "digest_mismatch",
      );
  }
  if (config.plugins.approvedList) await verifyPlugins(config, base, env);
  return lock;
}
