import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/index.js";
import { loadPlugins } from "../../../tests/plugins/approval-helpers.js";

const name = "@openplans/plugin-handy";
const temporary: string[] = [];
afterEach(async () => {
  await loadPlugins(loadConfig({}), "api", { env: {} });
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function load(options?: unknown, specifier = name) {
  return loadPlugins(
    loadConfig(
      {},
      {
        version: 1,
        public: { household: false },
        plugins: { entries: [{ package: specifier, options }] },
      },
    ),
    "api",
    {
      env: {},
      writeLog: () => {},
      exit: () => {
        throw new Error("loader_refused");
      },
    },
  );
}

describe("stipend options at the plugin loader", () => {
  it("loads the public proposal and omits the private scenario registration", async () => {
    const loaded = await load({ publicOnly: true });
    expect(loaded.plugins.map((plugin) => plugin.name)).toEqual([name]);
    expect(loaded.registries.routes.map(({ spec }) => spec.path)).toEqual([
      "/handy/allowance/print",
      "/handy/allowance/manifest",
      "/handy/allowance",
    ]);
    expect(loaded.registries.mcpTools.map(({ spec }) => spec.name)).toEqual([
      "get_allowance_range",
    ]);
    await loaded.teardown();
  });

  it("keeps the existing self-hosted default and rejects invalid options", async () => {
    const loaded = await load();
    expect(
      loaded.registries.routes.some(({ spec }) =>
        spec.path.endsWith("/scenario"),
      ),
    ).toBe(true);
    await loaded.teardown();
    await expect(load({ publicOnly: "true" })).rejects.toThrow(
      "loader_refused",
    );
    await expect(load({ publicOnly: true, unknown: true })).rejects.toThrow(
      "loader_refused",
    );
  });

  it("refuses a copied plugin whose manifest loses the options declaration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "allowance-loader-"));
    temporary.push(directory);
    const path = join(directory, "mutant.mjs");
    const module = import.meta.resolve(name);
    await writeFile(
      path,
      `import original from ${JSON.stringify(module)};\nconst {options, ...manifest} = original.manifest;\nexport default {...original, manifest};\n`,
    );
    await expect(load({ publicOnly: true }, path)).rejects.toThrow(
      "loader_refused",
    );
  });
});
