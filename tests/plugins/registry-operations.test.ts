import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TargetFile } from "@tufjs/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { readPluginLock } from "../../src/plugins/lock.js";
import {
  listInstalledPlugins,
  removeInstalledPlugin,
} from "../../src/plugins/package/operations.js";
import { writeArchive } from "../../src/plugins/package/archive.js";
import { inventory } from "../../src/plugins/package/files.js";
import * as packageFiles from "../../src/plugins/package/files.js";
import { installPlugin } from "../../src/plugins/package/install.js";
import {
  bundleRegistryPlugin,
  configuredRegistries,
  installRegistryPlugin,
  searchRegistry,
  updateRegistryPlugin,
} from "../../src/plugins/registry/client.js";
import type * as Client from "../../src/plugins/registry/client.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import { CORE_WORKER_ARGV } from "../../src/plugins/registries.js";
import { coreWorkerCommands } from "../../src/worker/commands.js";
import { SyntheticRegistry, TWO_DAYS } from "./registry-fixture.js";
import { changeJson, seal, syntheticPlugin } from "./package-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function temporary() {
  const base = await mkdtemp(join(tmpdir(), "openplans-regops-synthetic-"));
  scratch.push(base);
  return base;
}
async function fixture() {
  const base = await temporary();
  const marker = join(base, "import-sentinel");
  const registry = await new SyntheticRegistry(base).initialize(marker);
  const dataDir = join(base, "data");
  await registry.trust(dataDir);
  const directory = join(base, "plugins");
  const lockfile = join(base, "plugins.lock.json");
  const approvedList = join(base, "approved.json");
  await writeFile(approvedList, "[]\n");
  const installOptions = { lockfile, approvedList };
  const options = { url: registry.url, dataDir };
  const installed = await installRegistryPlugin(
    `${registry.name}@1.0.0`,
    directory,
    options,
    installOptions,
  );
  const approvalBytes = JSON.stringify([
    {
      name: installed.name,
      version: installed.version,
      digest: installed.digest,
      sha256: installed.legacySha256,
    },
  ]);
  await writeFile(approvedList, approvalBytes);
  const config = (entry = installed.package, enabled = true) =>
    loadConfig(
      {},
      {
        version: 1,
        plugins: {
          entries: [{ package: entry, enabled }],
          lockfile,
          approvedList,
          requireApproval: true,
        },
      },
    );
  return {
    base,
    marker,
    registry,
    dataDir,
    directory,
    lockfile,
    approvedList,
    approvalBytes,
    installed,
    installOptions,
    options,
    config,
  };
}
async function versionBody(
  registry: SyntheticRegistry,
  version: string,
  sentinel?: string,
) {
  const plugin = await syntheticPlugin(registry.name);
  scratch.push(plugin.root);
  plugin.manifest.version = version;
  await changeJson(join(plugin.root, "package.json"), (pkg) => {
    pkg.version = version;
  });
  let source = (
    await readFile(join(plugin.root, "dist/index.js"), "utf8")
  ).replace('"version":"1.0.0"', `"version":"${version}"`);
  if (sentinel)
    source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "synthetic imported");\n${source}`;
  await writeFile(join(plugin.root, "dist/index.js"), source);
  await seal(plugin.root, plugin.manifest);
  const archive = join(await temporary(), "synthetic.tgz");
  await writeArchive(
    plugin.root,
    await inventory(plugin.root, 50 * 1024 * 1024),
    archive,
  );
  registry.body = await readFile(archive);
}
const cli = fileURLToPath(new URL("../../dist/worker/cli.js", import.meta.url));
function child(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, "plugin", ...args], {
    env: {
      ...process.env,
      OPENPLANS_PLUGINS: "@synthetic/must-never-import",
      OPENPLANS_CONFIG: "",
      ...env,
    },
    encoding: "utf8",
  });
}
const refusal = () => {
  throw new Error("synthetic load refused");
};

async function unapprovedUpdate(update = updateRegistryPlugin) {
  const f = await fixture();
  const marker = join(f.base, "new-version-sentinel");
  await versionBody(f.registry, "2.0.0", marker);
  await f.registry.publish({ version: 2, packageVersion: "2.0.0" });
  const updated = await update(
    f.registry.name,
    "2.0.0",
    f.directory,
    f.options,
    f.installOptions,
  );
  expect(updated.approval).toBe("not_granted");
  expect(await readFile(f.approvedList, "utf8")).toBe(f.approvalBytes);
  const config = f.config(updated.package);
  await expect(
    loadPlugins(config, "worker", {
      baseDirectory: f.base,
      env: {},
      exit: refusal,
    }),
  ).rejects.toThrow();
  await expect(lstat(marker)).rejects.toThrow();
  expect((await readPluginLock(f.lockfile)).packages[0]?.digest).toBe(
    updated.digest,
  );
  expect(updated.digest).not.toBe(f.installed.digest);
  await expect(
    lstat(join(f.directory, "synthetic/registry/1.0.0/dist/index.js")),
  ).resolves.toBeDefined();
  await writeFile(
    f.approvedList,
    JSON.stringify([
      {
        name: updated.name,
        version: updated.version,
        digest: updated.digest,
        sha256: updated.legacySha256,
      },
    ]),
  );
  const loaded = await loadPlugins(config, "worker", {
    baseDirectory: f.base,
    env: {},
    exit: refusal,
  });
  try {
    expect(await readFile(marker, "utf8")).toBe("synthetic imported");
  } finally {
    await loaded.teardown();
  }
}

describe("registry operator commands, synthetic local catalogs only", () => {
  it("updates exact bytes beside the old version and refuses the new version until approved", async () => {
    await unapprovedUpdate();
  });

  it("detects a mutant that copies approval to the updated digest", async () => {
    const source = new URL(
      "../../src/plugins/registry/client.ts",
      import.meta.url,
    );
    const original = await readFile(source, "utf8");
    const changed = original.replace(
      /return installResolved\(\{ name, version: to \}, pluginsDirectory, options, \{[\s\S]*?\}\);/,
      `const installed = await installResolved({ name, version: to }, pluginsDirectory, options, { ...installOptions, lockfile });
      if (installOptions.approvedList) await writeFile(installOptions.approvedList, JSON.stringify([{ name: installed.name, version: installed.version, digest: installed.digest, sha256: installed.legacySha256 }]));
      return installed;`,
    );
    expect(changed).not.toBe(original);
    const mutant = await plantMutant(source, original, changed);
    try {
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(mutant.path).href
      )) as typeof Client;
      await expect(
        unapprovedUpdate(module.updateRegistryPlugin),
      ).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses removal of enabled current or old versions, then removes all managed versions and only its lock entry", async () => {
    const f = await fixture();
    await expect(
      removeInstalledPlugin(
        f.registry.name,
        f.directory,
        f.config(),
        f.base,
        {},
      ),
    ).rejects.toThrow(/remove_enabled/);
    await versionBody(f.registry, "2.0.0");
    await f.registry.publish({ version: 2, packageVersion: "2.0.0" });
    const next = await updateRegistryPlugin(
      f.registry.name,
      "2.0.0",
      f.directory,
      f.options,
      f.installOptions,
    );
    await expect(
      removeInstalledPlugin(
        f.registry.name,
        f.directory,
        f.config(),
        f.base,
        {},
      ),
    ).rejects.toThrow(/remove_enabled/);
    const other = await syntheticPlugin("@synthetic/other");
    scratch.push(other.root);
    await seal(other.root, other.manifest);
    await installPlugin(other.root, f.directory, f.installOptions);
    const removed = await removeInstalledPlugin(
      f.registry.name,
      f.directory,
      f.config(next.package, false),
      f.base,
      {},
    );
    expect(removed.state).toBe("removed");
    expect(
      (await readPluginLock(f.lockfile)).packages.map((entry) => entry.name),
    ).toEqual(["@synthetic/other"]);
    await expect(
      lstat(join(f.directory, "synthetic/registry")),
    ).rejects.toThrow();
    expect(await readFile(f.approvedList, "utf8")).toBe(f.approvalBytes);
  });

  it("refuses the same name from a second registry, including direct installer calls", async () => {
    const f = await fixture();
    const other = await new SyntheticRegistry(await temporary()).initialize();
    await versionBody(other, "2.0.0");
    await other.publish({ packageVersion: "2.0.0" });
    const registries = [
      { url: f.registry.url, root: f.registry.rootFile },
      { url: other.url, root: other.rootFile },
    ];
    const options = { ...f.options, url: other.url, registries };
    await expect(
      installRegistryPlugin(
        `${other.name}@2.0.0`,
        f.directory,
        options,
        f.installOptions,
      ),
    ).rejects.toThrow(/origin_conflict/);
    await expect(
      updateRegistryPlugin(
        other.name,
        "2.0.0",
        f.directory,
        options,
        f.installOptions,
      ),
    ).rejects.toThrow(/origin_conflict/);
    expect((await readPluginLock(f.lockfile)).packages[0]?.origin).toBe(
      f.installed.origin,
    );
    await expect(
      lstat(join(f.directory, "synthetic/registry/2.0.0")),
    ).rejects.toThrow();
  });

  it("validates ordered config, disjoint namespace ownership and mirror identity", async () => {
    const f = await fixture();
    const mirror = pathToFileURL(join(f.base, "mirror") + "/").href;
    const definitions = [
      {
        url: f.registry.url,
        root: f.registry.rootFile,
        namespaces: ["@synthetic"],
        mirrors: [mirror],
      },
    ];
    expect(
      loadConfig({}, { version: 1, plugins: { registries: definitions } })
        .plugins.registries[0]?.url,
    ).toBe(f.registry.url);
    expect(
      await configuredRegistries(f.dataDir, undefined, definitions),
    ).toEqual(definitions);
    expect(() =>
      loadConfig(
        {},
        {
          version: 1,
          plugins: {
            registries: [
              ...definitions,
              {
                url: "file:///synthetic/second",
                root: "second.json",
                namespaces: ["@synthetic"],
              },
            ],
          },
        },
      ),
    ).toThrow(/namespace_conflict/);
    expect(() =>
      loadConfig(
        {},
        {
          version: 1,
          plugins: {
            registries: [...definitions, { url: mirror, root: "second.json" }],
          },
        },
      ),
    ).toThrow(/duplicate_trust/);
    expect(
      await searchRegistry("synthetic", {
        ...f.options,
        registries: [
          {
            url: f.registry.url,
            root: f.registry.rootFile,
            namespaces: ["@other"],
          },
        ],
      }),
    ).toEqual([]);
    await cp(f.registry.directory, fileURLToPath(mirror), { recursive: true });
    await versionBody(f.registry, "2.0.0");
    await f.registry.publish({ version: 2, packageVersion: "2.0.0" });
    await cp(f.registry.directory, fileURLToPath(mirror), {
      recursive: true,
      force: true,
    });
    const updated = await updateRegistryPlugin(
      f.registry.name,
      "2.0.0",
      f.directory,
      { ...f.options, url: mirror, registries: definitions },
      f.installOptions,
    );
    expect(updated.origin).toBe(f.installed.origin);
    expect(
      (await readdir(join(f.dataDir, "registries"))).filter((name) =>
        /^[a-f0-9]{64}$/.test(name),
      ),
    ).toHaveLength(1);
  });

  it("shows exact approval, digest, origin, freshness and authenticated notices", async () => {
    const f = await fixture();
    await f.registry.publish({
      version: 2,
      yanked: {
        at: Math.floor(Date.now() / 1000),
        reason: "publisher_key_revoked",
      },
    });
    const listed = await listInstalledPlugins(
      f.config(),
      f.base,
      {},
      { dataDir: f.dataDir },
    );
    expect(listed.packages[0]).toMatchObject({
      name: f.registry.name,
      digest: f.installed.digest,
      origin: f.installed.origin,
      approval: "approved",
      enabled: true,
      integrity: "verified",
      catalog: { freshness: "fresh" },
      notices: {
        yanked: { reason: "publisher_key_revoked" },
        revoked: { reason: "publisher_key_revoked" },
      },
    });
    expect(await searchRegistry("synthetic", f.options)).toEqual([]);
    await expect(
      installRegistryPlugin(
        `${f.registry.name}@1.0.0`,
        join(f.base, "other"),
        f.options,
      ),
    ).rejects.toThrow(/package_yanked:exact_digest_pin_required/);
    await f.registry.publish({
      version: 3,
      yanked: null,
      tombstone: { at: Math.floor(Date.now() / 1000), reason: "rights" },
    });
    const removed = await listInstalledPlugins(
      f.config(),
      f.base,
      {},
      { dataDir: f.dataDir },
    );
    expect(removed.packages[0]?.notices.removed?.reason).toBe("rights");
    await expect(
      bundleRegistryPlugin(
        `${f.registry.name}@1.0.0`,
        join(f.base, "removed-bundle"),
        f.options,
      ),
    ).rejects.toThrow(/package_deleted:rights/);
  });

  it("chooses the newest stable non-yanked exact version for an automatic update", async () => {
    const f = await fixture();
    await versionBody(f.registry, "2.10.0");
    const info = new TargetFile({
      path: "packages/synthetic/newest.tgz",
      length: 1,
      hashes: { sha256: "1".repeat(64) },
      unrecognizedFields: {
        custom: {
          openplans: {
            name: f.registry.name,
            version: "3.0.0",
            summary: "Synthetic yanked release",
            yanked: {
              at: Math.floor(Date.now() / 1000),
              reason: "operator",
            },
          },
        },
      },
    });
    const lower = new TargetFile({
      path: "packages/synthetic/older.tgz",
      length: 1,
      hashes: { sha256: "2".repeat(64) },
      unrecognizedFields: {
        custom: {
          openplans: {
            name: f.registry.name,
            version: "2.9.0",
            summary: "Synthetic older release",
          },
        },
      },
    });
    await f.registry.publish({
      version: 2,
      packageVersion: "2.10.0",
      additionalTargets: [info, lower],
    });
    const next = await updateRegistryPlugin(
      f.registry.name,
      undefined,
      f.directory,
      f.options,
      f.installOptions,
    );
    expect(next.version).toBe("2.10.0");
    await expect(
      updateRegistryPlugin(
        f.registry.name,
        "3.0.0",
        f.directory,
        f.options,
        f.installOptions,
      ),
    ).rejects.toThrow(/package_yanked/);
  });

  it("a stale catalog blocks install and update but list and an approved local startup still work", async () => {
    const f = await fixture();
    const clock = Date.now() + TWO_DAYS + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(clock);
    await expect(
      installRegistryPlugin(
        `${f.registry.name}@1.0.0`,
        join(f.base, "other"),
        f.options,
      ),
    ).rejects.toThrow(/expired/);
    await expect(
      updateRegistryPlugin(
        f.registry.name,
        undefined,
        f.directory,
        f.options,
        f.installOptions,
      ),
    ).rejects.toThrow(/expired/);
    const listed = await listInstalledPlugins(
      f.config(),
      f.base,
      {},
      { dataDir: f.dataDir },
    );
    expect(listed.packages[0]?.catalog?.freshness).toBe("stale");
    expect(listed.packages[0]?.catalog?.warning).toContain(
      "fresh verified catalog",
    );
    expect(listed.packages[0]?.approval).toBe("approved");
    const loaded = await loadPlugins(f.config(), "worker", {
      baseDirectory: f.base,
      env: {},
      exit: refusal,
    });
    try {
      expect(await readFile(f.marker, "utf8")).toBe("synthetic imported");
    } finally {
      await loaded.teardown();
    }
  });

  it("refuses expiry during local staging and preserves the old lock and approval", async () => {
    const f = await fixture();
    await versionBody(f.registry, "2.0.0");
    await f.registry.publish({ version: 2, packageVersion: "2.0.0" });
    const lockBytes = await readFile(f.lockfile, "utf8");
    const now = Date.now();
    const original = packageFiles.copyPackageFiles;
    vi.spyOn(packageFiles, "copyPackageFiles").mockImplementation(
      async (...args) => {
        await original(...args);
        vi.spyOn(Date, "now").mockReturnValue(now + TWO_DAYS + 60_000);
      },
    );
    await expect(
      updateRegistryPlugin(
        f.registry.name,
        "2.0.0",
        f.directory,
        f.options,
        f.installOptions,
      ),
    ).rejects.toThrow(/timestamp_expired/);
    expect(await readFile(f.lockfile, "utf8")).toBe(lockBytes);
    expect(await readFile(f.approvedList, "utf8")).toBe(f.approvalBytes);
    await expect(
      lstat(join(f.directory, "synthetic/registry/2.0.0")),
    ).rejects.toThrow();
  });

  it("exports a root-rotation chain and installs from a bundle with all networking disabled", async () => {
    const f = await fixture();
    await f.registry.rotate();
    await f.registry.publish({ version: 2 });
    const out = join(f.base, "bundle");
    const bundled = await bundleRegistryPlugin(
      `${f.registry.name}@1.0.0`,
      out,
      f.options,
    );
    expect(bundled.approval).toBe("not_granted");
    const mirror = pathToFileURL(out + "/").href;
    const registries = [
      { url: f.registry.url, root: f.registry.rootFile, mirrors: [mirror] },
    ];
    await rm(f.registry.directory, { recursive: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("synthetic networking disabled");
    });
    const installed = await installRegistryPlugin(
      `${f.registry.name}@1.0.0`,
      join(f.base, "airgap/plugins"),
      { url: mirror, dataDir: join(f.base, "airgap/data"), registries },
    );
    expect(installed.digest).toBe(f.installed.digest);
    expect(installed.origin).toBe(f.installed.origin);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(out, "metadata/timestamp.json"))).toEqual(
      await readFile(
        join(
          f.dataDir,
          "registries",
          createHash("sha256").update(f.registry.url).digest("hex"),
          "metadata/timestamp.json",
        ),
      ),
    );
  });

  it("refuses to export a signed catalog identity that disagrees with the archive", async () => {
    const f = await fixture();
    await f.registry.publish({
      version: 2,
      identityName: "@synthetic/wrong-identity",
    });
    const out = join(f.base, "wrong-bundle");
    await expect(
      bundleRegistryPlugin("@synthetic/wrong-identity@1.0.0", out, f.options),
    ).rejects.toThrow(/identity_mismatch/);
    await expect(lstat(out)).rejects.toThrow();
  });

  it.each(["timestamp", "targets", "archive", "root"] as const)(
    "refuses a bundle with tampered %s bytes",
    async (kind) => {
      const f = await fixture();
      const out = join(f.base, "bundle");
      await bundleRegistryPlugin(`${f.registry.name}@1.0.0`, out, f.options);
      const metadataFile = {
        timestamp: "timestamp.json",
        targets: "1.targets.json",
        root: "2.root.json",
        archive: "unused",
      }[kind]!;
      let file = join(out, "metadata", metadataFile);
      if (kind === "archive") {
        const parts = join(out, "targets/packages/synthetic/registry");
        file = join(parts, (await readdir(parts))[0]!);
      }
      if (kind === "root") await writeFile(file, "synthetic forged root");
      else
        await writeFile(
          file,
          Buffer.concat([
            await readFile(file),
            Buffer.from("synthetic tampering"),
          ]),
        );
      const url = pathToFileURL(out + "/").href;
      await expect(
        installRegistryPlugin(
          `${f.registry.name}@1.0.0`,
          join(f.base, "bad/plugins"),
          {
            url,
            dataDir: join(f.base, "bad/data"),
            registries: [{ url, root: f.registry.rootFile }],
          },
        ),
      ).rejects.toThrow();
      await expect(lstat(join(f.base, "bad/plugins"))).rejects.toThrow();
    },
  );

  it("preserves the publisher CLI exact archive pin for a yanked version", async () => {
    const f = await fixture();
    const target = (await searchRegistry("synthetic", f.options))[0]!;
    await f.registry.publish({
      version: 2,
      yanked: { at: Math.floor(Date.now() / 1000), reason: "operator" },
    });
    const configFile = join(f.base, "pin-config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        plugins: {
          lockfile: join(f.base, "pin.lock.json"),
          approvedList: f.approvedList,
        },
      }),
    );
    const env = {
      OPENPLANS_CONFIG: configFile,
      OPENPLANS_DATA_DIR: f.dataDir,
      OPENPLANS_PLUGIN_DIR: join(f.base, "pin-plugins"),
    };
    const args = [
      "install",
      `${f.registry.name}@1.0.0`,
      "--registry",
      f.registry.url,
    ];
    const unpinned = child(args, env);
    expect(unpinned.status).toBe(1);
    expect(unpinned.stderr).toContain("exact_digest_pin_required");
    const wrong = child([...args, "--pin-sha256", "0".repeat(64)], env);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("registry_pin_mismatch");
    const pinned = child([...args, "--pin-sha256", target.sha256], env);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(JSON.parse(pinned.stdout) as unknown).toMatchObject({
      approval: "not_granted",
      origin: f.installed.origin,
    });
    expect(await readFile(f.approvedList, "utf8")).toBe(f.approvalBytes);
  });

  it("real CLI uses config registries in order, keeps list independent of imports and reports stale refusals", async () => {
    const f = await fixture();
    const first = await new SyntheticRegistry(
      await temporary(),
      "@synthetic/other",
    ).initialize();
    const configFile = join(f.base, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        plugins: {
          lockfile: f.lockfile,
          approvedList: f.approvedList,
          registries: [
            { url: first.url, root: first.rootFile },
            { url: f.registry.url, root: f.registry.rootFile },
          ],
        },
      }),
    );
    const env = {
      OPENPLANS_CONFIG: configFile,
      OPENPLANS_DATA_DIR: f.dataDir,
      OPENPLANS_PLUGIN_DIR: f.directory,
    };
    const list = child(["list", "--json"], env);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout) as unknown).toMatchObject({
      packages: [{ approval: "approved" }],
    });
    await versionBody(f.registry, "2.0.0");
    await f.registry.publish({ version: 2, packageVersion: "2.0.0" });
    const update = child(["update", f.registry.name, "--to", "2.0.0"], env);
    expect(update.status, update.stderr).toBe(0);
    expect(JSON.parse(update.stdout) as unknown).toMatchObject({
      version: "2.0.0",
      origin: f.installed.origin,
      approval: "not_granted",
    });
    await expect(lstat(f.marker)).rejects.toThrow();
    const freshConfigFile = join(f.base, "fresh-config.json");
    await writeFile(
      freshConfigFile,
      JSON.stringify({
        version: 1,
        plugins: {
          lockfile: join(f.base, "fresh.lock.json"),
          approvedList: f.approvedList,
          registries: [
            { url: first.url, root: first.rootFile },
            { url: f.registry.url, root: f.registry.rootFile },
          ],
        },
      }),
    );
    const ordered = child(["install", `${f.registry.name}@2.0.0`], {
      ...env,
      OPENPLANS_CONFIG: freshConfigFile,
      OPENPLANS_PLUGIN_DIR: join(f.base, "fresh-plugins"),
    });
    expect(ordered.status, ordered.stderr).toBe(0);
    expect(JSON.parse(ordered.stdout) as unknown).toMatchObject({
      origin: f.installed.origin,
    });
    await f.registry.publish({
      version: 3,
      issuedAt: Date.now() - TWO_DAYS - 60_000,
    });
    const stale = child(["update", f.registry.name], env);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Catalog expired");
    expect(child(["list", "--json"], env).status).toBe(0);
    const bundle = child(
      ["bundle", `${first.name}@1.0.0`, "--out", join(f.base, "cli-bundle")],
      env,
    );
    expect(bundle.status, bundle.stderr).toBe(0);
    const install = child(["install", `${first.name}@1.0.0`], env);
    expect(install.status, install.stderr).toBe(0);
    expect(JSON.parse(install.stdout) as unknown).toMatchObject({
      origin: `registry:${first.url}`,
    });
    const remove = child(["remove", first.name], {
      ...env,
      OPENPLANS_PLUGINS: "",
    });
    expect(remove.status, remove.stderr).toBe(0);
  });

  it.each(["list", "update", "remove", "bundle"])(
    "reserves plugin %s for core dispatch",
    (command) => {
      expect(CORE_WORKER_ARGV).toContainEqual(["plugin", command]);
      expect(
        coreWorkerCommands.some(
          (item) => item.argv.join(" ") === `plugin ${command}`,
        ),
      ).toBe(true);
    },
  );
});
