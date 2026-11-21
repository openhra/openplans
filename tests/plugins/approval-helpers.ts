import {
  configurationSettings,
  recordConfigOrigins,
} from "../../src/config/diagnostics.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import type { CoreConfig, Environment } from "../../src/config/index.js";
import { loadPlugins as realLoadPlugins } from "../../src/plugins/loader.js";
import { inspectPlugin, writePluginLock } from "../../src/plugins/lock.js";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/** Explicit local approvals for host/registration tests, never used by approval-policy tests. */
export async function approvedTestConfig(
  config: CoreConfig,
  base = process.cwd(),
  env: Environment = {},
): Promise<CoreConfig> {
  const directory = await mkdtemp(join(tmpdir(), "openplans-test-approval-"));
  directories.push(directory);
  const entries = await Promise.all(
    config.plugins.entries
      .filter((entry) => entry.enabled)
      .map(
        async ({ package: name }) =>
          (await inspectPlugin(name, base, env)).entry,
      ),
  );
  const lockfile = join(directory, "plugins.lock.json");
  const approvedList = join(directory, "plugins.approved.json");
  await writePluginLock(lockfile, entries);
  await writeFile(
    approvedList,
    JSON.stringify(
      entries.map((entry) => ({
        name: entry.name,
        version: entry.version,
        sha256: entry.legacySha256,
        digest: entry.digest,
      })),
    ),
  );
  const reviewed = {
    ...config,
    plugins: { ...config.plugins, lockfile, approvedList },
  };
  return recordConfigOrigins(
    reviewed,
    Object.fromEntries(
      configurationSettings(config, "api").map(({ key, source }) => [
        key,
        source,
      ]),
    ),
  );
}

/** Synthetic standalone modules exercise registration in private mode; packages get exact approvals. */
export const loadPlugins: typeof realLoadPlugins = async (
  config,
  host,
  options = {},
) => {
  let reviewed: CoreConfig;
  try {
    reviewed = await approvedTestConfig(
      config,
      options.baseDirectory,
      options.env,
    );
  } catch {
    reviewed = {
      ...config,
      public: { quoting: false, household: false, compat: false },
    };
  }
  return realLoadPlugins(reviewed, host, {
    ...options,
    writeLog: (line) => {
      if (
        (JSON.parse(line) as { code?: string }).code !==
        "plugin_approval_unconfigured"
      )
        options.writeLog?.(line);
    },
  });
};

export async function approvedTestEnvironment(
  env: Environment,
): Promise<Record<string, string>> {
  const config = loadConfig(env);
  const reviewed = await approvedTestConfig(
    config,
    env.OPENPLANS_CONFIG ? dirname(env.OPENPLANS_CONFIG) : process.cwd(),
    env,
  );
  const configured = {
    ...env,
    OPENPLANS_PLUGINS_LOCKFILE: reviewed.plugins.lockfile,
    OPENPLANS_PLUGINS_APPROVED_LIST: reviewed.plugins.approvedList,
  };
  return Object.fromEntries(
    Object.entries(configured).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export const privateEnvironment = (env: Environment = {}): Environment => ({
  OPENPLANS_PUBLIC_QUOTING: "off",
  OPENPLANS_PUBLIC_HOUSEHOLD: "off",
  OPENPLANS_PUBLIC_COMPAT: "off",
  ...env,
});
