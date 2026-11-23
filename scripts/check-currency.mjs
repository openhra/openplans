#!/usr/bin/env node
/**
 * Docs currency check. Facts that docs repeat from code must still match the code:
 *
 * - release versions in README.md, docs/*.md and the website tool pin equal package.json's
 *   version, or the pinned release that docs/self-host.md names;
 * - the plugin API version in docs equals the SDK's PLUGIN_API_VERSION;
 * - "off by default" and "no key needed" claims equal the config defaults;
 * - MCP tool counts equal docs/public-contract.json;
 * - ops/BACKLOG.md items whose newest date is over 60 days old are listed as stale. This is a
 *   warning, not a failure: the clock alone would otherwise turn an unchanged commit red.
 *
 * Usage: node scripts/check-currency.mjs [app root] [--defaults <json file>] [--today YYYY-MM-DD]
 * The config defaults come from the built dist/config/index.js (ci.sh builds first) unless
 * --defaults names a JSON file. Checks of ../website and ../ops are skipped when those folders
 * are absent, as in a release tarball.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = String.raw`(\d+\.\d+\.\d+)`;

/** Release version mentions. Each regex runs on whitespace-collapsed text; group 1 is the version. */
export const VERSION_PATTERNS = [
  new RegExp(String.raw`\bOpenPlans v?${SEMVER}\b`, "g"),
  new RegExp(String.raw`\bopenplans[:@]v?${SEMVER}\b`, "gi"),
  new RegExp(String.raw`releases/(?:tag|download)/v${SEMVER}\b`, "g"),
  new RegExp(
    String.raw`\b(?:current|latest) (?:release|version)(?: is)?:? \`?v?${SEMVER}\b`,
    "gi",
  ),
];
/** The pinned release in docs/self-host.md, when an operator guide pins one. */
export const PINNED_RELEASE = new RegExp(
  String.raw`\bpinned release:? \`?v?${SEMVER}\b`,
  "i",
);
export const SDK_CONSTANT =
  /export const PLUGIN_API_VERSION = "([0-9]+\.[0-9]+)"/;
/** Plugin API version mentions in README.md and docs/*.md; group 1 is the version. */
export const API_PATTERNS = [
  /\bThe plugin API is experimental\. Its version is `([0-9.]+)`/g,
  /`PLUGIN_API_VERSION`, now `([0-9.]+)`/g,
  /\bapiVersion: "([0-9.]+)"/g,
  /`apiVersion` is not `([0-9.]+)`/g,
  /\bAPI ([0-9]+\.[0-9]+) uses\b/g,
];
/**
 * The public export moves the source README.md to this path (scripts/export-public.mjs,
 * USAGE_DOC) and puts a short scaffold README.md in its place, next to the generated manifest. In
 * a tree with that manifest, a claim that names README.md is checked here, so the same claims
 * hold in the source tree and in the exported tree. tools/gate/check-export.mjs asserts that this
 * equals the exporter's path.
 */
export const EXPORT_MANIFEST = "release-manifest.json";
export const EXPORTED_README = "docs/usage.md";
/** Each claim must appear in its file, and the config default it states must hold. */
export const CONFIG_CLAIMS = [
  {
    file: "docs/usage-report.md",
    pattern:
      /\bThe usage report is an optional, [^.]*\. It is off by default\b/,
    path: "usageReport.enabled",
    expected: false,
  },
  {
    file: "docs/configuration.md",
    pattern:
      /`OPENPLANS_USAGE_REPORT` maps to `usageReport\.enabled`\. It defaults to `false`/,
    path: "usageReport.enabled",
    expected: false,
  },
  {
    file: "docs/configuration.md",
    pattern: /\| `OPENPLANS_RXNAV_IDENTITY` \| Off\./,
    path: "rxnavIdentity",
    expected: false,
  },
  {
    file: "README.md",
    pattern: /\bneed no CMS API key\b/,
    path: "cmsFallback.apiKey",
    expected: undefined,
  },
  {
    file: "README.md",
    pattern: /\bThe optional CMS Marketplace API fallback is off by default\b/,
    path: "cmsFallback.enabled",
    expected: false,
  },
  {
    file: "README.md",
    pattern: /`OPENPLANS_CMS_FALLBACK_QUOTES=on` extends that to quotes\b/,
    path: "cmsFallback.quotes",
    expected: false,
  },
  {
    file: "docs/configuration.md",
    pattern:
      /\| `CMS_API_KEY` \| Unset\. [^|]*No key is needed for bulk imports\./,
    path: "cmsFallback.apiKey",
    expected: undefined,
  },
];
/**
 * MCP tool counts. `core` is the anonymous tools the manifest marks core; `all` is every
 * anonymous tool in the contract (core plus the status plugin's get_status).
 */
export const TOOL_COUNT_RULES = [
  { pattern: /\blists these (\d+) tools\b/g, count: "core" },
  { pattern: /\bregisters (\d+) tools\b/g, count: "core" },
  { pattern: /\breturns all (\d+) tools\b/g, count: "core" },
  {
    pattern: /\badds one tool to the default (\d+), for (\d+)\b/g,
    count: "core",
    plus: [0, 1],
  },
  {
    pattern: /\bWith the status plugin it lists (\d+)\b/g,
    count: "all",
    plus: [1],
  },
  {
    pattern: /\badds `get_status`, so a server that loads it lists (\d+)\b/g,
    count: "all",
  },
  { pattern: /\badds `get_status`, which makes (\d+)\b/g, count: "all" },
  { pattern: /\bfrom the status plugin, (\d+) in all\b/g, count: "all" },
  { pattern: /\bthe (\d+) core tools\b/g, count: "core" },
];
/** Any digit count of tools that no rule above covers fails, so a new claim needs a rule. */
const ANY_TOOL_COUNT = /\b(\d+) (?:[A-Za-z-]+ )?tools\b/g;
export const STALE_DAYS = 60;

const collapse = (text) => text.replace(/\s+/g, " ");
const read = (file) => readFileSync(file, "utf8");
/** The raw-text line where a match found in whitespace-collapsed text starts. */
const lineOf = (raw, needle) => {
  const escaped = needle
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(String.raw`\s+`);
  const index = raw.search(new RegExp(escaped));
  return index < 0 ? 1 : raw.slice(0, index).split("\n").length;
};
const get = (object, path) =>
  path
    .split(".")
    .reduce((value, key) => (value == null ? value : value[key]), object);

function docFiles(appRoot) {
  const files = ["README.md"];
  const docs = join(appRoot, "docs");
  if (existsSync(docs))
    for (const name of readdirSync(docs).sort())
      if (name.endsWith(".md")) files.push(`docs/${name}`);
  return files.filter((file) => existsSync(join(appRoot, file)));
}

function* matches(pattern, text) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) yield match;
}

/** Newest-date age of each numbered item in ops/BACKLOG.md. */
export function staleBacklogItems(text, today, days = STALE_DAYS) {
  const stale = [];
  const items = text.split(/\n(?=\d+\. )/);
  for (const item of items) {
    const head = /^(\d+)\. (?:\*\*)?([^*\n]*)/.exec(item);
    if (!head) continue;
    const body = item.split(/\n#/)[0];
    const dates = [...body.matchAll(/\b(20\d\d-\d\d-\d\d)\b/g)]
      .map((m) => m[1])
      .sort();
    if (dates.length === 0) continue;
    const newest = dates[dates.length - 1];
    const age = Math.floor(
      (Date.parse(today) - Date.parse(newest)) / 86_400_000,
    );
    if (age > days)
      stale.push({ item: Number(head[1]), title: head[2].trim(), newest, age });
  }
  return stale;
}

export function checkCurrency({ appRoot, repoRoot, configDefaults, today }) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const pkg = JSON.parse(read(join(appRoot, "package.json")));
  const allowed = new Set([pkg.version]);
  const selfHost = join(appRoot, "docs/self-host.md");
  if (existsSync(selfHost)) {
    const pinned = PINNED_RELEASE.exec(collapse(read(selfHost)));
    if (pinned) allowed.add(pinned[1]);
  }
  const allowedText = [...allowed].join(" or ");
  const files = docFiles(appRoot);
  const texts = new Map(files.map((file) => [file, read(join(appRoot, file))]));

  // Release versions.
  const scanVersions = (label, raw) => {
    const text = collapse(raw);
    for (const pattern of VERSION_PATTERNS)
      for (const match of matches(pattern, text))
        if (!allowed.has(match[1]))
          errors.push(
            `${label}:${lineOf(raw, match[0])}: version ${match[1]} in "${match[0]}" is not ${allowedText}`,
          );
  };
  for (const [file, raw] of texts) scanVersions(file, raw);
  const website = repoRoot && join(repoRoot, "website");
  if (website && existsSync(website)) {
    const manifest = join(website, "plans/data/mcp-tools.json");
    if (existsSync(manifest))
      scanVersions("website/plans/data/mcp-tools.json", read(manifest));
    const pinFile = join(website, "tools/mcp-tools-pin.json");
    if (existsSync(pinFile)) {
      const release = JSON.parse(read(pinFile)).release;
      const version = /^v(\d+\.\d+\.\d+)$/.exec(release ?? "")?.[1];
      if (!version || !allowed.has(version))
        errors.push(
          `website/tools/mcp-tools-pin.json: release ${release} is not v${allowedText}`,
        );
    }
  } else notes.push("website/ absent: website pin not checked");

  // Plugin API version.
  const sdkIndex = join(appRoot, "plugins/sdk/src/index.ts");
  const sdk = existsSync(sdkIndex)
    ? SDK_CONSTANT.exec(read(sdkIndex))?.[1]
    : undefined;
  if (!sdk)
    errors.push(
      "plugins/sdk/src/index.ts: PLUGIN_API_VERSION export not found",
    );
  else {
    let stated = false;
    for (const [file, raw] of texts) {
      const text = collapse(raw);
      for (const pattern of API_PATTERNS)
        for (const match of matches(pattern, text)) {
          if (pattern === API_PATTERNS[0]) stated = true;
          if (match[1] !== sdk)
            errors.push(
              `${file}:${lineOf(raw, match[0])}: plugin API ${match[1]} in "${match[0]}" is not the SDK's ${sdk}`,
            );
        }
    }
    if (texts.has("docs/plugins.md") && !stated)
      errors.push(
        "docs/plugins.md: the sentence stating the plugin API version is missing",
      );
  }

  // Config claims.
  if (!configDefaults) errors.push("config defaults unavailable");
  else
    for (const claim of CONFIG_CLAIMS) {
      const home =
        claim.file === "README.md" && existsSync(join(appRoot, EXPORT_MANIFEST))
          ? EXPORTED_README
          : claim.file;
      const raw = texts.get(home);
      if (raw === undefined) {
        // README claims never skip: a tree without the file that holds them fails.
        if (claim.file === "README.md")
          errors.push(
            `README.md: claim ${claim.pattern} cannot be checked; ${home} does not exist`,
          );
        continue;
      }
      if (!claim.pattern.test(collapse(raw))) {
        errors.push(
          `${home}: claim ${claim.pattern} not found; update scripts/check-currency.mjs if it was reworded`,
        );
        continue;
      }
      const actual = get(configDefaults, claim.path);
      if (actual !== claim.expected)
        errors.push(
          `${home}: claims ${claim.path} defaults to ${String(claim.expected)}, but it is ${String(actual)}`,
        );
    }

  // MCP tool counts.
  const contractFile = join(appRoot, "docs/public-contract.json");
  const manifestFile = join(appRoot, "docs/mcp-tools.json");
  if (!existsSync(contractFile) || !existsSync(manifestFile))
    errors.push("docs/public-contract.json or docs/mcp-tools.json missing");
  else {
    const anonymous = JSON.parse(read(contractFile)).mcp.anonymous_tools;
    const kinds = new Map(
      JSON.parse(read(manifestFile)).tools.map((tool) => [
        tool.name,
        tool.kind,
      ]),
    );
    const counts = {
      all: anonymous.length,
      core: anonymous.filter((name) => kinds.get(name) === "core").length,
    };
    for (const [file, raw] of texts) {
      const text = collapse(raw);
      const covered = new Set();
      for (const rule of TOOL_COUNT_RULES)
        for (const match of matches(rule.pattern, text)) {
          match.slice(1).forEach((value, index) => {
            const want = counts[rule.count] + (rule.plus?.[index] ?? 0);
            if (Number(value) !== want)
              errors.push(
                `${file}:${lineOf(raw, match[0])}: "${match[0]}" says ${value}, the contract gives ${want}`,
              );
          });
          covered.add(match.index);
          for (const inner of matches(ANY_TOOL_COUNT, match[0]))
            covered.add(match.index + inner.index);
        }
      for (const match of matches(ANY_TOOL_COUNT, text))
        if (!covered.has(match.index))
          errors.push(
            `${file}:${lineOf(raw, match[0])}: tool count "${match[0]}" has no rule in scripts/check-currency.mjs`,
          );
      // The configuration reference's default tool table has one row per core tool.
      if (file === "docs/configuration.md") {
        const table = /lists these \d+ tools:\n\n((?:\|.*\n)+)/.exec(raw);
        const rows = table
          ? table[1].split("\n").filter((row) => /^\| `/.test(row)).length
          : 0;
        if (rows !== counts.core)
          errors.push(
            `docs/configuration.md: the default tool table has ${rows} rows, the contract gives ${counts.core}`,
          );
      }
    }
  }

  // Stale backlog items.
  const backlog = repoRoot && join(repoRoot, "ops/BACKLOG.md");
  if (backlog && existsSync(backlog))
    for (const stale of staleBacklogItems(read(backlog), today))
      warnings.push(
        `ops/BACKLOG.md: item ${stale.item} "${stale.title}" newest date ${stale.newest} is ${stale.age} days old`,
      );
  else notes.push("ops/BACKLOG.md absent: backlog dates not checked");

  return { errors, warnings, notes };
}

async function defaultsFromBuild(appRoot) {
  const built = join(appRoot, "dist/config/index.js");
  if (!existsSync(built)) return undefined;
  const { loadConfig } = await import(pathToFileURL(built).href);
  return loadConfig({});
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const [, value] = args.splice(index, 2);
    return value;
  };
  const defaultsFile = option("--defaults");
  const today = option("--today") ?? new Date().toISOString().slice(0, 10);
  const appRoot = resolve(
    args[0] ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const repoRoot = resolve(appRoot, "..");
  const configDefaults = defaultsFile
    ? JSON.parse(read(defaultsFile))
    : await defaultsFromBuild(appRoot);
  if (!configDefaults)
    console.error(
      "currency: dist/config/index.js missing; run npm run build first",
    );
  const { errors, warnings, notes } = checkCurrency({
    appRoot,
    repoRoot,
    configDefaults,
    today,
  });
  for (const note of notes) console.log(`currency: ${note}`);
  for (const warning of warnings) console.warn(`currency: WARN ${warning}`);
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error("currency: FAIL");
    process.exitCode = 1;
  } else console.log(`currency: PASS (${warnings.length} warnings)`);
}
