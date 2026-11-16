import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { coreConfigSchema, environmentPaths } from "../../src/config/index.js";
import { toolNames } from "../../src/mcp/schemas.js";
import { testDatabase } from "../pglite.js";

// The operator docs must name what the code serves: every route, every MCP tool and every
// environment variable the typed config reads. Each check also runs on a planted doc mutant.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

interface Route {
  method: string;
  path: string;
}

/** GET and POST handlers the API registers, without middleware entries. */
function servedRoutes(): Route[] {
  const app = createApp(testDatabase(new PGlite()), { lowestPremiums: true });
  const seen = new Map<string, Route>();
  for (const { method, path } of app.routes)
    if (method === "GET" || method === "POST")
      seen.set(`${method} ${path}`, { method, path });
  return [...seen.values()];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A route path as a pattern: `:id` matches `{id}`, `:id` or a concrete value. */
const pathPattern = (path: string) =>
  path
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/\\s?`\\[\\]]+" : escape(part)))
    .join("/");

/** Routes the doc never names as `METHOD /path`. `prefix` is cut when the doc omits it. */
function undocumentedRoutes(
  routes: readonly Route[],
  doc: string,
  prefix = "",
): string[] {
  return routes
    .filter((route) => {
      const path = route.path.slice(prefix.length) || "/";
      const pattern = new RegExp(
        `\\b${route.method}\\s+${pathPattern(path)}(?=$|[\\s?\`\\[\\])|])`,
        "m",
      );
      return !pattern.test(doc);
    })
    .map((route) => `${route.method} ${route.path}`);
}

/** `METHOD /path` mentions in the doc that no served route matches. */
function unknownDocumentedRoutes(
  routes: readonly Route[],
  doc: string,
  retired: readonly string[] = [],
): string[] {
  const mentioned = doc.matchAll(
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/(?:v1|compat|healthz|readyz)[^\s?`[\]|)"]*)/g,
  );
  const unknown = new Set<string>();
  for (const [, method, path] of mentioned) {
    const name = `${method} ${path}`;
    if (retired.includes(name)) continue;
    const served = routes.some(
      (route) =>
        route.method === method &&
        new RegExp(`^${pathPattern(route.path)}$`).test(path!),
    );
    if (!served) unknown.add(name);
  }
  return [...unknown];
}

/** Problems with the MCP tool table and the tool counts the docs state. */
function mcpToolProblems(
  tools: readonly string[],
  configuration: string,
  selfHost: string,
): string[] {
  const problems: string[] = [];
  for (const tool of tools)
    if (!new RegExp(`^\\|\\s*\`${tool}\`\\s*\\|`, "m").test(configuration))
      problems.push(`configuration.md has no row for ${tool}`);
  const counts = [
    ...configuration.matchAll(/lists these (\d+) tools/g),
    ...selfHost.matchAll(/registers (\d+) tools/g),
    ...selfHost.matchAll(/returns all (\d+) tools/g),
  ];
  if (counts.length !== 3) problems.push("a tool count sentence is missing");
  for (const [sentence, count] of counts)
    if (Number(count) !== tools.length)
      problems.push(`"${sentence}" but the core has ${tools.length} tools`);
  return problems;
}

/** Environment variables the typed config reads that the reference never names. */
function undocumentedVariables(
  names: readonly string[],
  doc: string,
): string[] {
  return names.filter((name) => !doc.includes(`\`${name}\``));
}

/** Docs that name a Node version other than the pinned one, or not at all. */
function staleNodeVersion(
  pinned: string,
  docs: Record<string, string>,
): string[] {
  return Object.entries(docs)
    .filter(([, text]) => {
      const named = [...text.matchAll(/\b22\.\d+\.\d+\b/g)].map((m) => m[0]);
      return !named.includes(pinned) || named.some((v) => v !== pinned);
    })
    .map(([name]) => name);
}

interface SchemaNode {
  _zod?: {
    def: {
      type: string;
      innerType?: SchemaNode;
      in?: SchemaNode;
      shape?: Record<string, SchemaNode>;
    };
  };
}
const WRAPPERS = ["optional", "default", "prefault", "nullable", "pipe"];

/** Dotted paths of every leaf in the core config schema, such as `cache.maxMb`. */
function configFileKeys(schema: SchemaNode, prefix = ""): string[] {
  let node: SchemaNode | undefined = schema;
  while (node?._zod && WRAPPERS.includes(node._zod.def.type))
    node = node._zod.def.innerType ?? node._zod.def.in;
  const shape = node?._zod?.def.type === "object" ? node._zod.def.shape : null;
  if (!shape) return [prefix];
  return Object.entries(shape).flatMap(([key, child]) =>
    configFileKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** File keys the reference never names, directly or through an environment-only `section.*`. */
function undocumentedFileKeys(keys: readonly string[], doc: string): string[] {
  return keys.filter((key) => {
    const section = key.split(".")[0];
    return (
      !doc.includes(`\`${key}\``) &&
      !(key.includes(".") && doc.includes(`\`${section}.*\``))
    );
  });
}

const configFileDocumentation = () =>
  [read("docs/configuration.md"), read("docs/admin-access.md")].join("\n");

// Public docs the export ships, excluding the private files export-public.exclude drops.
const SHIPPED_DOCS = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/ci.md",
  "docs/configuration.md",
  "docs/admin-access.md",
  "docs/development-tools.md",
  "docs/ichra.md",
  "docs/medicare.md",
  "docs/migrations.md",
  "docs/plugins-operations.md",
  "docs/plugins.md",
  "docs/quoting.md",
  "docs/record-policy.md",
  "docs/row-provenance.md",
  "docs/self-host.md",
  "src/api/README.md",
  "src/compat/v1/README.md",
  "plugins/status/README.md",
];

/** Heading anchors as GitHub renders them, with `-1`, `-2` for repeats. */
function anchors(markdown: string): Map<string, number> {
  const found = new Map<string, number>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]!
      .trim()
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    found.set(slug, (found.get(slug) ?? 0) + 1);
  }
  return found;
}

/**
 * Relative links whose file or heading is missing. An in-page link to a heading that repeats
 * counts as broken: it lands on the first copy, such as another release's Upgrading section.
 */
function brokenLinks(
  file: string,
  markdown: string,
  load: (path: string) => string | undefined,
): string[] {
  const broken: string[] = [];
  const prose = markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, "");
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target!)) continue;
    const [path, anchor] = target!.split("#");
    const destination = path
      ? resolve(dirname(resolve(root, file)), decodeURIComponent(path))
      : resolve(root, file);
    const text = path ? load(destination) : markdown;
    if (text === undefined) {
      broken.push(`${file} -> ${target}`);
      continue;
    }
    if (!anchor || !destination.endsWith(".md")) continue;
    const count = anchors(text).get(anchor.toLowerCase()) ?? 0;
    if (count === 0 || (!path && count > 1))
      broken.push(`${file} -> ${target}`);
  }
  return broken;
}

const loadFile = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

describe("docs match the API surface", () => {
  const routes = servedRoutes();
  const native = routes.filter((route) => !route.path.startsWith("/compat/"));
  const compat = routes.filter((route) => route.path.startsWith("/compat/v1/"));
  const apiGuide = read("src/api/README.md");
  const compatGuide = read("src/compat/v1/README.md");

  it("finds the routes it checks", () => {
    expect(native.length).toBeGreaterThanOrEqual(30);
    expect(compat.length).toBeGreaterThan(10);
  });

  it("names every native route in the API guide", () => {
    expect(undocumentedRoutes(native, apiGuide)).toEqual([]);
  });

  it("names every compatibility route in the facade guide", () => {
    expect(undocumentedRoutes(compat, compatGuide, "/compat/v1")).toEqual([]);
  });

  it("names no native route the API does not serve", () => {
    for (const file of SHIPPED_DOCS.filter((name) => name !== "CHANGELOG.md"))
      expect(
        unknownDocumentedRoutes(routes, read(file), [
          // The quoting guide says this route was removed.
          "POST /v1/premium-estimates",
        ]),
        file,
      ).toEqual([]);
  });

  it("lists every core MCP tool and states the count", () => {
    expect(toolNames).toHaveLength(15);
    expect(
      mcpToolProblems(
        toolNames,
        read("docs/configuration.md"),
        read("docs/self-host.md"),
      ),
    ).toEqual([]);
  });

  it("documents every environment variable the typed config reads", () => {
    expect(
      undocumentedVariables(
        Object.keys(environmentPaths),
        read("docs/configuration.md"),
      ),
    ).toEqual([]);
  });

  it("documents every config file key", () => {
    const keys = configFileKeys(coreConfigSchema as unknown as SchemaNode);
    expect(keys.length).toBeGreaterThan(70);
    expect(keys).toContain("cache.maxMb");
    expect(undocumentedFileKeys(keys, configFileDocumentation())).toEqual([]);
  });

  it("names the pinned Node version where the docs give one", () => {
    const pinned = read(".node-version").trim();
    expect(
      staleNodeVersion(pinned, {
        "README.md": read("README.md"),
        "docs/ci.md": read("docs/ci.md"),
      }),
    ).toEqual([]);
  });

  it("resolves every relative link and heading in the shipped docs", () => {
    for (const file of SHIPPED_DOCS)
      expect(brokenLinks(file, read(file), loadFile), file).toEqual([]);
  });
});

describe("planted doc mutants fail the checks", () => {
  const routes = servedRoutes();
  const native = routes.filter((route) => !route.path.startsWith("/compat/"));
  const apiGuide = read("src/api/README.md");

  it("a route dropped from the API guide", () => {
    const mutant = apiGuide
      .split("\n")
      .filter((line) => !line.includes("/v1/provider-participation"))
      .join("\n");
    expect(undocumentedRoutes(native, mutant)).toEqual([
      "POST /v1/provider-participation",
    ]);
  });

  it("a documented route the API never served", () => {
    const mutant = `${apiGuide}\nPOST /v1/plan-compare\n`;
    expect(unknownDocumentedRoutes(routes, mutant)).toEqual([
      "POST /v1/plan-compare",
    ]);
  });

  it("a tool row dropped and a stale count", () => {
    const configuration = read("docs/configuration.md");
    const selfHost = read("docs/self-host.md");
    const dropped = configuration.replace(/^\|\s*`search_drugs`.*\n/m, "");
    expect(mcpToolProblems(toolNames, dropped, selfHost)).toEqual([
      "configuration.md has no row for search_drugs",
    ]);
    const stale = selfHost.replace(/registers \d+ tools/, "registers 14 tools");
    expect(mcpToolProblems(toolNames, configuration, stale)).toEqual([
      `"registers 14 tools" but the core has ${toolNames.length} tools`,
    ]);
  });

  it("a config variable dropped from the reference", () => {
    const mutant = read("docs/configuration.md").replaceAll(
      "`OPENPLANS_TRUST_PROXY`",
      "trusted proxies",
    );
    expect(
      undocumentedVariables(Object.keys(environmentPaths), mutant),
    ).toEqual(["OPENPLANS_TRUST_PROXY"]);
  });

  it("a config file key dropped from the reference", () => {
    const keys = configFileKeys(coreConfigSchema as unknown as SchemaNode);
    const mutant = configFileDocumentation().replaceAll(
      "`mcp.allowedOrigins`",
      "the origin list",
    );
    expect(undocumentedFileKeys(keys, mutant)).toEqual(["mcp.allowedOrigins"]);
  });

  it("an admin file key dropped from its guide", () => {
    const keys = configFileKeys(coreConfigSchema as unknown as SchemaNode);
    const mutant = configFileDocumentation().replaceAll(
      "`admin.ingressReviewed`",
      "the ingress review flag",
    );
    expect(undocumentedFileKeys(keys, mutant)).toEqual([
      "admin.ingressReviewed",
    ]);
  });

  it("a Node version left behind after an update", () => {
    const ci = read("docs/ci.md");
    expect(
      staleNodeVersion("22.99.0", { "docs/ci.md": ci, "README.md": "" }),
    ).toEqual(["docs/ci.md", "README.md"]);
  });

  it("a missing file, a missing heading and a repeated in-page heading", () => {
    const mutant = [
      "# Notes",
      "## v2",
      "### Upgrading",
      "## v1",
      "### Upgrading",
      "See [Upgrading](#upgrading), [gone](docs/gone.md) and [x](docs/ci.md#no-such-heading).",
    ].join("\n");
    expect(brokenLinks("CHANGELOG.md", mutant, loadFile)).toEqual([
      "CHANGELOG.md -> #upgrading",
      "CHANGELOG.md -> docs/gone.md",
      "CHANGELOG.md -> docs/ci.md#no-such-heading",
    ]);
  });
});
