import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import type * as manifestModule from "../../src/mcp/manifest.js";
import {
  buildMcpToolManifest,
  firstPartyPlugins,
  MANIFEST_PATH,
  manifestProblems,
  manifestText,
} from "../../src/mcp/manifest.js";
import { toolNames } from "../../src/mcp/schemas.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceEntry = (folder: string) =>
  new URL(`../../plugins/${folder}/src/index.ts`, import.meta.url).href;
const committed = () =>
  readFile(new URL(MANIFEST_PATH, `file://${root}`), "utf8");
const current = async () =>
  buildMcpToolManifest(await firstPartyPlugins(root, sourceEntry));

describe("MCP tool manifest", () => {
  it("docs/mcp-tools.json matches the registry; run npm run mcp:manifest when this fails", async () => {
    expect(manifestProblems(await committed(), await current())).toEqual([]);
  });

  it("lists core tools and the first-party plugin tools", async () => {
    const manifest = await current();
    const always = manifest.tools.filter((tool) => tool.listed === "always");
    expect(always.map((tool) => tool.name)).toEqual(toolNames);
    expect(always.every((tool) => tool.kind === "core")).toBe(true);
    expect(
      manifest.tools
        .filter((tool) => tool.listed !== "always")
        .map((tool) => [tool.name, tool.kind, tool.listed, tool.plugin]),
    ).toEqual([
      ["estimate_medicare_drug_costs", "core", "switched", undefined],
      ["get_lowest_premiums", "core", "switched", undefined],
      ["get_market_summary", "core", "switched", undefined],
      ["get_benchmark", "core", "switched", undefined],
      ["compare_market_costs", "plugin", "plugin", "@openplans/plugin-compare"],
      ["get_allowance_range", "plugin", "plugin", "@openplans/plugin-handy"],
      ["get_status", "plugin", "plugin", "@openplans/plugin-status"],
    ]);
    for (const tool of manifest.tools) {
      expect(tool.description).not.toMatch(/\n/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("leaves out the plugin template, which never ships", async () => {
    const plugins = await firstPartyPlugins(root, sourceEntry);
    expect(plugins.map((plugin) => plugin.package)).not.toContain(
      "@openplans/plugin-template",
    );
  });

  it("mutant: a tool added to a plugin makes the committed manifest stale", async () => {
    const statusFile = new URL(
      "../../plugins/status/src/index.ts",
      import.meta.url,
    );
    const mutant = await plantMutant(
      statusFile,
      "ctx.mcpTools.add({",
      'ctx.mcpTools.add({ name: "planted_extra_tool", title: "Planted", description: "Planted.", inputSchema: getStatusInputSchema.pick({}), outputSchema: getStatusSchema.pick({}), readOnly: true, handler: async () => ({}) }); ctx.mcpTools.add({',
    );
    try {
      const module = (await import(mutant.path)) as {
        default: OpenPlansPlugin;
      };
      const plugins = (await firstPartyPlugins(root, sourceEntry)).map(
        (entry) =>
          entry.package === "@openplans/plugin-status"
            ? { ...entry, plugin: module.default }
            : entry,
      );
      const problems = manifestProblems(
        await committed(),
        await buildMcpToolManifest(plugins),
      );
      expect(problems).toContain("missing tool planted_extra_tool");
    } finally {
      await mutant.cleanup();
    }
  });

  it("mutant: a reworded core description makes the committed manifest stale", async () => {
    const tools = await plantMutant(
      new URL("../../src/mcp/tools.ts", import.meta.url),
      '"Inspect loaded data",',
      '"Inspect the data",',
    );
    const manifest = await plantMutant(
      new URL("../../src/mcp/manifest.ts", import.meta.url),
      'import { toolDescriptions } from "./tools.js";',
      `import { toolDescriptions } from ${JSON.stringify(tools.path)};`,
    );
    try {
      const mutated = (await import(manifest.path)) as typeof manifestModule;
      const problems = mutated.manifestProblems(
        await committed(),
        await mutated.buildMcpToolManifest(
          await firstPartyPlugins(root, sourceEntry),
        ),
      );
      expect(problems).toEqual([
        "tool order, titles, descriptions or fields differ",
      ]);
    } finally {
      await manifest.cleanup();
      await tools.cleanup();
    }
  });

  it("reports a removed tool and an unreadable file", async () => {
    const manifest = await current();
    const shorter = manifestText({
      ...manifest,
      tools: manifest.tools.filter((tool) => tool.name !== "get_status"),
    });
    expect(manifestProblems(shorter, manifest)).toEqual([
      "missing tool get_status",
    ]);
    const longer = manifestText({
      ...manifest,
      tools: [...manifest.tools, { ...manifest.tools[0]!, name: "gone" }],
    });
    expect(manifestProblems(longer, manifest)).toEqual(["unknown tool gone"]);
    expect(manifestProblems("", manifest)).toEqual([
      `${MANIFEST_PATH} is not valid JSON`,
    ]);
  });
});
