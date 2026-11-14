#!/usr/bin/env node
/**
 * Writes docs/mcp-tools.json from the built registry: the core tools and the tools of the
 * first-party plugins. Run `npm run mcp:manifest`, which builds first. `--check` writes nothing
 * and exits 1 when the committed file is stale.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const {
  MANIFEST_PATH,
  buildMcpToolManifest,
  firstPartyPlugins,
  manifestProblems,
  manifestText,
} = await import(pathToFileURL(join(root, "dist/mcp/manifest.js")).href);

const plugins = await firstPartyPlugins(
  root,
  (folder) =>
    pathToFileURL(join(root, "plugins", folder, "dist/index.js")).href,
);
const manifest = await buildMcpToolManifest(plugins);
const path = join(root, MANIFEST_PATH);
if (process.argv.includes("--check")) {
  const committed = await readFile(path, "utf8").catch(() => "");
  const problems = manifestProblems(committed, manifest);
  if (problems.length) {
    console.error(`${MANIFEST_PATH} is stale: ${problems.join("; ")}`);
    console.error("Run npm run mcp:manifest and commit the result.");
    process.exit(1);
  }
  console.log(`${MANIFEST_PATH}: current (${manifest.tools.length} tools)`);
} else {
  await writeFile(path, manifestText(manifest));
  console.log(`${MANIFEST_PATH}: wrote ${manifest.tools.length} tools`);
}
