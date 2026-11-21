import { spawnSync } from "node:child_process";
import * as files from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import {
  inspectPlugin,
  lockPlugins,
  verifyPluginLock,
  writePluginLock,
} from "../../src/plugins/lock.js";
import {
  packageContentDigest,
  packageDigests,
  packageSha256,
} from "../../src/plugins/package-hash.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(name = "@synthetic/approval") {
  const base = await mkdtemp(join(tmpdir(), "openplans-synthetic-approval-"));
  scratch.push(base);
  const root = join(base, "plugin");
  await mkdir(join(root, "dist"), { recursive: true });
  const sentinel = join(base, "imported");
  const manifest = {
    name,
    version: "1.0.0",
    apiVersion: "0.2",
    kinds: [],
    capabilities: {},
  };
  const pkg = {
    name: manifest.name,
    version: manifest.version,
    type: "module",
    main: "dist/index.js",
    openplansPlugin: {
      apiVersion: manifest.apiVersion,
      kinds: manifest.kinds,
      capabilities: manifest.capabilities,
    },
  };
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(root, "dist/index.js"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)},'synthetic import'); export default {manifest:${JSON.stringify(manifest)},setup(){}};`,
  );
  const file = join(base, "config.json");
  const approvedList = join(base, "plugins.approved.json");
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: {
        entries: [{ package: "./plugin/dist/index.js" }],
        approvedList,
      },
    },
  );
  const lock = await lockPlugins(config, base, {});
  const approval = lock.packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    sha256: entry.legacySha256,
    digest: entry.digest,
  }));
  await writeFile(approvedList, JSON.stringify(approval));
  await writeFile(
    file,
    JSON.stringify({ version: 1, plugins: config.plugins }),
  );
  return {
    base,
    root,
    sentinel,
    config,
    lock,
    approval,
    approvedList,
    file,
    pkg,
  };
}
async function outcome(
  f: Awaited<ReturnType<typeof fixture>>,
  loader = loadPlugins,
  host: "api" | "worker" | "stdio" = "api",
) {
  const lines: string[] = [];
  let code = 0;
  try {
    await loader(f.config, host, {
      baseDirectory: f.base,
      env: {},
      writeLog: (line) => lines.push(line),
      exit: (value) => {
        code = value;
        throw new Error("synthetic_exit");
      },
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "synthetic_exit")
      throw error;
  }
  return { code, lines };
}
const untouched = async (path: string) =>
  expect(readFile(path)).rejects.toThrow();

describe("approval before import, synthetic packages", () => {
  it("reads package bytes once across runtime hosts and shares the verified status hash", async () => {
    const f = await fixture();
    const root = await files.realpath(f.root);
    const read = vi.mocked(files.readFile);
    read.mockClear();
    for (const host of ["api", "worker", "stdio"] as const)
      expect(await outcome(f, loadPlugins, host)).toEqual({
        code: 0,
        lines: [],
      });
    expect(
      read.mock.calls.filter(([path]) => path === join(root, "dist/index.js")),
    ).toHaveLength(1);
    expect(await packageDigests(f.root)).toEqual({
      digest: f.lock.packages[0]!.digest,
      legacySha256: await packageSha256(f.root),
    });
  });
  it.each(["bytes", "mode", "hidden", "link", "approval", "lock"])(
    "negative control: a warm runtime verification still rejects changed %s",
    async (mutation) => {
      const f = await fixture();
      expect((await outcome(f)).code).toBe(0);
      const file = join(f.root, "dist/index.js");
      if (mutation === "bytes") {
        const before = await stat(file);
        const code = await readFile(file, "utf8");
        await writeFile(
          file,
          code.replace("synthetic import", "synthetic mutant"),
        );
        await utimes(file, before.atime, before.mtime);
      }
      if (mutation === "mode") await chmod(file, 0o700);
      if (mutation === "hidden")
        await writeFile(join(f.root, ".hidden"), "synthetic");
      if (mutation === "link")
        await symlink("index.js", join(f.root, "dist/alias.js"));
      if (mutation === "approval") await writeFile(f.approvedList, "[]");
      if (mutation === "lock") await rm(join(f.base, "plugins.lock.json"));
      expect((await outcome(f)).code).toBe(1);
    },
  );
  it.each(["api", "worker", "stdio"] as const)(
    "loads an approved package on %s",
    async (host) => {
      const f = await fixture();
      expect(await outcome(f, loadPlugins, host)).toEqual({
        code: 0,
        lines: [],
      });
      expect(await readFile(f.sentinel, "utf8")).toBe("synthetic import");
    },
  );
  it.each([
    "unlisted",
    "version",
    "disk-version",
    "byte-change",
    "digest",
    "null",
    "empty",
    "extra-dist",
    "hidden",
    "mode",
    "no-list",
    "missing-lock",
    "missing-digest",
    "link",
  ])("refuses %s without importing", async (mutant) => {
    const f = await fixture();
    if (mutant === "unlisted") f.approval = [];
    if (mutant === "version") f.approval[0]!.version = "9.9.9";
    if (mutant === "disk-version")
      await writeFile(
        join(f.root, "package.json"),
        JSON.stringify({ ...f.pkg, version: "9.9.9" }),
      );
    if (mutant === "byte-change")
      await writeFile(
        join(f.root, "dist/index.js"),
        (await readFile(join(f.root, "dist/index.js"), "utf8")) +
          "\n// synthetic changed byte",
      );
    if (mutant === "digest") f.approval[0]!.digest = "f".repeat(64);
    if (mutant === "null")
      (f.approval[0] as unknown as { sha256: null }).sha256 = null;
    if (mutant === "empty") f.approval[0]!.sha256 = "";
    if (mutant === "missing-digest")
      delete (f.approval[0] as Partial<(typeof f.approval)[0]>).digest;
    if (mutant === "extra-dist")
      await writeFile(join(f.root, "dist/extra.js"), "// synthetic extra");
    if (mutant === "hidden")
      await writeFile(join(f.root, ".hidden"), "synthetic hidden");
    if (mutant === "mode") await chmod(join(f.root, "dist/index.js"), 0o700);
    if (mutant === "link")
      await symlink(f.sentinel, join(f.root, "dist/link.js"));
    if (mutant === "no-list")
      f.config = {
        ...f.config,
        plugins: { ...f.config.plugins, approvedList: undefined },
      };
    if (mutant === "missing-lock") await rm(join(f.base, "plugins.lock.json"));
    await writeFile(f.approvedList, JSON.stringify(f.approval));
    const result = await outcome(f);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({
      code: "plugin_approval_refused",
    });
    await untouched(f.sentinel);
  });
  it("checks every candidate before importing the first one", async () => {
    const f = await fixture();
    f.config = {
      ...f.config,
      plugins: {
        ...f.config.plugins,
        entries: [
          ...f.config.plugins.entries,
          { ...f.config.plugins.entries[0]!, package: "./not-listed.js" },
        ],
      },
    };
    expect((await outcome(f)).code).toBe(1);
    await untouched(f.sentinel);
  });
  it("requires approval in public mode even with no packages", async () => {
    const f = await fixture();
    f.config = loadConfig({});
    expect((await outcome(f)).code).toBe(1);
    await untouched(f.sentinel);
  });
  it("requires approval explicitly in private mode", async () => {
    const f = await fixture();
    f.config = loadConfig(
      {},
      {
        version: 1,
        public: { quoting: false, household: false, compat: false },
        plugins: { requireApproval: true },
      },
    );
    expect((await outcome(f)).code).toBe(1);
  });
  it.each(["loader", "api", "worker", "stdio"] as const)(
    "warns on an empty private %s host with no approval configured",
    async (host) => {
      const f = await fixture();
      const env = {
        OPENPLANS_PUBLIC_QUOTING: "off",
        OPENPLANS_PUBLIC_HOUSEHOLD: "off",
        OPENPLANS_PUBLIC_COMPAT: "off",
      };
      const lines: string[] = [];
      if (host === "loader") {
        f.config = loadConfig(env);
        const result = await outcome(f);
        expect(result.code).toBe(0);
        lines.push(...result.lines);
      } else if (host === "worker") {
        const { loadWorkerPlugins } =
          await import("../../src/plugins/worker.js");
        await loadWorkerPlugins({ env, writeLog: (line) => lines.push(line) });
      } else {
        const { loadApiPlugins } = await import("../../src/plugins/api.js");
        await loadApiPlugins({
          env,
          host,
          writeLog: (line) => lines.push(line),
        });
      }
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        { plugin: "openplans", code: "plugin_approval_unconfigured" },
      ]);
      await untouched(f.sentinel);
    },
  );
  it("enforces a configured approval list in private mode", async () => {
    const f = await fixture();
    f.config = {
      ...f.config,
      public: { quoting: false, household: false, compat: false },
    };
    await writeFile(f.approvedList, "[]");
    expect((await outcome(f)).code).toBe(1);
    await untouched(f.sentinel);
  });
  it("warns and loads only in private mode with no configured list", async () => {
    const f = await fixture();
    f.config = {
      ...f.config,
      public: { quoting: false, household: false, compat: false },
      plugins: { ...f.config.plugins, approvedList: undefined },
    };
    const result = await outcome(f);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({
      code: "plugin_approval_unconfigured",
    });
    expect(await readFile(f.sentinel, "utf8")).toBe("synthetic import");
  });
  it("disk verification and locking never import, and added dist bytes fail", async () => {
    const f = await fixture();
    await verifyPluginLock(f.config, f.base, {});
    await untouched(f.sentinel);
    await writeFile(join(f.root, "dist/extra.js"), "synthetic");
    await expect(verifyPluginLock(f.config, f.base, {})).rejects.toThrow();
    await untouched(f.sentinel);
  });
  it("writes deterministic lock bytes without changing approval", async () => {
    const f = await fixture();
    const first = await readFile(join(f.base, "plugins.lock.json"));
    const approval = await readFile(f.approvedList);
    await lockPlugins(f.config, f.base, {});
    expect(await readFile(join(f.base, "plugins.lock.json"))).toEqual(first);
    expect(await readFile(f.approvedList)).toEqual(approval);
    await untouched(f.sentinel);
  });
  it("the exported writer refuses duplicate package identities", async () => {
    const f = await fixture();
    const before = await readFile(join(f.base, "plugins.lock.json"));
    await expect(
      writePluginLock(join(f.base, "plugins.lock.json"), [
        f.lock.packages[0]!,
        f.lock.packages[0]!,
      ]),
    ).rejects.toThrow();
    expect(await readFile(join(f.base, "plugins.lock.json"))).toEqual(before);
  });
  it("refuses to overwrite the configured approval file with a lock", async () => {
    const f = await fixture();
    const before = await readFile(f.approvedList);
    await expect(
      lockPlugins(
        {
          ...f.config,
          plugins: { ...f.config.plugins, lockfile: f.approvedList },
        },
        f.base,
        {},
      ),
    ).rejects.toThrow("plugin_lock_is_approval_file");
    expect(await readFile(f.approvedList)).toEqual(before);
  });
  it("does not exempt a bundled name or a bundled origin", async () => {
    const f = await fixture("@openplans/plugin-synthetic-approval");
    const entry = { ...f.lock.packages[0]!, origin: "bundled" };
    await writePluginLock(join(f.base, "plugins.lock.json"), [entry]);
    await writeFile(f.approvedList, "[]");
    expect((await outcome(f)).code).toBe(1);
    await untouched(f.sentinel);
  });
  it("the sentinel assertion catches a planted check-after-import mutant", async () => {
    const f = await fixture();
    await writeFile(f.approvedList, "[]");
    const before =
      "const verified = await verifyPlugins(config, base, env, options.writeLog ?? ((line) => process.stderr.write(`${line}\\n`)));";
    const mutant = await plantMutant(
      new URL("../../src/plugins/loader.ts", import.meta.url),
      before,
      "for (const entry of config.plugins.entries) if (entry.enabled) await importPlugin(entry.package, base); " +
        before,
    );
    try {
      const loaded = (await import(mutant.path)) as {
        loadPlugins: typeof loadPlugins;
      };
      expect((await outcome(f, loaded.loadPlugins)).code).toBe(1);
      await expect(untouched(f.sentinel)).rejects.toThrow(); // The same sentinel assertion fails on the mutant.
    } finally {
      await mutant.cleanup();
    }
  });
  it("native worker lock and verify bypass plugin startup and storage", async () => {
    const f = await fixture();
    const cli = fileURLToPath(
      new URL("../../dist/worker/cli.js", import.meta.url),
    );
    const env = { PATH: process.env.PATH, OPENPLANS_CONFIG: f.file };
    for (const args of [
      ["plugin", "lock"],
      ["plugin", "verify", "--json"],
    ]) {
      const hook = `import {registerHooks} from 'node:module'; registerHooks({resolve(specifier, context, next) { if (specifier.startsWith('@openplans/') && specifier !== '@openplans/plugin-sdk') throw new Error('synthetic_plugin_import_forbidden'); return next(specifier, context); }});`;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(hook)}`,
          cli,
          ...args,
        ],
        {
          env,
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        (JSON.parse(result.stdout) as { packages: unknown[] }).packages,
      ).toHaveLength(1);
      await untouched(f.sentinel);
    }
    await writeFile(join(f.root, "dist/extra.js"), "synthetic");
    const result = spawnSync(
      process.execPath,
      [cli, "plugin", "verify", "--json"],
      { env, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    await untouched(f.sentinel);
  });
  it.each(["api/server.js", "worker/cli.js", "mcp/stdio.js"])(
    "native %s refuses an unlisted sentinel before startup",
    async (entry) => {
      const f = await fixture();
      await writeFile(f.approvedList, "[]");
      const file = fileURLToPath(
        new URL(`../../dist/${entry}`, import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [file, ...(entry.startsWith("worker/") ? ["status"] : [])],
        {
          env: {
            PATH: process.env.PATH,
            OPENPLANS_CONFIG: f.file,
            DATABASE_URL:
              "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
            PORT: "34567",
            HOST: "127.0.0.1",
            OPENPLANS_MCP_ALLOW_PERSONALIZED: "0",
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "plugin_approval_refused",
        reason: "package_unlisted",
      });
      await untouched(f.sentinel);
    },
  );
  it("hashes file modes, hidden files and dependencies, and refuses links", async () => {
    const f = await fixture();
    const first = await packageContentDigest(f.root);
    await mkdir(join(f.root, "node_modules"));
    await writeFile(join(f.root, "node_modules/dependency.js"), "synthetic");
    expect(await packageContentDigest(f.root)).not.toBe(first);
    await symlink("index.js", join(f.root, "dist/alias.js"));
    await expect(packageContentDigest(f.root)).rejects.toThrow(
      "package_digest_link",
    );
  });
  it("matches the independently computed v1 digest vector", async () => {
    const f = await fixture();
    const root = join(f.base, "vector");
    await mkdir(root);
    await chmod(root, 0o755);
    await mkdir(join(root, "empty"));
    await chmod(join(root, "empty"), 0o700);
    await writeFile(join(root, ".hidden"), "abc");
    await chmod(join(root, ".hidden"), 0o600);
    expect(await packageContentDigest(root)).toBe(
      "5262c4b8b8ca9ced199009ee870177f37c81427e3e07330cf53e4f570568492e",
    );
  });
  it("unapproved metadata cannot ask inspection to read a secret environment variable", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "package.json"),
      JSON.stringify({
        ...f.pkg,
        openplansPlugin: {
          ...f.pkg.openplansPlugin,
          networkFromEnv: "SYNTHETIC_APPROVAL_SECRET",
        },
      }),
    );
    let secretRead = false;
    const env = new Proxy(
      { SYNTHETIC_APPROVAL_SECRET: "synthetic-private-value" },
      {
        get(target, key) {
          if (key === "SYNTHETIC_APPROVAL_SECRET") secretRead = true;
          return Reflect.get(target, key) as string | undefined;
        },
      },
    );
    await expect(
      inspectPlugin("./plugin/dist/index.js", f.base, env),
    ).rejects.toThrow();
    expect(secretRead).toBe(false);
    await untouched(f.sentinel);
  });
  it("static declarations are available without module evaluation", async () => {
    const f = await fixture();
    expect(
      (await inspectPlugin("./plugin/dist/index.js", f.base)).entry.apiVersion,
    ).toBe("0.2");
    await untouched(f.sentinel);
  });
});
