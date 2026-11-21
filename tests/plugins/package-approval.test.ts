import { spawnSync } from "node:child_process";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { inspectPlugin, readPluginLock } from "../../src/plugins/lock.js";
import { packageContentDigest } from "../../src/plugins/package-hash.js";
import {
  CORE_WORKER_ARGV,
  emptyRegistries,
  emptySeen,
  stagingRegistrar,
} from "../../src/plugins/registries.js";
import { coreWorkerCommands } from "../../src/worker/commands.js";
import { installPlugin } from "../../src/plugins/package/install.js";
import { withVerifiedPackage } from "../../src/plugins/package/verify.js";
import { packPlugin } from "../../src/plugins/package/pack.js";
import { PACKAGE_MANIFEST } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { PLUGIN_API_VERSION } from "@openplans/plugin-sdk";
import { changeJson, seal, syntheticPlugin } from "./package-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "openplans-package-approval-"));
  scratch.push(root);
  return root;
}
const cli = fileURLToPath(new URL("../../dist/worker/cli.js", import.meta.url));

describe("installed package approval boundary, synthetic fixtures", () => {
  it("CLI install writes the real lockfile but an unapproved load never imports the sentinel", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    const base = await temporary();
    const sentinel = join(base, "import-sentinel");
    const source = await readFile(join(root, "dist/index.js"), "utf8");
    await writeFile(
      join(root, "dist/index.js"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "synthetic imported");\n${source}`,
    );
    await seal(root, manifest);
    const plugins = join(base, "plugins");
    const entrypoint = join(plugins, "synthetic/package/1.0.0/dist/index.js");
    const lockfile = join(base, "plugins.lock.json");
    const approvedList = join(base, "plugins.approved.json");
    const approvalBytes = "[]\n";
    await writeFile(approvedList, approvalBytes);
    const file = join(base, "config.json");
    const configInput = {
      version: 1,
      plugins: {
        entries: [{ package: entrypoint }],
        lockfile,
        approvedList,
        requireApproval: true,
      },
    };
    const configBytes = JSON.stringify(configInput);
    await writeFile(file, configBytes);
    const env = {
      ...process.env,
      OPENPLANS_CONFIG: file,
      OPENPLANS_PLUGIN_DIR: plugins,
      OPENPLANS_PLUGINS: "",
    };
    const install = spawnSync(
      process.execPath,
      [cli, "plugin", "install", root],
      { env, encoding: "utf8" },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain('"approval":"not_granted"');
    expect(await readFile(approvedList, "utf8")).toBe(approvalBytes);
    expect(await readFile(file, "utf8")).toBe(configBytes);
    const lock = await readPluginLock(lockfile);
    expect(lock.packages).toHaveLength(1);
    const entry = lock.packages[0]!;
    expect(entry.origin).toBe("local");
    expect(entry.digest).toBe(
      await packageContentDigest(join(plugins, "synthetic/package/1.0.0")),
    );
    expect(
      (await inspectPlugin(entry.package, base, {}, "local")).entry,
    ).toEqual(entry);
    await expect(lstat(sentinel)).rejects.toThrow();
    const verify = spawnSync(
      process.execPath,
      [
        cli,
        "plugin",
        "verify",
        "--local",
        join(plugins, "synthetic/package/1.0.0"),
      ],
      { env, encoding: "utf8" },
    );
    expect(verify.status, verify.stderr).toBe(0);
    configInput.plugins.entries[0]!.package = entry.package;
    await writeFile(file, JSON.stringify(configInput));
    const refused = spawnSync(process.execPath, [cli, "status"], {
      env,
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('"code":"plugin_approval_refused"');
    expect(refused.stderr).toContain('"reason":"package_unlisted"');
    await expect(lstat(sentinel)).rejects.toThrow();
    // A genuinely approved load proves the import sentinel is live.
    await writeFile(
      approvedList,
      JSON.stringify([
        {
          name: entry.name,
          version: entry.version,
          sha256: entry.legacySha256,
          digest: entry.digest,
        },
      ]),
    );
    const loaded = await loadPlugins(loadConfig({}, configInput), "worker", {
      baseDirectory: base,
      env: {},
      exit: () => {
        throw new Error("synthetic unexpected refusal");
      },
    });
    try {
      expect(await readFile(sentinel, "utf8")).toBe("synthetic imported");
    } finally {
      await loaded.teardown();
    }
  });

  it.each(["same", "symlink-parent", "symlink-file", "hardlink"])(
    "never overwrites an approved list through a %s lockfile target",
    async (kind) => {
      const { root, manifest } = await syntheticPlugin();
      scratch.push(root);
      await seal(root, manifest);
      const base = await temporary();
      const approvedList = join(base, "approved.json");
      await writeFile(approvedList, "[]\n");
      let lockfile = approvedList;
      if (kind === "symlink-parent") {
        await symlink(base, join(base, "alias"), "dir");
        lockfile = join(base, "alias/approved.json");
      }
      if (kind === "symlink-file") {
        lockfile = join(base, "lock.json");
        await symlink(approvedList, lockfile);
      }
      if (kind === "hardlink") {
        lockfile = join(base, "lock.json");
        await link(approvedList, lockfile);
      }
      const plugins = join(base, "plugins");
      await expect(
        installPlugin(root, plugins, { lockfile, approvedList }),
      ).rejects.toThrow(/approved list/);
      expect(await readFile(approvedList, "utf8")).toBe("[]\n");
      await expect(
        lstat(join(plugins, "synthetic/package/1.0.0")),
      ).rejects.toThrow();
    },
  );

  it("preserves other lock entries and updates a locally installed package version", async () => {
    const other = await syntheticPlugin("@synthetic/other");
    scratch.push(other.root);
    await seal(other.root, other.manifest);
    const own = await syntheticPlugin();
    scratch.push(own.root);
    await seal(own.root, own.manifest);
    const plugins = join(await temporary(), "plugins");
    const first = await installPlugin(other.root, plugins);
    const original = (await readPluginLock(first.lockfile)).packages[0]!;
    await installPlugin(own.root, plugins);
    own.manifest.version = "2.0.0";
    await changeJson(join(own.root, "package.json"), (pkg) => {
      pkg.version = "2.0.0";
    });
    await writeFile(
      join(own.root, "dist/index.js"),
      (await readFile(join(own.root, "dist/index.js"), "utf8")).replace(
        '"version":"1.0.0"',
        '"version":"2.0.0"',
      ),
    );
    await seal(own.root, own.manifest);
    const next = await installPlugin(own.root, plugins);
    const lock = await readPluginLock(next.lockfile);
    expect(lock.packages).toHaveLength(2);
    expect(lock.packages.find((entry) => entry.name === original.name)).toEqual(
      original,
    );
    expect(
      lock.packages.find((entry) => entry.name === own.manifest.name)?.version,
    ).toBe("2.0.0");
    await expect(
      lstat(join(plugins, "synthetic/package/1.0.0/package.json")),
    ).resolves.toBeDefined();
  });

  it("refuses mismatched static metadata and an actual runtime capability mismatch", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await changeJson(join(root, "package.json"), (pkg) => {
      pkg.openplansPlugin = {
        apiVersion: manifest.apiVersion,
        kinds: manifest.kinds,
        capabilities: { writes: ["staging"] },
      };
    });
    await seal(root, manifest);
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /Static package declaration mismatch/,
    );
    await changeJson(join(root, "package.json"), (pkg) => {
      pkg.openplansPlugin = {
        apiVersion: manifest.apiVersion,
        kinds: manifest.kinds,
        capabilities: {},
      };
    });
    await writeFile(
      join(root, "dist/index.js"),
      (await readFile(join(root, "dist/index.js"), "utf8")).replace(
        '"capabilities":{}',
        '"capabilities":{"writes":["staging"]}',
      ),
    );
    await writeFile(
      join(root, PACKAGE_MANIFEST),
      JSON.stringify({ ...manifest, files: undefined }),
    );
    await expect(packPlugin(root, await temporary())).rejects.toThrow(
      /Manifest\/module capabilities mismatch/,
    );
  });

  it.each(["pack", "install", "lock", "verify"])(
    "reserves the plugin %s prefix in dispatch and registration",
    (command) => {
      expect(CORE_WORKER_ARGV).toContainEqual(["plugin", command]);
      expect(
        coreWorkerCommands.some(
          (item) =>
            JSON.stringify(item.argv) === JSON.stringify(["plugin", command]),
        ),
      ).toBe(true);
      const registrar = stagingRegistrar(
        emptyRegistries(),
        {
          name: "@synthetic/shadow",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          kinds: ["workerCommands"],
        },
        "worker",
        emptySeen(),
      );
      try {
        registrar.context.workerCommands.add({
          argv: ["plugin", command],
          usage: "synthetic",
          run: async () => 0,
        });
      } catch {
        /* Read the refusal below. */
      }
      expect(registrar.refusal()?.code).toBe("plugin_registration_collision");
    },
  );
});
