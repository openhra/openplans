import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_MANIFEST } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { packPlugin } from "../../src/plugins/package/pack.js";
import { withVerifiedPackage } from "../../src/plugins/package/verify.js";
import { installPlugin } from "../../src/plugins/package/install.js";
import { inventory } from "../../src/plugins/package/files.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import type * as ArchiveModule from "../../src/plugins/package/archive.js";
import { changeJson, syntheticPlugin } from "./package-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "openplans-package-output-"));
  scratch.push(root);
  return root;
}

describe("deterministic plugin pack", () => {
  it("packs identical bytes after mtime and mode changes, then verifies and installs the archive", async () => {
    const { root } = await syntheticPlugin();
    scratch.push(root);
    const output = await temporary();
    await mkdir(join(root, "assets/empty"), { recursive: true });
    const a = await packPlugin(root, join(output, "a"));
    await utimes(join(root, "dist/index.js"), 123456789, 123456789);
    await chmod(join(root, "dist/index.js"), 0o755);
    const b = await packPlugin(root, join(output, "b"));
    expect(await readFile(a.output)).toEqual(await readFile(b.output));
    const bytes = await readFile(a.output);
    expect(bytes.readUInt32LE(4)).toBe(0);
    const tar = gunzipSync(bytes);
    const paths: string[] = [];
    for (let offset = 0; tar[offset] !== 0;) {
      const header = tar.subarray(offset, offset + 512);
      paths.push(
        header.subarray(0, 100).toString("ascii").replace(/\0.*$/, ""),
      );
      expect(
        Number.parseInt(header.subarray(100, 108).toString("ascii"), 8),
      ).toBe(0o644);
      expect(
        Number.parseInt(header.subarray(108, 116).toString("ascii"), 8),
      ).toBe(0);
      expect(
        Number.parseInt(header.subarray(116, 124).toString("ascii"), 8),
      ).toBe(0);
      expect(
        Number.parseInt(header.subarray(136, 148).toString("ascii"), 8),
      ).toBe(0);
      const size = Number.parseInt(
        header.subarray(124, 136).toString("ascii"),
        8,
      );
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(paths).toEqual([...paths].sort());
    expect(a.artifactSha256).toBe(b.artifactSha256);
    expect(a.legacySha256).toBe(b.legacySha256);
    expect(a.digest).toBe(b.digest);
    await withVerifiedPackage(a.output, async (_root, verified) => {
      expect(verified.legacySha256).toBe(a.legacySha256);
    });
    const installed = await installPlugin(a.output, join(output, "plugins"));
    expect(installed.legacySha256).toBe(a.legacySha256);
    expect(installed.digest).toBe(a.digest);
    await expect(packPlugin(root, join(output, "a"))).rejects.toThrow(
      /already exists/,
    );
  }, 120_000);
  it("packs the built template with a valid generated file inventory", async () => {
    const root = fileURLToPath(
      new URL("../../plugins/template", import.meta.url),
    );
    const output = await packPlugin(root, await temporary());
    await withVerifiedPackage(output.output, async (_directory, verified) => {
      expect(verified.manifest.name).toBe("@openplans/plugin-template");
      expect(
        verified.manifest.files?.some((file) => file.path === "dist/index.js"),
      ).toBe(true);
    });
    const installed = await installPlugin(
      output.output,
      join(await temporary(), "plugins"),
    );
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const module = await import(process.argv[1]); console.log(module.default.manifest.name);",
        pathToFileURL(join(installed.directory, "dist/index.js")).href,
      ],
      { encoding: "utf8" },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout.trim()).toBe("@openplans/plugin-template");
  }, 120_000);
  it.each(["capabilities", "kinds", "version", "apiVersion"])(
    "refuses a manifest/module %s mismatch",
    async (field) => {
      const { root } = await syntheticPlugin();
      scratch.push(root);
      await changeJson(join(root, PACKAGE_MANIFEST), (manifest) => {
        if (field === "capabilities")
          manifest.capabilities = { writes: ["staging"] };
        if (field === "kinds") manifest.kinds = ["events"];
        if (field === "version") manifest.version = "2.0.0";
        if (field === "apiVersion") manifest.apiVersion = "999.0";
      });
      await expect(packPlugin(root, await temporary())).rejects.toThrow();
    },
  );
  it("refuses .env, native addons, dependencies and lifecycle scripts in author input", async () => {
    const { root } = await syntheticPlugin();
    scratch.push(root);
    const output = await temporary();
    await writeFile(join(root, ".env"), "SYNTHETIC_FIXTURE=true");
    await expect(packPlugin(root, output)).rejects.toThrow(/Environment/);
    await rm(join(root, ".env"));
    await writeFile(join(root, "dist/addon.node"), "synthetic native payload");
    await expect(packPlugin(root, output)).rejects.toThrow();
    await rm(join(root, "dist/addon.node"));
    await changeJson(join(root, "package.json"), (pkg) => {
      pkg.dependencies = {};
    });
    await expect(packPlugin(root, output)).rejects.toThrow(/dependencies/);
    await changeJson(join(root, "package.json"), (pkg) => {
      delete pkg.dependencies;
      pkg.scripts = { postinstall: "synthetic" };
    });
    await expect(packPlugin(root, output)).rejects.toThrow(/scripts/);
  });
  it("the byte-equality check fails a planted real-mtime archive writer", async () => {
    const source = new URL(
      "../../src/plugins/package/archive.ts",
      import.meta.url,
    );
    const original = await readFile(source, "utf8");
    const changed = original
      .replace(
        "putNumber(header, 136, 12, 0);",
        "putNumber(header, 136, 12, Math.floor(mtime / 1000));",
      )
      .replace(
        "function tarHeader(path: string, size: number): Buffer",
        "function tarHeader(path: string, size: number, mtime: number): Buffer",
      )
      .replace(
        "yield tarHeader(file.path, file.bytes);",
        "yield tarHeader(file.path, file.bytes, (await stat(join(root, file.path))).mtimeMs);",
      );
    const mutant = await plantMutant(source, original, changed);
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as typeof ArchiveModule;
    try {
      const root = await temporary();
      await mkdir(join(root, "dist"));
      await writeFile(
        join(root, "dist/index.js"),
        "// synthetic mtime fixture\n",
      );
      const files = await inventory(root, 1000);
      const a = join(root, "a.tgz"),
        b = join(root, "b.tgz");
      await utimes(join(root, "dist/index.js"), 100000000, 100000000);
      await module.writeArchive(root, files, a);
      await utimes(join(root, "dist/index.js"), 200000000, 200000000);
      await module.writeArchive(root, files, b);
      const readBytesA = await readFile(a),
        readBytesB = await readFile(b);
      expect(() => expect(readBytesA).toEqual(readBytesB)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
  it("worker package commands bypass configured plugin loading", async () => {
    const { root } = await syntheticPlugin();
    scratch.push(root);
    const packed = await packPlugin(root, await temporary());
    const cli = fileURLToPath(
      new URL("../../dist/worker/cli.js", import.meta.url),
    );
    const run = spawnSync(
      process.execPath,
      [cli, "plugin", "verify", "--local", packed.output],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENPLANS_PLUGINS: "@synthetic/must-never-import",
          OPENPLANS_CONFIG: "/synthetic/missing-config.json",
        },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('"approval":"not_granted"');
    const destination = join(await temporary(), "unpacked");
    await cp(root, destination, { recursive: true });
    await expect(
      lstat(join(destination, "package.json")),
    ).resolves.toBeDefined();
  }, 120_000);
});
