import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../config/index.js";
import { dataDirectory } from "../../config/access.js";
import { pluginLockPath, readPluginLock } from "../../plugins/lock.js";
import {
  bundleRegistryPlugin,
  configuredRegistries,
  installRegistryPlugin,
  installRegistryData,
  registryOrigin,
  searchRegistry,
  updateRegistryPlugin,
} from "../../plugins/registry/client.js";
import { registryUrl } from "../../plugins/registry/transport.js";
import {
  listInstalledPlugins,
  removeInstalledPlugin,
} from "../../plugins/package/operations.js";
import type { PackageCommandIo } from "./plugin-package-cli.js";

function argumentsFor(rest: readonly string[], allowed: string[]) {
  const value = rest[0];
  const flags = new Map<string, string>();
  for (let index = 1; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const argument = rest[index + 1];
    if (
      !allowed.includes(flag) ||
      flags.has(flag) ||
      !argument ||
      argument.startsWith("--")
    )
      throw new Error("registry_arguments_invalid");
    flags.set(flag, argument);
  }
  if (!value || value.startsWith("--"))
    throw new Error("registry_arguments_invalid");
  return { value, flags };
}

export async function runRegistryCommand(
  command: string,
  rest: readonly string[],
  io: PackageCommandIo,
  env: NodeJS.ProcessEnv,
  data = false,
) {
  const config = loadConfig(env);
  const base = env.OPENPLANS_CONFIG
    ? dirname(env.OPENPLANS_CONFIG)
    : process.cwd();
  const dataDir = dataDirectory(env);
  const directory = resolve(
    env.OPENPLANS_PLUGIN_DIR || join(dataDir, "plugins"),
  );
  const options = {
    dataDir,
    trustFile: env.OPENPLANS_REGISTRY_TRUST || undefined,
    registries: env.OPENPLANS_REGISTRY_TRUST
      ? undefined
      : config.plugins.registries.map((entry) => ({
          ...entry,
          root: resolve(base, entry.root),
          mirrors: entry.mirrors ? [...entry.mirrors] : undefined,
          namespaces: entry.namespaces ? [...entry.namespaces] : undefined,
        })),
  };
  const installOptions = {
    lockfile: pluginLockPath(config, base),
    approvedList: config.plugins.approvedList
      ? resolve(base, config.plugins.approvedList)
      : undefined,
    env,
  };
  if (command === "list") {
    if (rest.length && !(rest.length === 1 && rest[0] === "--json"))
      throw new Error("registry_arguments_invalid");
    const inventory = await listInstalledPlugins(config, base, env, options);
    if (rest[0] === "--json") io.out(JSON.stringify(inventory));
    else {
      if (!inventory.packages.length) io.out("No installed plugins.");
      for (const entry of inventory.packages) {
        io.out(
          `${entry.name}@${entry.version} ${entry.approval} ${entry.integrity}\n  origin: ${entry.origin}\n  package: ${entry.package}\n  digest: ${entry.digest}\n  catalog: ${entry.catalog?.freshness ?? "not_applicable"}`,
        );
        if (entry.provenance) {
          const identity = entry.provenance.identity;
          io.out(
            `  provenance: ${identity.repository}@${identity.sha} (${identity.workflowRef})`,
          );
        }
        for (const [kind, notice] of Object.entries(entry.notices))
          if (notice) io.out(`  ${kind}: ${notice.reason}`);
      }
    }
    for (const entry of inventory.packages)
      if (entry.catalog?.warning)
        io.error(
          JSON.stringify({
            code: "registry_catalog_warning",
            name: entry.name,
            freshness: entry.catalog.freshness,
            reason: entry.catalog.warning,
          }),
        );
    return 0;
  }
  if (command === "remove") {
    const { value, flags } = argumentsFor(rest, []);
    if (flags.size) throw new Error("registry_arguments_invalid");
    io.out(
      JSON.stringify(
        await removeInstalledPlugin(value, directory, config, base, env),
      ),
    );
    return 0;
  }
  const commandFlags: Record<string, string[]> = {
    update: ["--to", "--registry"],
    bundle: ["--out", "--registry"],
    search: ["--registry"],
    install: ["--registry", "--pin-sha256"],
  };
  const allowed = commandFlags[command];
  if (!allowed) throw new Error("registry_arguments_invalid");
  const { value, flags } = argumentsFor(rest, allowed);
  if (command === "bundle" && !flags.has("--out"))
    throw new Error("registry_arguments_invalid");
  const registries = await configuredRegistries(
    dataDir,
    options.trustFile,
    options.registries,
  );
  if (command === "search") {
    const urls = flags.has("--registry")
      ? [flags.get("--registry")!]
      : registries.map((entry) => entry.url);
    const results = [];
    for (const url of urls)
      results.push(
        ...(await searchRegistry(value, { ...options, url })).map((entry) => ({
          registry: url,
          ...entry,
        })),
      );
    io.out(JSON.stringify(results));
    return 0;
  }
  const name =
    command === "update" ? value : /^(@[^@]+)@[^@]+$/.exec(value)?.[1];
  if (!name) throw new Error("registry_exact_version_required");
  const lock = data
    ? { packages: [] }
    : await readPluginLock(installOptions.lockfile).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return { packages: [] };
        throw error;
      });
  const pinned = lock.packages.find((entry) => entry.name === name);
  let url = flags.get("--registry");
  if (pinned) {
    if (!pinned.origin.startsWith("registry:"))
      throw new Error("registry_package_origin_conflict");
    url ??= pinned.origin.slice("registry:".length);
    if (
      `registry:${await registryOrigin({ ...options, url })}` !== pinned.origin
    )
      throw new Error("registry_package_origin_conflict");
  } else if (command === "update")
    throw new Error("registry_package_not_installed");
  if (!url) {
    for (const registry of registries) {
      if (
        registry.namespaces &&
        !registry.namespaces.includes(name.split("/")[0]!)
      )
        continue;
      const entries = await searchRegistry(name, {
        ...options,
        url: registry.url,
      });
      if (entries.some((entry) => `${entry.name}@${entry.version}` === value)) {
        url = registry.url;
        break;
      }
    }
  }
  if (!url) throw new Error("registry_package_not_found");
  url = registryUrl(url).href;
  const pinnedSha256 = flags.get("--pin-sha256");
  if (pinnedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(pinnedSha256))
    throw new Error("registry_pin_invalid");
  const selected = { ...options, url, pinnedSha256 };
  if (command === "update") {
    io.out(
      JSON.stringify(
        await updateRegistryPlugin(
          value,
          flags.get("--to"),
          directory,
          selected,
          installOptions,
        ),
      ),
    );
  } else if (command === "bundle") {
    io.out(
      JSON.stringify(
        await bundleRegistryPlugin(value, flags.get("--out")!, selected),
      ),
    );
  } else if (data) {
    io.out(JSON.stringify(await installRegistryData(value, selected)));
  } else {
    io.out(
      JSON.stringify(
        await installRegistryPlugin(value, directory, selected, installOptions),
      ),
    );
  }
  return 0;
}
