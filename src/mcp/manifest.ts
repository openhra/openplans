import { coreConfigView, loadConfig } from "../config/index.js";
import {
  benchmarkToolDefinition,
  lowestToolDefinition,
  marketSummaryToolDefinition,
} from "./handy.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  McpToolSpec,
  OpenPlansPlugin,
  PluginContext,
} from "@openplans/plugin-sdk";
import { estimateToolDefinition } from "./medicare-estimate.js";
import { evidenceCaution, toolNames } from "./schemas.js";
import { toolDescriptions } from "./tools.js";

/**
 * The public list of MCP tools: docs/mcp-tools.json. The website reads a copy of it, so the
 * pages never keep their own list. Regenerate it with `npm run mcp:manifest`; a test fails
 * when the committed file no longer matches the registry.
 */
export interface ManifestTool {
  name: string;
  title: string;
  /** The tool's own one-line description, without the evidence caution every tool shares. */
  description: string;
  kind: "core" | "plugin";
  /**
   * always: every server lists it. switched: listed only when its switches are on and the
   * caller holds the grant. plugin: listed when the server loads the plugin.
   */
  listed: "always" | "switched" | "plugin";
  /** The package that registers a plugin tool. */
  plugin?: string;
}
export interface McpToolManifest {
  schema_version: 1;
  tools: ManifestTool[];
}
export interface FirstPartyPlugin {
  package: string;
  plugin: OpenPlansPlugin;
}

export const MANIFEST_PATH = "docs/mcp-tools.json";
/** Workspace packages that never ship as plugins: the SDK and the starting point for new plugins. */
export const NOT_SHIPPED = new Set([
  "@openplans/plugin-sdk",
  "@openplans/plugin-template",
]);

const caution = ` ${evidenceCaution}`;
const ownText = (description: string) =>
  description.endsWith(caution)
    ? description.slice(0, -caution.length)
    : description;

/** A do-nothing registry for every kind except MCP tools, so setup only records. */
function recordingContext(
  pkg: string,
  plugin: OpenPlansPlugin,
  tools: McpToolSpec<unknown, unknown>[],
): PluginContext {
  const ignore = { add() {}, provide() {}, subscribe() {} };
  const named: Partial<PluginContext> = {
    plugin: { name: plugin.manifest.name ?? pkg, version: "" },
    options: undefined,
    config: coreConfigView(
      loadConfig({}, { version: 1, plugins: [] }),
    ) as unknown as PluginContext["config"],
    calculationHost: {
      enumerateHouseholdOffers: async () => {
        throw new Error(
          "Calculations are unavailable while recording tool definitions",
        );
      },
      householdDistributions: async () => {
        throw new Error(
          "Calculations are unavailable while recording tool definitions",
        );
      },
      slcsp: async () => {
        throw new Error(
          "Calculations are unavailable while recording tool definitions",
        );
      },
    },
    secrets: { get: () => undefined },
    log: () => {},
    mcpTools: {
      add: (spec) => {
        tools.push(spec as McpToolSpec<unknown, unknown>);
      },
    },
  };
  return new Proxy(named, {
    get: (target, key) =>
      key in target ? target[key as keyof PluginContext] : ignore,
  }) as PluginContext;
}

/** The MCP tools a plugin registers in setup, in registration order. */
export async function registeredTools(
  pkg: string,
  plugin: OpenPlansPlugin,
): Promise<McpToolSpec<unknown, unknown>[]> {
  if (!plugin.manifest.kinds.includes("mcpTools")) return [];
  const tools: McpToolSpec<unknown, unknown>[] = [];
  await plugin.setup(recordingContext(pkg, plugin, tools));
  await plugin.teardown?.();
  return tools;
}

/**
 * The first-party plugins under `plugins/`, in folder order. `entry` names the module to import
 * for a plugin folder: the TypeScript source under test, the built file from the script.
 */
export async function firstPartyPlugins(
  root: string,
  entry: (folder: string) => string,
): Promise<FirstPartyPlugin[]> {
  const folders = (
    await readdir(join(root, "plugins"), { withFileTypes: true })
  )
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
  const plugins: FirstPartyPlugin[] = [];
  for (const folder of folders) {
    const { name } = JSON.parse(
      await readFile(join(root, "plugins", folder, "package.json"), "utf8"),
    ) as { name: string };
    if (NOT_SHIPPED.has(name)) continue;
    const module = (await import(entry(folder))) as {
      default?: OpenPlansPlugin;
    };
    if (module.default?.manifest)
      plugins.push({ package: name, plugin: module.default });
  }
  return plugins;
}

/** Core tools in `tools/list` order, then the switched core tool, then plugin tools. */
export async function buildMcpToolManifest(
  plugins: readonly FirstPartyPlugin[],
): Promise<McpToolManifest> {
  const tools: ManifestTool[] = toolNames.map((name) => {
    const [title, description] = toolDescriptions[name];
    return { name, title, description, kind: "core", listed: "always" };
  });
  const estimate = estimateToolDefinition();
  tools.push({
    name: estimate.name,
    title: estimate.title ?? estimate.name,
    description: ownText(estimate.description ?? ""),
    kind: "core",
    listed: "switched",
  });
  const lowest = lowestToolDefinition();
  tools.push({
    name: lowest.name,
    title: lowest.title!,
    description: ownText(lowest.description!),
    kind: "core",
    listed: "switched",
  });
  const marketSummary = marketSummaryToolDefinition();
  tools.push({
    name: marketSummary.name,
    title: marketSummary.title ?? marketSummary.name,
    description: ownText(marketSummary.description ?? ""),
    kind: "core",
    listed: "switched",
  });
  const benchmark = benchmarkToolDefinition();
  tools.push({
    name: benchmark.name,
    title: benchmark.title!,
    description: ownText(benchmark.description!),
    kind: "core",
    listed: "switched",
  });
  for (const { package: pkg, plugin } of plugins) {
    for (const spec of await registeredTools(pkg, plugin)) {
      tools.push({
        name: spec.name,
        title: spec.title,
        description: ownText(spec.description),
        kind: "plugin",
        listed: "plugin",
        plugin: pkg,
      });
    }
  }
  return { schema_version: 1, tools };
}

/** The exact bytes of docs/mcp-tools.json. */
export function manifestText(manifest: McpToolManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Why a committed manifest differs from the registry; empty when it matches byte for byte. */
export function manifestProblems(
  committed: string,
  current: McpToolManifest,
): string[] {
  const expected = manifestText(current);
  if (committed === expected) return [];
  let names: string[] = [];
  try {
    const parsed = JSON.parse(committed) as McpToolManifest;
    names = parsed.tools.map((tool) => tool.name);
  } catch {
    return [`${MANIFEST_PATH} is not valid JSON`];
  }
  const wanted = current.tools.map((tool) => tool.name);
  const problems = [
    ...wanted
      .filter((name) => !names.includes(name))
      .map((name) => `missing tool ${name}`),
    ...names
      .filter((name) => !wanted.includes(name))
      .map((name) => `unknown tool ${name}`),
  ];
  return problems.length
    ? problems
    : ["tool order, titles, descriptions or fields differ"];
}
