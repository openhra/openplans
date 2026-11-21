import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const plugins = join(root, "plugins");
const directories = (await readdir(plugins, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const scratch = await mkdtemp(join(tmpdir(), "openplans-runtime-versions-"));
const runtimePlugins = join(scratch, "plugins");

// Native Node imports the compiled entry, without Vitest's source resolution or JSON transforms.
const check = `
  import assert from "node:assert/strict";
  import { readFile } from "node:fs/promises";
  import { pathToFileURL } from "node:url";
  const root = pathToFileURL(process.argv[1] + "/");
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const loaded = await import(new URL(pkg.main, root));
  if (pkg.name === "@openplans/plugin-sdk") {
    assert.equal(loaded.default, undefined, "The SDK is not a runtime plugin");
    assert.equal(typeof loaded.pluginManifestSchema.parse, "function");
  } else {
    const assertVersion = (plugin) => {
      assert.equal(typeof plugin.setup, "function");
      assert.equal(plugin.manifest.name, pkg.name);
      assert.equal(plugin.manifest.version, pkg.version, pkg.name + " runtime version differs from package.json");
      const declared = pkg.openplansPlugin;
      assert.equal(plugin.manifest.apiVersion, declared.apiVersion);
      assert.deepEqual(plugin.manifest.kinds, declared.kinds);
      let capabilities = declared.capabilities ?? {};
      if (declared.networkFromEnv) {
        assert.equal(declared.networkFromEnv, "OPENPLANS_WEBHOOK_HOST");
        const host = process.env[declared.networkFromEnv]?.trim().toLowerCase();
        capabilities = {...capabilities, network: host && /^[a-z0-9.-]{1,253}$/.test(host) ? [host] : []};
      }
      assert.deepEqual(plugin.manifest.capabilities ?? {}, capabilities);
    };
    assertVersion(loaded.default);
    if (loaded.createPlugin) assertVersion(await loaded.createPlugin({ host: {} }));
  }
`;

function checkPackage(directory: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", check, directory],
    { encoding: "utf8", timeout: 10_000 },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

beforeAll(async () => {
  const modules = join(scratch, "node_modules");
  await mkdir(join(modules, "@openplans"), { recursive: true });
  for (const name of ["zod", "hono"])
    await symlink(join(root, "node_modules", name), join(modules, name));
  for (const directory of directories) {
    const source = join(plugins, directory);
    const target = join(runtimePlugins, directory);
    // The Docker runtime stage ships these files, without src/ or tsconfig.json.
    for (const name of ["dist", "package.json"])
      await cp(join(source, name), join(target, name), { recursive: true });
    const pkg = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    ) as { name: string };
    await symlink(target, join(modules, pkg.name));
  }
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe.each([
  ["built workspace", plugins],
  ["Docker runtime files", runtimePlugins],
])("bundled plugin versions in %s", (_label, directory) => {
  it.each(directories)("%s matches its package.json", (name) => {
    const result = checkPackage(join(directory, name));
    expect(result.status, result.output).toBe(0);
  });
});

it("a copied template takes its version from its own package.json", async () => {
  const target = join(runtimePlugins, "renamed-template");
  await cp(join(runtimePlugins, "template"), target, { recursive: true });
  const path = join(target, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    version: string;
  };
  pkg.version = "999.0.0-synthetic";
  await writeFile(path, JSON.stringify(pkg));
  const result = checkPackage(target);
  expect(result.status, result.output).toBe(0);
});

it("rejects a planted runtime manifest version mismatch", async () => {
  const target = join(runtimePlugins, "mutant-template");
  await cp(join(runtimePlugins, "template"), target, { recursive: true });
  const path = join(target, "dist/index.js");
  const source = await readFile(path, "utf8");
  const needle = "version: packageJson.version";
  expect(source.split(needle)).toHaveLength(2);
  await writeFile(path, source.replace(needle, 'version: "0.0.0-synthetic"'));
  const result = checkPackage(target);
  expect(result.status).toBe(1);
  expect(result.output).toContain("runtime version differs from package.json");
  expect(result.output).toContain("0.0.0-synthetic");
});
