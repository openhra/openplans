import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCurrency,
  staleBacklogItems,
} from "../scripts/check-currency.mjs";

const script = fileURLToPath(
  new URL("../scripts/check-currency.mjs", import.meta.url),
);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const defaults = {
  usageReport: { enabled: false },
  rxnavIdentity: false,
  cmsFallback: { enabled: false, quotes: false },
};
const today = "2026-11-22";
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

// Synthetic fixture: a repo with an app folder, a website pin and an ops backlog.
const files = {
  "app/package.json": JSON.stringify({ name: "synthetic", version: "1.2.3" }),
  "app/README.md": [
    "# Synthetic",
    "",
    "The optional CMS Marketplace API fallback is off by",
    "default. `OPENPLANS_CMS_FALLBACK_QUOTES=on` extends that to quotes.",
    "Downloads use public sources and need no CMS API key.",
    "Install OpenPlans 1.2.3 from releases/tag/v1.2.3.",
    "",
  ].join("\n"),
  "app/docs/plugins.md": [
    "The plugin API is experimental. Its version is `0.2`, and the loader refuses others.",
    'A manifest declares `apiVersion: "0.2"`. API 0.2 uses a plugins object.',
    "",
  ].join("\n"),
  "app/docs/configuration.md": [
    "`OPENPLANS_USAGE_REPORT` maps to `usageReport.enabled`. It defaults to `false`.",
    "",
    "| Variable | Default |",
    "| --- | --- |",
    "| `OPENPLANS_RXNAV_IDENTITY` | Off. `on` checks. |",
    "| `CMS_API_KEY` | Unset. Enables lookups. No key is needed for bulk imports. |",
    "",
    "A comparator-only installation adds one tool to the default 2, for 3. With the status",
    "plugin it lists 4.",
    "",
    "With default access, the server lists these 2 tools:",
    "",
    "| Tool | What |",
    "| --- | --- |",
    "| `search` | Search. |",
    "| `fetch` | Fetch. |",
    "",
    "The status plugin adds `get_status`, so a server that loads it lists 3.",
    "",
  ].join("\n"),
  "app/docs/usage-report.md":
    "The usage report is an optional, anonymous summary. It is off by\ndefault.\n",
  "app/docs/self-host.md":
    "The server registers 2 tools. The status plugin adds `get_status`, which makes 3.\n",
  "app/docs/public-contract.json": JSON.stringify({
    mcp: { anonymous_tools: ["fetch", "get_status", "search"] },
  }),
  "app/docs/mcp-tools.json": JSON.stringify({
    tools: [
      { name: "search", kind: "core" },
      { name: "fetch", kind: "core" },
      { name: "get_status", kind: "plugin" },
      { name: "get_benchmark", kind: "switched" },
    ],
  }),
  "app/plugins/sdk/src/index.ts":
    'export const PLUGIN_API_VERSION = "0.2" as const;\n',
  "website/tools/mcp-tools-pin.json": JSON.stringify({ release: "v1.2.3" }),
  "website/plans/data/mcp-tools.json": JSON.stringify({ tools: [] }),
  "ops/BACKLOG.md": [
    "# Backlog",
    "",
    "1. **Fresh item.** Checked on 2026-11-20.",
    "2. **Old item.** Last looked at on 2026-08-01,",
    "   and before that on 2026-07-01.",
    "3. **Undated item.** No date.",
    "",
  ].join("\n"),
};

async function fixture(changes = {}) {
  const root = await mkdtemp(join(tmpdir(), "openplans-currency-"));
  roots.push(root);
  for (const [file, text] of Object.entries({ ...files, ...changes })) {
    if (text === null) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

async function check(changes, configDefaults = defaults) {
  const root = await fixture(changes);
  return checkCurrency({
    appRoot: join(root, "app"),
    repoRoot: root,
    configDefaults,
    today,
  });
}

const edit = (file, from, to) => {
  expect(files[file]).toContain(from);
  return { [file]: files[file].replace(from, to) };
};

describe("check-currency", () => {
  it("passes the synthetic fixture and warns about the old backlog item", async () => {
    const result = await check();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'ops/BACKLOG.md: item 2 "Old item." newest date 2026-08-01 is 113 days old',
    ]);
  });

  it("flags a planted identity literal with path and line, and passes the package version source", async () => {
    // Built at run time so this test file holds no literal of its own.
    const literal = ["openplans", "0.4.20"].join("/");
    const result = await check({
      "app/src/fetch/planted.ts": `const a = 1;\nconst ua = \`${literal} (x)\`;\n`,
      "app/tests/ok.ts": "const ua = `openplans/${version} (x)`;\n",
    });
    expect(result.errors).toEqual([
      `src/fetch/planted.ts:2: version literal "${literal}"; build the identity from package.json (src/fetch/user-agent.ts)`,
    ]);
  });

  it("flags a planted regex-escaped identity literal with path and line", async () => {
    // Built at run time so this test file holds no literal of its own.
    const escaped = ["openplans", String.raw`0\.4\.20`].join("\\/");
    const result = await check({
      "app/tests/ingest/planted.test.ts": `const a = 1;\nexpect(ua).toMatch(/^${escaped} /);\n`,
      "app/tests/ok.test.ts":
        "expect(ua).toMatch(new RegExp(`^openplans/${version} `));\n",
    });
    expect(result.errors).toEqual([
      `tests/ingest/planted.test.ts:2: version literal "${escaped}"; build the identity from package.json (src/fetch/user-agent.ts)`,
    ]);
  });

  it("fails a planted old version string", async () => {
    const { errors } = await check(
      edit("app/README.md", "OpenPlans 1.2.3", "OpenPlans 1.2.2"),
    );
    expect(errors).toEqual([
      'README.md:6: version 1.2.2 in "OpenPlans 1.2.2" is not 1.2.3',
    ]);
  });

  it.each([
    ["openplans:1.1.0 image", "openplans:1.1.0"],
    ["openplans@v1.1.0 package", "openplans@v1.1.0"],
    ["releases/download/v1.1.0/x", "releases/download/v1.1.0"],
    ["The current release is v1.1.0.", "current release is v1.1.0"],
  ])("fails an old version in %s", async (text, match) => {
    const { errors } = await check({
      "app/docs/extra.md": `See ${text}\n`,
    });
    expect(errors).toEqual([
      `docs/extra.md:1: version 1.1.0 in "${match}" is not 1.2.3`,
    ]);
  });

  it("leaves historical release mentions alone", async () => {
    const { errors } = await check({
      "app/docs/extra.md": "Expand release: v0.9.0 added the table.\n",
    });
    expect(errors).toEqual([]);
  });

  it("accepts the pinned release named in self-host.md", async () => {
    const pinned = "Operators run the pinned release `v1.2.2`.\n";
    const { errors } = await check({
      ...edit("app/README.md", "OpenPlans 1.2.3", "OpenPlans 1.2.2"),
      "app/docs/self-host.md": files["app/docs/self-host.md"] + pinned,
    });
    expect(errors).toEqual([]);
  });

  it("fails a website pin for another release", async () => {
    const { errors } = await check({
      "website/tools/mcp-tools-pin.json": JSON.stringify({
        release: "v1.2.2",
      }),
    });
    expect(errors).toEqual([
      "website/tools/mcp-tools-pin.json: release v1.2.2 is not v1.2.3",
    ]);
  });

  it("skips the website and backlog when they are absent", async () => {
    const result = await check({
      "website/tools/mcp-tools-pin.json": null,
      "website/plans/data/mcp-tools.json": null,
      "ops/BACKLOG.md": null,
    });
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([
      "website/ absent: website pin not checked",
      "ops/BACKLOG.md absent: backlog dates not checked",
    ]);
  });

  it("checks the README claims in docs/usage.md in an exported tree", async () => {
    // The export moves README.md to docs/usage.md and writes a scaffold README.md and a manifest.
    const exported = {
      "app/docs/usage.md": files["app/README.md"],
      "app/README.md": "# Scaffold\n\nSee docs/usage.md.\n",
      "app/release-manifest.json": "{}\n",
    };
    expect((await check(exported)).errors).toEqual([]);
    const { errors } = await check({
      ...exported,
      "app/docs/usage.md": files["app/README.md"].replace(
        "need no CMS API key",
        "need a key",
      ),
    });
    expect(errors).toEqual([
      expect.stringMatching(/^docs\/usage\.md: claim .*need no CMS API key/),
    ]);
    const missing = await check({ ...exported, "app/docs/usage.md": null });
    expect(missing.errors).toHaveLength(3);
    expect(missing.errors[0]).toMatch(/docs\/usage\.md does not exist/);
  });

  it("fails a plugin API version other than the SDK constant", async () => {
    const { errors } = await check(
      edit(
        "app/docs/plugins.md",
        "Its version is `0.2`",
        "Its version is `0.1`",
      ),
    );
    expect(errors).toEqual([
      'docs/plugins.md:1: plugin API 0.1 in "The plugin API is experimental. Its version is `0.1`" is not the SDK\'s 0.2',
    ]);
  });

  it("fails when the plugin API sentence is gone", async () => {
    const { errors } = await check(
      edit(
        "app/docs/plugins.md",
        "Its version is `0.2`, and",
        "It is new, and",
      ),
    );
    expect(errors).toEqual([
      "docs/plugins.md: the sentence stating the plugin API version is missing",
    ]);
  });

  it("fails a claim whose config default changed", async () => {
    const { errors } = await check(
      {},
      { ...defaults, usageReport: { enabled: true } },
    );
    expect(errors).toEqual([
      "docs/usage-report.md: claims usageReport.enabled defaults to false, but it is true",
      "docs/configuration.md: claims usageReport.enabled defaults to false, but it is true",
    ]);
  });

  it("fails a no-key claim once a key has a default", async () => {
    const { errors } = await check(
      {},
      { ...defaults, cmsFallback: { ...defaults.cmsFallback, apiKey: "x" } },
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(
      "README.md: claims cmsFallback.apiKey defaults to undefined, but it is x",
    );
  });

  it("fails a reworded claim", async () => {
    const { errors } = await check(
      edit("app/docs/configuration.md", "| Off. `on` checks.", "| On."),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/OPENPLANS_RXNAV_IDENTITY.*not found/);
  });

  it("fails a planted wrong tool count", async () => {
    const { errors } = await check(
      edit("app/docs/self-host.md", "registers 2 tools", "registers 5 tools"),
    );
    expect(errors).toEqual([
      'docs/self-host.md:1: "registers 5 tools" says 5, the contract gives 2',
    ]);
  });

  it("fails a wrong count with plugins", async () => {
    const { errors } = await check(
      edit("app/docs/configuration.md", "it lists 4", "it lists 5"),
    );
    expect(errors).toEqual([
      'docs/configuration.md:8: "With the status plugin it lists 5" says 5, the contract gives 4',
    ]);
  });

  it("fails a planted wrong anonymous tool count in the README", async () => {
    const { errors } = await check({
      "app/README.md":
        files["app/README.md"] +
        "Anonymous callers see the 2 core tools plus `get_status` from the status plugin, 2 in all.\n",
    });
    expect(errors).toEqual([
      'README.md:7: "from the status plugin, 2 in all" says 2, the contract gives 3',
    ]);
  });

  it("fails a tool count no rule covers", async () => {
    const { errors } = await check({
      "app/docs/extra.md": "Clients see 7 public tools.\n",
    });
    expect(errors).toEqual([
      'docs/extra.md:1: tool count "7 public tools" has no rule in scripts/check-currency.mjs',
    ]);
  });

  it("fails a default tool table with a missing row", async () => {
    const { errors } = await check(
      edit("app/docs/configuration.md", "| `fetch` | Fetch. |\n", ""),
    );
    expect(errors).toEqual([
      "docs/configuration.md: the default tool table has 1 rows, the contract gives 2",
    ]);
  });

  it("dates backlog items by their newest date", () => {
    const text =
      "1. **A.** 2026-01-01 then 2026-11-01.\n2. **B.** 2026-01-01.\n";
    expect(staleBacklogItems(text, "2026-11-22")).toEqual([
      { item: 2, title: "B.", newest: "2026-01-01", age: 325 },
    ]);
  });

  it("exits 1 from the command line on a planted old version", async () => {
    const root = await fixture(
      edit("app/docs/plugins.md", "API 0.2 uses", "OpenPlans 1.0.0 uses"),
    );
    const defaultsFile = join(root, "defaults.json");
    await writeFile(defaultsFile, JSON.stringify(defaults));
    const run = spawnSync(
      process.execPath,
      [script, join(root, "app"), "--defaults", defaultsFile, "--today", today],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'docs/plugins.md:2: version 1.0.0 in "OpenPlans 1.0.0" is not 1.2.3',
    );
    expect(run.stderr).toContain("currency: FAIL");
  });

  it("is called from ci.sh next to the neutrality check", async () => {
    const ci = await readFile(join(appRoot, "scripts/ci.sh"), "utf8");
    expect(ci).toMatch(
      /step node scripts\/check-neutral\.mjs\n\s+step node scripts\/check-currency\.mjs\n/,
    );
  });

  // ci.sh builds before its checks and runs this script on the real docs; this repeats it
  // under the test runner when a build is present.
  it.runIf(existsSync(join(appRoot, "dist/config/index.js")))(
    "passes on this repository",
    () => {
      const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(run.stderr).not.toContain("FAIL");
      expect(run.status).toBe(0);
    },
  );
});
