import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import {
  currentRegistries,
  emptyRegistries,
  loadPlugins,
  REFUSAL_CODES,
  TEARDOWN_BOUND_MS,
} from "../../src/plugins/index.js";
import type {
  LoadPluginsOptions,
  PluginHost,
  RefusalCode,
} from "../../src/plugins/index.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { writeManifest } from "../fixtures/plugins/synthetic-passthrough/harness.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const shipped = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const SECRET = "synthetic-loader-secret-value";
const env = { SYNTHETIC_ALPHA_SECRET: SECRET };
const allLines: string[] = [];
const scratch = await mkdtemp(join(tmpdir(), "openplans-loader-"));
afterAll(async () => {
  // Every captured line from every load in this file, success or refusal.
  expect(allLines.join("\n")).not.toContain(SECRET);
  await rm(scratch, { recursive: true, force: true });
});

type Entry =
  | string
  | {
      package: string;
      options?: unknown;
      optionalSecrets?: string[];
      sources?: unknown;
    };
type Loader = typeof loadPlugins;
class Exit extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}
const recorded = () =>
  ((
    globalThis as { syntheticPluginEvents?: unknown[] }
  ).syntheticPluginEvents ??= []);
beforeEach(() => {
  recorded().length = 0;
});

const specifier = (name: string) => `./synthetic-${name}/index.mjs`;
const configWith = (entries: Entry[], settings: object = {}) =>
  loadConfig(
    {},
    {
      version: 1,
      ...settings,
      plugins: entries.map((entry) =>
        typeof entry === "string"
          ? { package: specifier(entry) }
          : { ...entry, package: specifier(entry.package) },
      ),
    },
  );

async function run(
  entries: Entry[],
  host: PluginHost = "api",
  extra: LoadPluginsOptions = {},
  load: Loader = loadPlugins,
  settings: object = {},
) {
  const lines: string[] = [];
  const options: LoadPluginsOptions = {
    env,
    baseDirectory: fixtures,
    manifestPaths: [shipped],
    writeLog: (line) => {
      lines.push(line);
      allLines.push(line);
    },
    exit: (code) => {
      throw new Exit(code);
    },
    ...extra,
  };
  try {
    return {
      loaded: await load(configWith(entries, settings), host, options),
      lines,
    };
  } catch (error) {
    if (error instanceof Exit) return { exit: error.code, lines };
    throw error;
  }
}
const refusals = (lines: string[]) =>
  lines.map((line) => JSON.parse(line)).filter((entry) => "code" in entry);

async function manifestWith(
  edit: (publishers: { host: string; state: string }[]) => unknown[],
) {
  const manifest = JSON.parse(await readFile(shipped, "utf8"));
  manifest.publishers = edit(manifest.publishers);
  const path = join(scratch, `manifest-${Math.random()}.json`);
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

describe("loadPlugins with no plugins", () => {
  it("returns empty registries without logging or exiting", async () => {
    const before = currentRegistries();
    for (const host of ["api", "worker", "stdio"] as const) {
      const result = await run([], host);
      expect(result.exit).toBeUndefined();
      expect(result.lines).toEqual([]);
      expect(result.loaded!.registries).toEqual(emptyRegistries());
      expect(result.loaded!.plugins).toEqual([]);
      await result.loaded!.teardown();
    }
    expect(before).toEqual(emptyRegistries());
  });

  it("is loaded only by the worker CLI, the API server and MCP stdio, through plugins/worker and plugins/api", async () => {
    const source = (file: string) =>
      readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
    // The app and the MCP server only read the loaded registries; they never load plugins.
    for (const file of ["api/app.ts", "mcp/server.ts"])
      expect(await source(file)).not.toMatch(
        /plugins\/(?:index|loader|worker|api)\.js/,
      );
    // The two entry points load through plugins/api only, never the loader itself.
    for (const file of ["api/server.ts", "mcp/stdio.ts"]) {
      const entry = await source(file);
      expect(entry).toMatch(/from "\.\.\/plugins\/api\.js"/);
      expect(entry).toMatch(/await loadApiPlugins\(/);
      expect(entry).not.toMatch(/plugins\/(?:index|loader|worker)\.js/);
    }
    expect(await source("mcp/stdio.ts")).toMatch(
      /loadApiPlugins\(\{ host: "stdio" \}\)/,
    );
    // plugins/api reaches the loader only through a dynamic import.
    const api = await source("plugins/api.ts");
    expect(api).not.toMatch(/from "\.\/(?:index|loader)\.js"/);
    expect(api).toMatch(/await import\("\.\/loader\.js"\)/);
    const cli = await source("worker/cli.ts");
    expect(cli).toMatch(/from "\.\.\/plugins\/worker\.js"/);
    expect(cli).not.toMatch(/plugins\/(?:index|loader)\.js/);
    // plugins/worker reaches the loader only through a dynamic import.
    const worker = await source("plugins/worker.ts");
    expect(worker).not.toMatch(/from "\.\/(?:index|loader)\.js"/);
    expect(worker).toMatch(/await import\("\.\/loader\.js"\)/);
  });

  it("has no import cycle between the loader and the MCP tool module", async () => {
    const source = (file: string) =>
      readFile(new URL(`../../src/plugins/${file}`, import.meta.url), "utf8");
    expect(await source("mcp-tools.ts")).not.toMatch(
      /\.\/(?:index|loader)\.js/,
    );
    expect(await source("loader.ts")).toMatch(/from "\.\/mcp-tools\.js"/);
    // Both read the active registries from registries.ts, which imports neither.
    expect(await source("registries.ts")).not.toMatch(
      /\.\/(?:index|loader|mcp-tools)\.js/,
    );
  });
});

const cases: {
  code: RefusalCode;
  entries: Entry[];
  plugin: string;
  reason?: string;
  options?: () => Promise<LoadPluginsOptions>;
  settings?: object;
}[] = [
  {
    code: "plugin_import_failed",
    entries: ["import-failed"],
    plugin: specifier("import-failed"),
  },
  {
    code: "plugin_export_invalid",
    entries: ["export-invalid"],
    plugin: specifier("export-invalid"),
  },
  {
    code: "plugin_api_version_mismatch",
    entries: ["api-version"],
    plugin: "@synthetic/api-version",
  },
  {
    code: "plugin_name_duplicate",
    entries: ["alpha", "duplicate"],
    plugin: "@synthetic/alpha",
  },
  {
    code: "plugin_table_prefix_duplicate",
    entries: ["migrations", "table-prefix-duplicate"],
    plugin: "@synthetic/table-prefix-duplicate",
  },
  {
    code: "plugin_secret_missing",
    entries: ["secret-missing"],
    plugin: "@synthetic/secret-missing",
  },
  {
    code: "plugin_network_host_not_allowed",
    entries: ["network"],
    plugin: "@synthetic/network",
    reason: "unknown",
    options: async () => ({
      manifestPaths: [
        await manifestWith((all) =>
          all.filter((entry) => entry.host !== "download.cms.gov"),
        ),
      ],
    }),
  },
  {
    code: "plugin_options_invalid",
    entries: [{ package: "alpha", options: { label: 5, extra: SECRET } }],
    plugin: "@synthetic/alpha",
  },
  {
    code: "plugin_kind_undeclared",
    entries: ["kind-undeclared"],
    plugin: "@synthetic/kind-undeclared",
  },
  {
    code: "plugin_registration_invalid",
    entries: ["registration-invalid"],
    plugin: "@synthetic/registration-invalid",
  },
  {
    code: "plugin_route_collision",
    entries: ["alpha", "route-collision"],
    plugin: "@synthetic/route-collision",
  },
  {
    code: "plugin_mcp_tool_collision",
    entries: ["tool-collision"],
    plugin: "@synthetic/tool-collision",
  },
  {
    code: "plugin_registration_collision",
    entries: ["alpha", "registration-collision"],
    plugin: "@synthetic/registration-collision",
  },
  {
    code: "mcp_tool_page_overflow",
    entries: ["tool-overflow"],
    plugin: "@synthetic/tool-overflow",
  },
  {
    code: "plugin_provider_collision",
    entries: ["provider-collision"],
    plugin: "@synthetic/provider-collision",
  },
  {
    code: "plugin_provider_unknown",
    entries: ["alpha"],
    plugin: "@openplans/core",
    reason: "cache.provider",
    settings: { cache: { provider: "synthetic-absent" } },
  },
  {
    code: "plugin_setup_failed",
    entries: ["alpha", "setup-failed"],
    plugin: "@synthetic/setup-failed",
  },
  {
    code: "passthrough_level_loosened",
    entries: [
      {
        package: "passthrough",
        options: { level: "none" },
        sources: { "synthetic-none": { cacheLevel: "memory" } },
      },
    ],
    plugin: "@synthetic/passthrough",
    reason: "synthetic-none",
    options: async () => ({ manifestPaths: [await writeManifest(scratch)] }),
  },
];

describe("refusals", () => {
  it("has one case for every refusal code", () => {
    expect(cases.map((entry) => entry.code).sort()).toEqual(
      [...REFUSAL_CODES].sort(),
    );
  });

  for (const entry of cases)
    it(`refuses with ${entry.code}`, async () => {
      const before = currentRegistries();
      const result = await run(
        entry.entries,
        "api",
        (await entry.options?.()) ?? {},
        loadPlugins,
        entry.settings,
      );
      expect(result.exit).toBe(1);
      expect(refusals(result.lines)).toEqual([
        {
          plugin: entry.plugin,
          code: entry.code,
          ...(entry.reason ? { reason: entry.reason } : {}),
        },
      ]);
      expect(result.lines.join("\n")).not.toContain(SECRET);
      expect(currentRegistries()).toBe(before);
    });

  it("refuses the same configuration on every host", async () => {
    for (const host of ["worker", "stdio"] as const) {
      const routes = await run(["alpha", "route-collision"], host);
      expect(refusals(routes.lines)).toEqual([
        {
          plugin: "@synthetic/route-collision",
          code: "plugin_route_collision",
        },
      ]);
      const tools = await run(["tool-overflow"], host);
      expect(refusals(tools.lines)[0].code).toBe("mcp_tool_page_overflow");
    }
  });

  it("refuses a core route path and a missing module", async () => {
    expect(refusals((await run(["core-route"])).lines)).toEqual([
      { plugin: "@synthetic/core-route", code: "plugin_route_collision" },
    ]);
    expect(refusals((await run(["absent"])).lines)).toEqual([
      { plugin: specifier("absent"), code: "plugin_import_failed" },
    ]);
  });

  it("runs every check before any setup", async () => {
    const result = await run(["alpha", "secret-missing"]);
    expect(result.exit).toBe(1);
    expect(recorded()).toEqual([]);
  });

  it("accepts a missing secret the configuration marks optional", async () => {
    const result = await run([
      {
        package: "secret-missing",
        optionalSecrets: ["SYNTHETIC_MISSING_SECRET"],
      },
    ]);
    expect(result.exit).toBeUndefined();
  });

  it("only exposes declared secrets", async () => {
    const result = await run(["alpha"], "api", {
      env: { SYNTHETIC_ALPHA_SECRET: SECRET },
    });
    expect(recorded()).toContainEqual({ setup: "alpha", secretSeen: true });
    await result.loaded!.teardown();
  });

  it("checks network hosts against the loaded manifests", async () => {
    const allowed = await run(["network"]);
    expect(allowed.exit).toBeUndefined();
    const held = await manifestWith((all) =>
      all.map((entry) =>
        entry.host === "download.cms.gov"
          ? { ...entry, state: "terms-restricted" }
          : entry,
      ),
    );
    const reasons = [
      [{ manifestPaths: [held] }, "terms-restricted"],
      [{ now: () => Date.parse("2030-01-01T00:00:00Z") }, "terms_expired"],
      [
        { manifestPaths: [join(scratch, "absent.json")] },
        "manifest_unreadable",
      ],
    ] as const;
    for (const [options, reason] of reasons)
      expect(refusals((await run(["network"], "api", options)).lines)).toEqual([
        {
          plugin: "@synthetic/network",
          code: "plugin_network_host_not_allowed",
          reason,
        },
      ]);
  });
});

describe("registries", () => {
  const routePaths = (result: Awaited<ReturnType<typeof run>>) =>
    result.loaded!.registries.routes.map(({ spec }) => spec.path);

  it("keep configuration order across restarts, as given", async () => {
    const first = await run(["alpha", "beta"]);
    const second = await run(["alpha", "beta"]);
    const shuffled = await run(["beta", "alpha"]);
    expect(routePaths(first)).toEqual(["/alpha", "/beta"]);
    expect(routePaths(second)).toEqual(routePaths(first));
    expect(routePaths(shuffled)).toEqual(["/beta", "/alpha"]);
    expect(shuffled.loaded!.plugins.map(({ name }) => name)).toEqual([
      "@synthetic/beta",
      "@synthetic/alpha",
    ]);
    expect(Object.keys(first.loaded!.registries.cacheStores)).toEqual([
      "synthetic-alpha",
    ]);
    expect(Object.isFrozen(first.loaded!.registries.routes)).toBe(true);
    expect(currentRegistries()).toBe(shuffled.loaded!.registries);
  });

  it("hold only the kinds each host serves", async () => {
    const worker = await run(["alpha", "beta"], "worker");
    expect(worker.loaded!.registries.routes).toEqual([]);
    expect(
      worker.loaded!.registries.workerCommands.map(({ spec }) => spec.argv),
    ).toEqual([["synthetic", "alpha"]]);
    expect(
      worker.loaded!.registries.schedules.map(({ plugin }) => plugin),
    ).toEqual(["@synthetic/beta"]);
    const stdio = await run(["alpha", "beta"], "stdio");
    expect(stdio.loaded!.registries.routes).toEqual([]);
    expect(stdio.loaded!.registries.workerCommands).toEqual([]);
    expect(stdio.loaded!.registries.events).toEqual([]);
  });

  it("log plugin lines with the plugin name", async () => {
    const result = await run(["alpha"]);
    expect(result.lines.map((line) => JSON.parse(line))).toEqual([
      { event: "ready", plugin: "@synthetic/alpha" },
    ]);
  });
});

/** True when plugin 1's registrations became visible although plugin 2 failed. */
async function partialFailureLeaks(module: {
  loadPlugins: Loader;
  currentRegistries: typeof currentRegistries;
}) {
  const ready = await run(["beta"], "api", {}, module.loadPlugins);
  expect(ready.exit).toBeUndefined();
  const failed = await run(
    ["alpha", "setup-failed"],
    "api",
    {},
    module.loadPlugins,
  );
  expect(failed.exit).toBe(1);
  const visible = module
    .currentRegistries()
    .routes.map(({ spec }) => spec.path);
  return visible.includes("/alpha") || !visible.includes("/beta");
}

describe("partial failure", () => {
  it("leaves the previous registries in place", async () => {
    expect(await partialFailureLeaks({ loadPlugins, currentRegistries })).toBe(
      false,
    );
    expect(recorded()).toContainEqual({ teardown: "alpha" });
  });

  it("is caught when the staging swap is removed (planted mutant)", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/loader.ts", import.meta.url),
      "const staging = emptyRegistries();",
      "const staging = emptyRegistries(); activateRegistries(staging);",
    );
    try {
      const module = await import(mutant.path);
      expect(await partialFailureLeaks(module)).toBe(true);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("teardown", () => {
  it("runs in reverse order, each bounded", async () => {
    expect(TEARDOWN_BOUND_MS).toBe(5_000);
    const result = await run(["alpha", "beta"]);
    await result.loaded!.teardown();
    await result.loaded!.teardown();
    expect(recorded().filter((entry) => "teardown" in Object(entry))).toEqual([
      { teardown: "beta" },
      { teardown: "alpha" },
    ]);
    const slow = await run(["teardown-slow", "alpha"], "api", {
      teardownBoundMs: 20,
    });
    await slow.loaded!.teardown();
    expect(refusals(slow.lines)).toEqual([
      { plugin: "@synthetic/teardown-slow", code: "plugin_teardown_timeout" },
    ]);
  });
});
