import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Ingest and worker code resolves `raw/` through the fetch cache's store (src/fetch/snapshots.ts),
 * so it reads the same snapshots whether the store is `local` or remote. This guard fails when
 * code under src/ingest or src/worker builds a `<dataDir>/raw` path itself. It is a static scan,
 * so it can only catch the usual spellings: `join(dir, "raw", ...)` or `join(dir, "raw/x")`,
 * `` `${dir}/raw/...` `` and `dir + "/raw/..."`. A store key such as `` `raw/${source}` `` handed to
 * the store is not a path and is not flagged.
 */
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const scannedRoots = ["src/ingest", "src/worker"];

/**
 * TypeScript files allowed to build a raw/ path, with the number of sites each may have. Keep
 * it short. New code resolves a path with `snapshotPath`, or reads through `readCachedText`,
 * `cachedFilePath` or `cachedPayloadPath`.
 */
const allowedTypeScript: Record<string, { sites: number; reason: string }> = {
  "src/ingest/puf/import-source.ts": {
    sites: 1,
    reason:
      "newestPufManifest returns <dataDir>/raw/cms-exchange-puf as the source's identity; " +
      "manifestArchive takes the data directory and source back out of it and opens nothing there",
  },
};

/**
 * Python, shell and plain JavaScript helpers that open `raw/` on the data host. They run outside
 * the Node worker and cannot load the TypeScript store, so they only work with the `local` store.
 * The open geocoder scripts take a store copy from geocoder.sh (OPENPLANS_OPEN_GEOCODER_RAW_DIR).
 * Each new script must use the worker's commands instead, or be listed here with a reason.
 */
const localOnlyScripts: Record<string, string> = {
  "src/ingest/geocode/download-open.py":
    "writes extracts to raw/open-geocoder, or to the store copy geocoder.sh names",
  "src/ingest/geocode/geocoder.sh":
    "mounts raw/open-geocoder, or the store copy it fetches down first",
  "src/ingest/geocode/prepare-open.py":
    "mounts the directory download-open.py resolves",
  "src/ingest/puf/import-header-audit.py": "offline audit of local PUF headers",
  "src/ingest/qhp/provider-postgres-report.py":
    "offline real-data report on a local cache",
  "src/ingest/state/nativecheck.mjs": "offline check of a local Census file",
  "src/ingest/state/ny-identity.py": "offline real-data check on a local cache",
  "src/ingest/state/offexchange-inventory.py":
    "offline real-data inventory of a local cache",
  "src/ingest/state/prepare.py": "local state rating preparation",
  "src/ingest/state/reflective.py": "local state rating preparation",
  "src/ingest/state/vt-metal.py": "offline real-data check on a local cache",
};

/**
 * Listed scripts that stay in the source repository and are left out of the published package
 * (scripts/export-public.exclude, which is not published either). The source repository must have
 * every listed script; a published copy may lack only these.
 */
const sourceRepositoryOnly = ["src/ingest/qhp/provider-postgres-report.py"];
const exportExclude = join(packageRoot, "scripts/export-public.exclude");
const sourceRepository = existsSync(exportExclude);
const listedScripts = () =>
  Object.keys(localOnlyScripts).filter(
    (path) => sourceRepository || !sourceRepositoryOnly.includes(path),
  );

const typeScriptFile = /\.(c|m)?ts$/;
const scriptFile = /\.(py|sh|mjs|cjs|js)$/;
/** In scripts: `/ 'raw'` (pathlib), a quoted `raw/...`, or `.../raw/...` inside a string. */
const scriptRawPath = /\/\s*["']raw["'/]|["']raw\/|\/raw\//;

function* filesUnder(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".openplans-"))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}
const scanned = () =>
  scannedRoots.flatMap((root) =>
    [...filesUnder(join(packageRoot, root))].map((path) =>
      relative(packageRoot, path).split(sep).join("/"),
    ),
  );

const isRawSegment = (node: ts.Node) =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  /^raw($|\/)/.test(node.text);
const startsRawPath = (node: ts.Node) =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  /^\/raw($|\/)/.test(node.text);

/** The `line: text` of each place `source` builds a `<dir>/raw` path itself. */
export function rawPathSites(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const sites: string[] = [];
  const visit = (node: ts.Node) => {
    const joinsRaw =
      ts.isCallExpression(node) &&
      /(^|\.)(join|resolve)$/.test(node.expression.getText(file)) &&
      node.arguments.some(isRawSegment);
    const templatesRaw =
      ts.isTemplateExpression(node) &&
      node.templateSpans.some((span) => /^\/raw($|\/)/.test(span.literal.text));
    const concatenatesRaw =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      startsRawPath(node.right);
    if (joinsRaw || templatesRaw || concatenatesRaw) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      sites.push(`${line + 1}: ${node.getText(file).replace(/\s+/g, " ")}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

describe("raw/ readers go through the snapshot store", () => {
  it("no ingest or worker TypeScript builds a <dataDir>/raw path itself", () => {
    const found: Record<string, string[]> = {};
    for (const path of scanned().filter((path) => typeScriptFile.test(path))) {
      const sites = rawPathSites(
        path,
        readFileSync(join(packageRoot, path), "utf8"),
      );
      if (sites.length !== (allowedTypeScript[path]?.sites ?? 0))
        found[path] = sites;
    }
    expect(found).toEqual({});
  });

  it("only the listed local-only scripts open raw/ themselves", () => {
    const found = scanned()
      .filter((path) => scriptFile.test(path))
      .filter((path) =>
        scriptRawPath.test(readFileSync(join(packageRoot, path), "utf8")),
      )
      .sort();
    expect(found).toEqual(listedScripts().sort());
  });

  it("every allowlist entry still names a file that needs it", () => {
    const files = new Set(scanned());
    for (const path of [...Object.keys(allowedTypeScript), ...listedScripts()])
      expect(files.has(path), path).toBe(true);
  });

  it("scripts left out of the published package are excluded from its export", () => {
    if (!sourceRepository) return;
    const excluded = readFileSync(exportExclude, "utf8").split("\n");
    for (const path of sourceRepositoryOnly) {
      expect(localOnlyScripts[path], path).toBeDefined();
      expect(excluded, path).toContain(path);
    }
  });

  it("negative control: each spelling of a direct raw/ read is flagged", () => {
    const planted = [
      'await readdir(join(dataDir, "raw", source));',
      'await readFile(path.join(dataDir, "raw/cms-exchange-puf", name), "utf8");',
      "createReadStream(`${dataDir}/raw/${source}/${id}/payload`);",
      'await readdir(dataDir + "/raw/" + source);',
      'await stat(resolve(root, "raw"));',
    ];
    for (const line of planted)
      expect(rawPathSites("planted.ts", line), line).toHaveLength(1);
  });

  it("negative control: store keys, columns and comments are not flagged", () => {
    const clean = [
      "await store.stat(`raw/${source}/${name}/metadata.json`);",
      'const columns = ["snapshot_id", "raw"];',
      '// reads join(dataDir, "raw", source) through the store',
      'snapshotPath(dataDir, "cms-exchange-puf", name);',
    ];
    for (const line of clean)
      expect(rawPathSites("clean.ts", line), line).toEqual([]);
  });

  it("negative control: a planted reader in an ingest file fails the scan", () => {
    const path = "src/ingest/geo/sources.ts";
    const original = readFileSync(join(packageRoot, path), "utf8");
    const mutant = original.replace(
      "for (const name of await sidecarNames(directory, source)) {",
      'for (const name of await readdir(join(directory, "raw", source))) {',
    );
    expect(mutant).not.toBe(original);
    expect(rawPathSites(path, original)).toEqual([]);
    expect(rawPathSites(path, mutant)).toHaveLength(1);
  });
});
