import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import type * as RegistryModule from "../../src/plugins/registry/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Updater } from "tuf-js";
import { MetadataKind, Metadata } from "@tufjs/models";
import {
  searchRegistry,
  configuredRegistries,
  installRegistryPlugin,
} from "../../src/plugins/registry/client.js";
import {
  registryUrl,
  RegistryFetcher,
  safeTargetPath,
  REGISTRY_LIMITS,
} from "../../src/plugins/registry/transport.js";
import { readPluginLock } from "../../src/plugins/lock.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { runPackageCommand } from "../../src/worker/commands/plugin-package-cli.js";
import { CORE_WORKER_ARGV } from "../../src/plugins/registries.js";
import { coreWorkerCommands } from "../../src/worker/commands.js";
import {
  SyntheticRegistry,
  serialize,
  syntheticKeys,
  TWO_DAYS,
} from "./registry-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(sentinel = false, name?: string) {
  const base = await mkdtemp(join(tmpdir(), "openplans-registry-synthetic-"));
  scratch.push(base);
  const marker = join(base, "import-sentinel");
  const repository = await new SyntheticRegistry(base, name).initialize(
    sentinel ? marker : undefined,
  );
  const dataDir = join(base, "data");
  await repository.trust(dataDir);
  return {
    repository,
    base,
    marker,
    dataDir,
    options: { url: repository.url, dataDir },
  };
}
const statePath = (dataDir: string, url: string) =>
  join(dataDir, "registries", createHash("sha256").update(url).digest("hex"));
const cli = fileURLToPath(new URL("../../dist/worker/cli.js", import.meta.url));

function childSearch(url: string, dataDir: string) {
  return spawnSync(
    process.execPath,
    [cli, "plugin", "search", "synthetic", "--registry", url],
    {
      env: {
        ...process.env,
        OPENPLANS_DATA_DIR: dataDir,
        OPENPLANS_PLUGINS: "@synthetic/must-never-import",
        OPENPLANS_CONFIG: "",
      },
      encoding: "utf8",
    },
  );
}

describe("signed registry client with synthetic local repositories", () => {
  it("searches authenticated metadata, installs exact bytes, records origin and keeps approval separate", async () => {
    const { repository, base, options, dataDir, marker } = await fixture(true);
    const entries = await searchRegistry("synthetic", options);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: repository.name,
      version: "1.0.0",
      target: repository.targetPath,
    });
    expect(await searchRegistry("no-result", options)).toEqual([]);
    const approvedList = join(base, "approved.json");
    await writeFile(approvedList, "[]\n");
    const installed = await installRegistryPlugin(
      `${repository.name}@1.0.0`,
      join(base, "plugins"),
      options,
      { approvedList },
    );
    expect(installed.approval).toBe("not_granted");
    expect(installed.origin).toBe(`registry:${repository.url}`);
    expect((await readPluginLock(installed.lockfile)).packages[0]?.origin).toBe(
      installed.origin,
    );
    expect(await readFile(approvedList, "utf8")).toBe("[]\n");
    await expect(lstat(marker)).rejects.toThrow();
    const input = {
      version: 1,
      plugins: {
        entries: [{ package: installed.package }],
        lockfile: installed.lockfile,
        approvedList,
        requireApproval: true,
      },
    };
    const config = loadConfig({}, input);
    await expect(
      loadPlugins(config, "worker", {
        baseDirectory: base,
        env: {},
        exit: () => {
          throw new Error("synthetic approval refusal");
        },
      }),
    ).rejects.toThrow();
    await expect(lstat(marker)).rejects.toThrow();
    // The sentinel is live, and stale remote metadata does not affect an approved local load.
    await writeFile(
      approvedList,
      JSON.stringify([
        {
          name: installed.name,
          version: installed.version,
          sha256: installed.legacySha256,
          digest: installed.digest,
        },
      ]),
    );
    await repository.publish({
      version: 2,
      issuedAt: Date.now() - TWO_DAYS - 10_000,
    });
    await expect(
      installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(base, "another"),
        options,
      ),
    ).rejects.toThrow(/expired/);
    const loaded = await loadPlugins(config, "worker", {
      baseDirectory: base,
      env: {},
      exit: () => {
        throw new Error("synthetic unexpected refusal");
      },
    });
    try {
      expect(await readFile(marker, "utf8")).toBe("synthetic imported");
    } finally {
      await loaded.teardown();
    }
    expect(await readFile(approvedList, "utf8")).toContain(installed.digest);
    expect(
      await (
        await import("node:fs/promises")
      ).readdir(join(statePath(dataDir, repository.url), "quarantine")),
    ).toEqual([]);
  });

  it("refuses a timestamp that expires while a target is downloading", async () => {
    const { repository, options, base } = await fixture();
    const now = Date.now();
    await repository.publish({ issuedAt: now - TWO_DAYS + 60_000 });
    const original = Updater.prototype.downloadTarget;
    vi.spyOn(Updater.prototype, "downloadTarget").mockImplementation(
      async function (this: Updater, ...args) {
        const result = await original.apply(this, args);
        vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
        return result;
      },
    );
    await expect(
      installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(/timestamp_expired/);
    await expect(lstat(join(base, "plugins"))).rejects.toThrow();
  });

  it("refuses a backwards clock jump during target download", async () => {
    const { repository, options, base } = await fixture();
    const now = Date.now();
    const download = Updater.prototype.downloadTarget;
    vi.spyOn(Updater.prototype, "downloadTarget").mockImplementation(
      async function (this: Updater, ...args) {
        const result = await download.apply(this, args);
        vi.spyOn(Date, "now").mockReturnValue(now - TWO_DAYS);
        return result;
      },
    );
    await expect(
      installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(/clock_refused/);
    await expect(lstat(join(base, "plugins"))).rejects.toThrow();
  });

  it("uses the package descriptor identity rules for dotted package names", async () => {
    const { repository, options, base } = await fixture(
      false,
      "@synthetic/plugin.name",
    );
    const installed = await installRegistryPlugin(
      `${repository.name}@1.0.0`,
      join(base, "plugins"),
      options,
    );
    expect(installed.name).toBe(repository.name);
  });

  it.each(["snapshot", "targets"])(
    "refuses %s rollback under a newer signed timestamp",
    async (role) => {
      const { repository, options } = await fixture();
      await repository.publish({ version: 2 });
      await searchRegistry("synthetic", options);
      if (role === "snapshot")
        await repository.publish({ version: 3, snapshotVersion: 1 });
      else await repository.publish({ version: 3, targetsVersion: 1 });
      await expect(searchRegistry("synthetic", options)).rejects.toThrow(
        /less than current version/,
      );
    },
  );

  it("accepts a timestamp issued during a slow root refresh", async () => {
    const { repository, options } = await fixture();
    const now = Date.now();
    await repository.publish({ issuedAt: now + 120_000 });
    const refresh = Updater.prototype.refresh;
    vi.spyOn(Updater.prototype, "refresh").mockImplementation(async function (
      this: Updater,
    ) {
      await refresh.call(this);
      vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    });
    await expect(searchRegistry("synthetic", options)).resolves.toHaveLength(1);
  });

  it("loads the documented registry trust file through the real trust reader", async () => {
    const markdown = await readFile(
      new URL("../../docs/plugins.md", import.meta.url),
      "utf8",
    );
    const examples = [...markdown.matchAll(/^```json\n([\s\S]*?)^```$/gm)]
      .map((match) => JSON.parse(match[1]!) as unknown)
      .filter(
        (block) =>
          typeof block === "object" && block !== null && "registries" in block,
      );
    expect(examples).toHaveLength(1);
    const base = await mkdtemp(join(tmpdir(), "openplans-registry-docs-"));
    scratch.push(base);
    const file = join(base, "trust.json");
    await writeFile(file, JSON.stringify(examples[0]));
    expect(await configuredRegistries(join(base, "data"), file)).toEqual([
      {
        url: "file:///srv/openplans-catalog/",
        root: join(base, "reviewed-root.json"),
      },
    ]);
  });

  it("persists rollback protection across fresh processes", async () => {
    const { repository, dataDir } = await fixture();
    const first = childSearch(repository.url, dataDir);
    expect(first.status, first.stderr).toBe(0);
    await repository.publish({ version: 2 });
    const upgraded = childSearch(repository.url, dataDir);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    await repository.publish({ version: 1 });
    const rollback = childSearch(repository.url, dataDir);
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain("plugin_package_refused");
  });

  it("retains accepted timestamp counters when a later role fails", async () => {
    const { repository, options } = await fixture();
    await searchRegistry("synthetic", options);
    await repository.publish({ version: 3 });
    await writeFile(
      join(repository.metadata, "3.snapshot.json"),
      "synthetic corrupt snapshot",
    );
    await expect(searchRegistry("synthetic", options)).rejects.toThrow();
    await repository.publish({ version: 2 });
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /less than current version/,
    );
  });

  it("walks two consecutive 2-of-3 root rotations from an old pinned root", async () => {
    const { repository, options, dataDir } = await fixture();
    await repository.rotate();
    await repository.rotate();
    await repository.publish({ version: 3 });
    expect(await searchRegistry("synthetic", options)).toHaveLength(1);
    const trusted = JSON.parse(
      await readFile(
        join(statePath(dataDir, repository.url), "metadata/root.json"),
        "utf8",
      ),
    ) as { signed: { version: number } };
    expect(trusted.signed.version).toBe(3);
  });

  it("refuses a missing intermediate root instead of trusting the newest root", async () => {
    const { repository, options } = await fixture();
    await repository.rotate();
    await repository.rotate();
    await repository.publish({ version: 3 });
    await rm(join(repository.metadata, "2.root.json"));
    await expect(searchRegistry("synthetic", options)).rejects.toThrow();
  });

  it.each(["old", "new"])(
    "refuses the %s online key outside its root authorization window",
    async (window) => {
      const { repository, options } = await fixture();
      const old = repository.keys;
      if (window === "old") {
        await repository.rotate();
        await repository.publish({ version: 2, targetsSigner: old.targets });
      } else {
        await repository.publish({ targetsSigner: syntheticKeys().targets });
      }
      await expect(searchRegistry("synthetic", options)).rejects.toThrow(
        /signed|signatures/,
      );
    },
  );

  it.each(["old-threshold", "new-threshold", "bootstrap"])(
    "refuses a sub-threshold %s root",
    async (kind) => {
      const { repository, options } = await fixture();
      if (kind === "bootstrap") {
        const root = Metadata.fromJSON(
          MetadataKind.Root,
          JSON.parse(await readFile(repository.rootFile, "utf8")) as Parameters<
            typeof Metadata.fromJSON
          >[1],
        );
        delete root.signatures[Object.keys(root.signatures)[0]!];
        await writeFile(repository.rootFile, serialize(root));
      } else {
        const next = syntheticKeys();
        const old = repository.keys;
        const signers =
          kind === "old-threshold"
            ? [...old.roots.slice(0, 1), ...next.roots.slice(0, 2)]
            : [...old.roots.slice(0, 2), ...next.roots.slice(0, 1)];
        await repository.rotate(next, signers);
        await repository.publish({ version: 2 });
      }
      await expect(searchRegistry("synthetic", options)).rejects.toThrow(
        /signed|signatures/,
      );
    },
  );

  it.each(["snapshot", "targets"])(
    "refuses mix-and-match %s bytes",
    async (role) => {
      const { repository, options } = await fixture();
      const original = await readFile(
        join(repository.metadata, `1.${role}.json`),
      );
      await repository.publish({ version: 2 });
      await writeFile(join(repository.metadata, `2.${role}.json`), original);
      await expect(searchRegistry("synthetic", options)).rejects.toThrow();
    },
  );

  it.each(["expired", "future-issued", "long-lived"])(
    "refuses a %s timestamp",
    async (kind) => {
      const { repository, options, base } = await fixture();
      if (kind === "expired")
        await repository.publish({ issuedAt: Date.now() - TWO_DAYS - 1_000 });
      if (kind === "future-issued")
        await repository.publish({ issuedAt: Date.now() + 3_600_000 });
      if (kind === "long-lived")
        await repository.publish({ expiresAt: Date.now() + 3 * TWO_DAYS });
      await expect(
        installRegistryPlugin(
          `${repository.name}@1.0.0`,
          join(base, "plugins"),
          options,
        ),
      ).rejects.toThrow();
      await expect(lstat(join(base, "plugins"))).rejects.toThrow();
    },
  );

  it.each(["hash", "length-short", "length-long"])(
    "refuses target %s mismatch before local installation",
    async (kind) => {
      const { repository, options, base } = await fixture();
      if (kind === "hash")
        await repository.publish({ targetHash: "0".repeat(64) });
      if (kind === "length-short")
        await repository.publish({ targetLength: repository.body.length - 1 });
      if (kind === "length-long")
        await repository.publish({ targetLength: repository.body.length + 1 });
      await expect(
        installRegistryPlugin(
          `${repository.name}@1.0.0`,
          join(base, "plugins"),
          options,
        ),
      ).rejects.toThrow();
      await expect(lstat(join(base, "plugins"))).rejects.toThrow();
    },
  );

  it.each([
    "../outside.tgz",
    "/absolute.tgz",
    "safe/../../outside.tgz",
    "%2e%2e/outside.tgz",
    "safe\\outside.tgz",
    "https://example.org/a.tgz",
  ])("refuses a signed unsafe target path %s", async (targetPath) => {
    const { repository, options } = await fixture();
    await repository.publish({ targetPath });
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /target_path/,
    );
  });

  it("the timestamp policy check detects a planted lifetime-check bypass", async () => {
    const source = new URL(
      "../../src/plugins/registry/client.ts",
      import.meta.url,
    );
    const original = await readFile(source, "utf8");
    const changed = original.replace(
      "expires - issued !== TWO_DAYS ||",
      "false ||",
    );
    const mutant = await plantMutant(source, original, changed);
    try {
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(mutant.path).href
      )) as typeof RegistryModule;
      const { repository, options } = await fixture();
      await repository.publish({ expiresAt: Date.now() + 3 * TWO_DAYS });
      await expect(searchRegistry("synthetic", options)).rejects.toThrow(
        /timestamp_policy/,
      );
      const accepted = await module.searchRegistry("synthetic", options);
      expect(accepted).toHaveLength(1);
      expect(() => expect(accepted).toHaveLength(0)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses a signed identity that disagrees with the archive manifest", async () => {
    const { repository, options, base } = await fixture();
    await repository.publish({ identityName: "@synthetic/swapped" });
    await expect(
      installRegistryPlugin(
        "@synthetic/swapped@1.0.0",
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(/identity mismatch/);
    await expect(lstat(join(base, "plugins"))).rejects.toThrow();
  });

  it("refuses undeclared registries, changed anchors, ranges and unknown exact versions", async () => {
    const { repository, options, base } = await fixture();
    await expect(
      searchRegistry("synthetic", {
        ...options,
        url: "file:///synthetic-untrusted/",
      }),
    ).rejects.toThrow(/not_trusted/);
    await expect(
      installRegistryPlugin(
        `${repository.name}@^1`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow();
    await expect(
      installRegistryPlugin(
        `${repository.name}@9.0.0`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(/not_found/);
    await searchRegistry("synthetic", options);
    await writeFile(repository.rootFile, "synthetic replacement root");
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /anchor_changed/,
    );
  });

  it("refuses backwards local clock state and concurrent state writers", async () => {
    const { repository, options, dataDir } = await fixture();
    await searchRegistry("synthetic", options);
    const directory = statePath(dataDir, repository.url);
    const path = join(directory, "state.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      anchor: string;
      lastSeen: number;
    };
    await writeFile(
      path,
      JSON.stringify({ ...state, lastSeen: Date.now() + TWO_DAYS }),
    );
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /clock_refused/,
    );
    await writeFile(path, JSON.stringify(state));
    await mkdir(join(directory, "lock"));
    await expect(searchRegistry("synthetic", options)).rejects.toThrow();
  });

  it("refuses delegations and an oversized target list", async () => {
    const { repository, options } = await fixture();
    await repository.publish({ delegations: true });
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /delegations_unsupported/,
    );
    await repository.publish({
      version: 2,
      extraTargets: REGISTRY_LIMITS.targets,
    });
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /target_count_refused/,
    );
  });

  it("refuses a file target symlink escaping the configured repository", async () => {
    const { repository, options, base } = await fixture();
    const entry = (await searchRegistry("synthetic", options))[0]!;
    const path = join(
      repository.targets,
      "packages/synthetic/registry",
      `${entry.sha256}.1.0.0.tgz`,
    );
    const outside = join(base, "outside.tgz");
    await writeFile(outside, repository.body);
    await rm(path);
    await symlink(outside, path);
    await expect(
      installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(/outside_root/);
  });

  it("serves the same signed catalog from an explicitly trusted loopback mirror", async () => {
    const { repository, options, dataDir } = await fixture();
    const fileResult = await searchRegistry("synthetic", options);
    const server = createServer((req, res) => {
      void (async () => {
        const path = (req.url ?? "/").slice(1);
        try {
          safeTargetPath(path);
          res.end(await readFile(join(repository.directory, path)));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Synthetic listener unavailable");
      const url = `http://127.0.0.1:${address.port}/`;
      await repository.trust(dataDir, url);
      const mirror = await searchRegistry("synthetic", { ...options, url });
      expect(mirror).toEqual(fileResult);
      const installed = await installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(dataDir, "plugins"),
        { ...options, url },
      );
      expect(installed.origin).toBe(`registry:${url}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("caps signed artifact sizes and root metadata reads", async () => {
    const { repository, options } = await fixture();
    await repository.publish({ targetLength: REGISTRY_LIMITS.artifact + 1 });
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /target_integrity/,
    );
    await writeFile(
      join(repository.metadata, "2.root.json"),
      Buffer.alloc(REGISTRY_LIMITS.root + 1),
    );
    await expect(searchRegistry("synthetic", options)).rejects.toThrow(
      /download_size/,
    );
  });

  it("bounds chunked loopback reads and refuses redirects without following them", async () => {
    const { base, dataDir } = await fixture();
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "http://127.0.0.1:1/must-not-follow");
      }
      res.write("synthetic");
      res.end(" oversized body");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Synthetic listener unavailable");
      const url = `http://127.0.0.1:${address.port}/`;
      const fetcher = new RegistryFetcher(
        new URL(url),
        join(base, "transport-quarantine"),
        dataDir,
      );
      await expect(fetcher.downloadBytes(url + "target", 4)).rejects.toThrow(
        /download_size/,
      );
      await expect(
        fetcher.downloadBytes(url + "redirect", 100),
      ).rejects.toThrow(/HTTP read refused/);
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("runs search/install through the CLI without loading configured plugins", async () => {
    const { repository, dataDir, base } = await fixture();
    const search = childSearch(repository.url, dataDir);
    expect(search.status, search.stderr).toBe(0);
    expect(search.stdout).toContain(repository.name);
    const configFile = join(base, "config.json");
    const lockfile = join(base, "plugins.lock.json");
    await writeFile(
      configFile,
      JSON.stringify({ version: 1, plugins: { lockfile } }),
    );
    const install = spawnSync(
      process.execPath,
      [
        cli,
        "plugin",
        "install",
        `${repository.name}@1.0.0`,
        "--registry",
        repository.url,
      ],
      {
        env: {
          ...process.env,
          OPENPLANS_DATA_DIR: dataDir,
          OPENPLANS_CONFIG: configFile,
          OPENPLANS_PLUGINS: "@synthetic/must-never-import",
        },
        encoding: "utf8",
      },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain('"approval":"not_granted"');
    expect((await readPluginLock(lockfile)).packages[0]?.origin).toBe(
      `registry:${repository.url}`,
    );
    expect(CORE_WORKER_ARGV).toContainEqual(["plugin", "search"]);
    expect(
      coreWorkerCommands.some(
        (command) => command.argv.join(" ") === "plugin search",
      ),
    ).toBe(true);
    const out: string[] = [];
    expect(
      await runPackageCommand(
        ["plugin", "search", "synthetic"],
        { out: (s) => out.push(s), error: (s) => out.push(s) },
        { OPENPLANS_DATA_DIR: dataDir },
      ),
    ).toBe(0);
    expect(out.join("")).toContain(repository.name);
  });

  it("refuses embedded registry credentials", () => {
    const url = new URL("https://example.org/");
    url.username = "synthetic";
    url.password = "synthetic";
    expect(() => registryUrl(url.href)).toThrow();
  });

  it.each([
    "http://example.org/",
    "file://otherhost/path/",
    "https://example.org/?token=x",
  ])("refuses unsafe registry URL %s", (url) => {
    expect(() => registryUrl(url)).toThrow();
  });
});
