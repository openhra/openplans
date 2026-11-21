import { provenanceSchema, verifyProvenance } from "./provenance.js";
import {
  publisherSchema,
  publisherSignatureSchema,
  verifyPublisherSignature,
  yankSchema,
  tombstoneSchema,
} from "./publisher-keys.js";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { registryDefinitionsSchema } from "../../config/registry.js";
import type { RegistryDefinition } from "../../config/registry.js";
import { z } from "zod";
import { packageManifestSchema } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { Updater } from "tuf-js";
import type { TargetFile } from "tuf-js";
import type { TransientFetchOptions } from "../../fetch/index.js";
import { installDataPackage } from "../../registry/data/install.js";
import { installPlugin } from "../package/install.js";
import { withVerifiedPackage } from "../package/verify.js";
import type { InstallPluginOptions } from "../package/install.js";
import {
  boundedRead,
  RegistryFetcher,
  REGISTRY_LIMITS,
  registryUrl,
  safeTargetPath,
} from "./transport.js";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
const trustSchema = z.strictObject({
  version: z.literal(1),
  registries: registryDefinitionsSchema.refine((entries) => entries.length > 0),
});
const identitySchema = packageManifestSchema.options[0].pick({
  name: true,
  version: true,
  summary: true,
});
const releaseSchema = identitySchema.extend({
  publisher: publisherSchema.shape.id,
  publishedAt: z.number().int().nonnegative(),
  signature: publisherSignatureSchema,
  yanked: yankSchema.nullable(),
  tombstone: tombstoneSchema.nullable(),
  provenance: provenanceSchema.optional(),
});
const rootPolicySchema = z.object({
  signed: z.object({
    consistent_snapshot: z.literal(true),
    keys: z.record(
      z.string(),
      z.object({
        keytype: z.literal("ed25519"),
        scheme: z.literal("ed25519"),
        keyval: z.object({ public: z.string().regex(/^[a-f0-9]{64}$/) }),
      }),
    ),
    roles: z.object({
      root: z.object({
        keyids: z.array(z.string()).length(3),
        threshold: z.literal(2),
      }),
    }),
  }),
});
const clockSchema = z.strictObject({
  anchor: z.string(),
  lastSeen: z.number().finite().nonnegative(),
});
const timestampSchema = z.object({
  signed: z.object({
    expires: z.iso.datetime(),
    issued_at: z.iso.datetime(),
  }),
});
const targetsSchema = z.object({
  signed: z.object({
    targets: z.record(z.string(), z.unknown()),
    openplans: z.strictObject({
      publishers: z.record(z.string(), publisherSchema),
    }),
    delegations: z.unknown().optional(),
  }),
});
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const metadataNames = [
  "root.json",
  "timestamp.json",
  "snapshot.json",
  "targets.json",
] as const;

export interface RegistryOptions {
  url: string;
  dataDir: string;
  trustFile?: string;
  registries?: readonly RegistryDefinition[];
  pinnedSha256?: string;
  admission?: Pick<TransientFetchOptions, "admission" | "projectUrl">;
}
export interface CatalogEntry extends z.infer<typeof releaseSchema> {
  target: string;
  length: number;
  sha256: string;
}

export async function configuredRegistries(
  dataDir: string,
  trustFile = join(dataDir, "registries", "trust.json"),
  configured?: readonly RegistryDefinition[],
) {
  const trust = configured?.length
    ? { registries: registryDefinitionsSchema.parse(configured) }
    : trustSchema.parse(
        JSON.parse(
          (await boundedRead(trustFile, REGISTRY_LIMITS.root)).toString("utf8"),
        ),
      );
  const registries = trust.registries.map((entry) => ({
    ...entry,
    url: registryUrl(entry.url).href,
    root: resolve(dirname(trustFile), entry.root),
  }));
  if (new Set(registries.map((entry) => entry.url)).size !== registries.length)
    throw new Error("registry_duplicate_trust");
  return registries;
}

async function atomicWrite(path: string, data: Buffer | string) {
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function optionalRead(path: string) {
  return boundedRead(path, REGISTRY_LIMITS.metadata).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
}

async function persistMetadata(work: string, metadata: string) {
  for (const name of metadataNames) {
    const bytes = await optionalRead(join(work, name));
    if (bytes) await atomicWrite(join(metadata, name), bytes);
  }
}

async function withCatalog<T>(
  options: RegistryOptions,
  run: (
    updater: Updater,
    entries: CatalogEntry[],
    quarantine: string,
    assertFresh: () => void,
    context: { metadata: string; seed: Buffer; origin: string },
  ) => Promise<T>,
): Promise<T> {
  const url = registryUrl(options.url);
  const trust = await registryTrust(options);
  const seed = await boundedRead(trust.root, REGISTRY_LIMITS.root);
  const directory = join(options.dataDir, "registries", hash(trust.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (
    !(await lstat(directory)).isDirectory() ||
    (await lstat(directory)).isSymbolicLink()
  )
    throw new Error("registry_state_directory_refused");
  const lock = join(directory, "lock");
  await mkdir(lock, { mode: 0o700 });
  let work: string | undefined;
  try {
    const clockPath = join(directory, "state.json");
    const prior = await optionalRead(clockPath);
    const now = Date.now();
    const state = prior
      ? clockSchema.parse(JSON.parse(prior.toString("utf8")))
      : { anchor: hash(seed), lastSeen: now };
    if (state.anchor !== hash(seed))
      throw new Error("registry_trust_anchor_changed");
    if (
      !Number.isSafeInteger(now) ||
      now < Date.UTC(2020, 0, 1) ||
      now < state.lastSeen - 60_000
    )
      throw new Error("registry_clock_refused");
    const metadata = join(directory, "metadata");
    await mkdir(metadata, { mode: 0o700, recursive: true });
    if ((await lstat(metadata)).isSymbolicLink())
      throw new Error("registry_state_directory_refused");
    if (!prior) {
      const existingRoot = await optionalRead(join(metadata, "root.json"));
      if (existingRoot && !existingRoot.equals(seed))
        throw new Error("registry_incomplete_bootstrap");
      await atomicWrite(join(metadata, "root.json"), seed);
    }
    await atomicWrite(
      clockPath,
      JSON.stringify({
        anchor: state.anchor,
        lastSeen: Math.max(now, state.lastSeen),
      }),
    );
    work = await mkdtemp(join(directory, "refresh-"));
    for (const name of metadataNames) {
      const bytes = await optionalRead(join(metadata, name));
      if (bytes) await writeFile(join(work, name), bytes, { mode: 0o600 });
    }
    const quarantine = join(directory, "quarantine");
    const updater = new Updater({
      metadataDir: work,
      metadataBaseUrl: new URL("metadata/", url).href,
      targetBaseUrl: new URL("targets/", url).href,
      fetcher: new RegistryFetcher(
        url,
        quarantine,
        options.dataDir,
        options.admission,
      ),
      config: {
        maxRootRotations: 32,
        maxDelegations: 0,
        rootMaxLength: REGISTRY_LIMITS.root,
        timestampMaxLength: REGISTRY_LIMITS.root,
        snapshotMaxLength: REGISTRY_LIMITS.metadata,
        targetsMaxLength: REGISTRY_LIMITS.metadata,
      },
    });
    try {
      await updater.refresh();
      const root = rootPolicySchema.parse(
        JSON.parse(await readFile(join(work, "root.json"), "utf8")),
      ).signed;
      if (
        root.roles.root.keyids.some((id) => !root.keys[id]) ||
        new Set(
          root.roles.root.keyids.map((id) => root.keys[id]?.keyval.public),
        ).size !== 3
      )
        throw new Error("registry_root_policy_refused");
      const timestamp = timestampSchema.parse(
        JSON.parse(await readFile(join(work, "timestamp.json"), "utf8")),
      ).signed;
      const issued = Date.parse(timestamp.issued_at);
      const expires = Date.parse(timestamp.expires);
      const assertFresh = () => {
        const checkedAt = Date.now();
        if (checkedAt < Math.max(now, state.lastSeen) - 60_000)
          throw new Error("registry_clock_refused");
        if (expires <= checkedAt) throw new Error("registry_timestamp_expired");
      };
      assertFresh();
      if (expires - issued !== TWO_DAYS || issued > Date.now() + 60_000)
        throw new Error("registry_timestamp_policy_refused");
      const targets = targetsSchema.parse(
        JSON.parse(await readFile(join(work, "targets.json"), "utf8")),
      ).signed;
      if (targets.delegations !== undefined)
        throw new Error("registry_delegations_unsupported");
      const paths = Object.keys(targets.targets);
      if (paths.length > REGISTRY_LIMITS.targets)
        throw new Error("registry_target_count_refused");
      const entries: CatalogEntry[] = [];
      const identities = new Set<string>();
      for (const path of paths) {
        safeTargetPath(path);
        const info = await updater.getTargetInfo(path);
        if (!info) throw new Error("registry_target_missing");
        const identity = releaseSchema.parse(info.custom.openplans);
        if (
          trust.namespaces &&
          !trust.namespaces.includes(identity.name.split("/")[0]!)
        )
          continue;
        const key = `${identity.name}@${identity.version}`;
        if (identities.has(key)) throw new Error("registry_duplicate_package");
        identities.add(key);
        if (
          !Number.isSafeInteger(info.length) ||
          info.length <= 0 ||
          info.length > REGISTRY_LIMITS.artifact ||
          !/^[a-f0-9]{64}$/.test(info.hashes.sha256 ?? "")
        )
          throw new Error("registry_target_integrity_refused");
        const publisher = targets.openplans.publishers[identity.publisher];
        if (!publisher || publisher.id !== identity.publisher)
          throw new Error("registry_publisher_unknown");
        const { revoked } = verifyPublisherSignature(
          publisher,
          { ...identity, sha256: info.hashes.sha256! },
          identity.signature,
          identity.publishedAt,
        );
        if (revoked && identity.yanked?.reason !== "publisher_key_revoked")
          throw new Error("registry_revocation_yank_missing");
        if (identity.provenance)
          verifyProvenance(identity.provenance, {
            ...identity,
            sha256: info.hashes.sha256!,
          });
        entries.push({
          ...identity,
          target: path,
          length: info.length,
          sha256: info.hashes.sha256!,
        });
      }
      // Persist authenticated metadata before installation can write a plugin lock.
      await persistMetadata(work, metadata);
      assertFresh();
      await atomicWrite(
        join(directory, "catalog.json"),
        JSON.stringify({ expires: timestamp.expires, entries }),
      );
      return await run(updater, entries, quarantine, assertFresh, {
        metadata: work,
        seed,
        origin: trust.url,
      });
    } finally {
      // tuf-js writes only verified updates. Retain accepted version counters even if
      // a later metadata role, target or local package check refuses the operation.
      await persistMetadata(work, metadata);
    }
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function searchRegistry(
  query: string,
  options: RegistryOptions,
): Promise<CatalogEntry[]> {
  if (!query || query.length > 200) throw new Error("registry_query_refused");
  return withCatalog(options, async (_updater, entries) =>
    entries
      .filter((entry) => !entry.yanked && !entry.tombstone)
      .filter((entry) =>
        `${entry.name} ${entry.summary}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .sort((a, b) =>
        `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
      ),
  );
}

async function registryTrust(options: RegistryOptions) {
  const url = registryUrl(options.url).href;
  const trust = (
    await configuredRegistries(
      options.dataDir,
      options.trustFile,
      options.registries,
    )
  ).find((entry) => entry.url === url || entry.mirrors?.includes(url));
  if (!trust) throw new Error("registry_not_trusted");
  return trust;
}
export async function registryOrigin(
  options: RegistryOptions,
): Promise<string> {
  return (await registryTrust(options)).url;
}
function assertInstallable(entry: CatalogEntry, pinnedSha256?: string) {
  if (entry.tombstone)
    throw new Error(`registry_package_deleted:${entry.tombstone.reason}`);
  if (pinnedSha256 !== undefined && pinnedSha256 !== entry.sha256)
    throw new Error("registry_pin_mismatch");
  if (entry.yanked && pinnedSha256 !== entry.sha256)
    throw new Error("registry_package_yanked:exact_digest_pin_required");
}
function exactIdentity(specifier: string) {
  const match = /^(@[^@]+)@([^@]+)$/.exec(specifier);
  if (!match) throw new Error("registry_exact_version_required");
  return identitySchema
    .pick({ name: true, version: true })
    .parse({ name: match[1], version: match[2] });
}
async function installRegistryPackage<T>(
  identity: { name: string; version?: string },
  options: RegistryOptions,
  install: (
    file: string,
    entry: CatalogEntry,
    origin: `registry:${string}`,
    assertFresh: () => void,
  ) => Promise<T>,
) {
  return withCatalog(
    options,
    async (updater, entries, quarantine, assertFresh, context) => {
      const candidates = entries.filter((item) => item.name === identity.name);
      // Automatic updates select stable releases only. Explicit --to can select a prerelease.
      const entry = identity.version
        ? candidates.find((item) => item.version === identity.version)
        : candidates
            .filter(
              (item) =>
                !item.yanked &&
                !item.tombstone &&
                !item.version.split("+")[0]!.includes("-"),
            )
            .sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!entry) throw new Error("registry_package_not_found");
      assertInstallable(entry, options.pinnedSha256);
      const info: TargetFile | undefined = await updater.getTargetInfo(
        entry.target,
      );
      if (!info) throw new Error("registry_target_missing");
      await mkdir(quarantine, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(join(quarantine, "install-"));
      try {
        const file = join(temporary, "package.tgz");
        await updater.downloadTarget(info, file);
        assertFresh();
        return await install(
          file,
          entry,
          `registry:${context.origin}`,
          assertFresh,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
}
async function installResolved(
  identity: { name: string; version?: string },
  pluginsDirectory: string,
  options: RegistryOptions,
  installOptions: InstallPluginOptions,
) {
  return installRegistryPackage(
    identity,
    options,
    (file, entry, origin, assertFresh) =>
      installPlugin(file, pluginsDirectory, {
        ...installOptions,
        beforeCommit: assertFresh,
        origin,
        expectedIdentity: { name: entry.name, version: entry.version },
        provenance: entry.provenance
          ? { ...entry.provenance, sha256: entry.sha256 }
          : undefined,
      }),
  );
}

export function installRegistryData(
  specifier: string,
  options: RegistryOptions,
) {
  return installRegistryPackage(
    exactIdentity(specifier),
    options,
    (file, entry, origin, assertFresh) =>
      withVerifiedPackage(file, async (root, verified) => {
        if (
          verified.manifest.name !== entry.name ||
          verified.manifest.version !== entry.version
        )
          throw new Error("Registry package identity mismatch");
        assertFresh();
        return installDataPackage(root, options.dataDir, origin);
      }),
  );
}

function compareVersions(a: string, b: string): number {
  const left = a.split("+")[0]!.split(".").map(BigInt);
  const right = b.split("+")[0]!.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) return 1;
    if (left[i]! < right[i]!) return -1;
  }
  return 0;
}
export async function installRegistryPlugin(
  specifier: string,
  pluginsDirectory: string,
  options: RegistryOptions,
  installOptions: InstallPluginOptions = {},
) {
  return installResolved(
    exactIdentity(specifier),
    pluginsDirectory,
    options,
    installOptions,
  );
}
export async function updateRegistryPlugin(
  name: string,
  to: string | undefined,
  pluginsDirectory: string,
  options: RegistryOptions,
  installOptions: InstallPluginOptions = {},
) {
  const { readPluginLock } = await import("../lock.js");
  const lockfile =
    installOptions.lockfile ?? join(pluginsDirectory, "plugins.lock.json");
  const pinned = (await readPluginLock(lockfile)).packages.find(
    (item) => item.name === name,
  );
  if (!pinned) throw new Error("registry_package_not_installed");
  if (pinned.origin !== `registry:${await registryOrigin(options)}`)
    throw new Error("registry_package_origin_conflict");
  if (to) exactIdentity(`${name}@${to}`);
  return installResolved({ name, version: to }, pluginsDirectory, options, {
    ...installOptions,
    lockfile,
  });
}

const cachedCatalogSchema = z.object({
  expires: z.iso.datetime(),
  entries: z.array(
    releaseSchema.extend({
      target: z.string(),
      length: z.number(),
      sha256: z.string(),
    }),
  ),
});
/** Listing may fall back to the last fully verified catalog, but cannot install from it. */
export async function registryStatus(options: RegistryOptions) {
  try {
    return await withCatalog(
      options,
      async (_updater, entries, _quarantine, _assertFresh, context) => {
        const timestamp = timestampSchema.parse(
          JSON.parse(
            await readFile(join(context.metadata, "timestamp.json"), "utf8"),
          ),
        );
        return {
          freshness: "fresh" as const,
          expires: timestamp.signed.expires,
          entries,
          warning: null,
        };
      },
    );
  } catch (error) {
    const expired = error instanceof Error && /expired/.test(error.message);
    const trust = await registryTrust(options);
    try {
      const cached = cachedCatalogSchema.parse(
        JSON.parse(
          (
            await boundedRead(
              join(
                options.dataDir,
                "registries",
                hash(trust.url),
                "catalog.json",
              ),
              REGISTRY_LIMITS.metadata,
            )
          ).toString("utf8"),
        ),
      );
      return {
        ...cached,
        freshness:
          expired || Date.parse(cached.expires) <= Date.now()
            ? ("stale" as const)
            : ("unavailable" as const),
        warning:
          "Catalog refresh failed; cached notices only. Install and update require a fresh verified catalog.",
      };
    } catch {
      return {
        freshness: "unknown" as const,
        expires: null,
        entries: [] as CatalogEntry[],
        warning:
          "No verified catalog is available. Install and update require a fresh verified catalog.",
      };
    }
  }
}

/** Keep signed metadata intact: a subset of archives, with the original signed target index. */
export async function bundleRegistryPlugin(
  specifier: string,
  out: string,
  options: RegistryOptions,
) {
  const identity = exactIdentity(specifier);
  return withCatalog(
    options,
    async (updater, entries, quarantine, assertFresh, context) => {
      const entry = entries.find(
        (item) =>
          item.name === identity.name && item.version === identity.version,
      );
      if (!entry) throw new Error("registry_package_not_found");
      assertInstallable(entry, options.pinnedSha256);
      const info = await updater.getTargetInfo(entry.target);
      if (!info) throw new Error("registry_target_missing");
      const destination = resolve(out);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = await mkdtemp(join(dirname(destination), ".bundle-"));
      try {
        const metadata = join(temporary, "metadata");
        await mkdir(metadata);
        const rootVersion = (bytes: Buffer) =>
          z
            .object({
              signed: z.object({ version: z.number().int().positive() }),
            })
            .parse(JSON.parse(bytes.toString("utf8"))).signed.version;
        const seedVersion = rootVersion(context.seed);
        const latest = rootVersion(
          await readFile(join(context.metadata, "root.json")),
        );
        if (latest - seedVersion > 32)
          throw new Error("registry_bundle_root_chain_too_long");
        await writeFile(
          join(metadata, `${seedVersion}.root.json`),
          context.seed,
        );
        await writeFile(join(temporary, "bootstrap-root.json"), context.seed);
        const fetcher = new RegistryFetcher(
          registryUrl(options.url),
          quarantine,
          options.dataDir,
          options.admission,
        );
        for (let version = seedVersion + 1; version <= latest; version++) {
          const bytes = await fetcher.downloadBytes(
            new URL(`metadata/${version}.root.json`, registryUrl(options.url))
              .href,
            REGISTRY_LIMITS.root,
          );
          await writeFile(join(metadata, `${version}.root.json`), bytes);
        }
        await writeFile(
          join(metadata, "root.json"),
          await readFile(join(context.metadata, "root.json")),
        );
        await writeFile(
          join(metadata, "timestamp.json"),
          await readFile(join(context.metadata, "timestamp.json")),
        );
        for (const role of ["snapshot", "targets"]) {
          const bytes = await readFile(join(context.metadata, `${role}.json`));
          const version = rootVersion(bytes);
          await writeFile(join(metadata, `${version}.${role}.json`), bytes);
        }
        const archive = join(
          temporary,
          "targets",
          dirname(entry.target),
          `${entry.sha256}.${basename(entry.target)}`,
        );
        await mkdir(dirname(archive), { recursive: true });
        await updater.downloadTarget(info, archive);
        assertFresh();
        await withVerifiedPackage(archive, async (_root, verified) => {
          if (
            verified.manifest.name !== entry.name ||
            verified.manifest.version !== entry.version
          )
            throw new Error("registry_package_identity_mismatch");
          if (verified.manifest.kind === "data")
            throw new Error("registry_bundle_code_package_required");
        });
        // A fresh client checks the exported chain and target before making the bundle visible.
        const { pathToFileURL } = await import("node:url");
        const checkData = await mkdtemp(join(quarantine, "bundle-check-"));
        try {
          const url = pathToFileURL(temporary + "/").href;
          await withCatalog(
            {
              url,
              dataDir: checkData,
              registries: [
                { url, root: join(temporary, "bootstrap-root.json") },
              ],
            },
            async (check) => {
              const target = await check.getTargetInfo(entry.target);
              if (!target) throw new Error("registry_target_missing");
              await check.downloadTarget(
                target,
                join(checkData, "checked.tgz"),
              );
            },
          );
        } finally {
          await rm(checkData, { recursive: true, force: true });
        }
        // Refuse an existing output, including an empty directory or a symbolic link.
        assertFresh();
        try {
          await lstat(destination);
          throw new Error("registry_bundle_output_exists");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
        }
        await rename(temporary, destination);
        return {
          state: "bundled",
          name: entry.name,
          version: entry.version,
          registry: context.origin,
          directory: destination,
          archiveSha256: entry.sha256,
          approval: "not_granted",
        };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
}
