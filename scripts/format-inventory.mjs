import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getFileInfo } from "prettier";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const skipped = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".vercel",
  ".claude-plan",
]);
const sourceExtension = /\.(?:[cm]?[jt]s|py)$/;

export async function inventory(root = packageRoot) {
  const protectedFiles = [];
  const fixtureSources = [];
  async function walk(prefix = "") {
    for (const entry of await readdir(resolve(root, prefix), {
      withFileTypes: true,
    })) {
      if (skipped.has(entry.name) || entry.name.startsWith(".env")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Unexpected symlink: ${path}`);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const fixture = path.includes("/fixtures/");
        const source = fixture && sourceExtension.test(path);
        const { ignored } = await getFileInfo(resolve(root, path), {
          ignorePath: resolve(root, ".prettierignore"),
          withNodeModules: false,
        });
        if (source) {
          if (ignored) throw new Error(`Fixture source is ignored: ${path}`);
          fixtureSources.push(path);
        } else if (fixture && !ignored) {
          throw new Error(`Fixture payload is selected: ${path}`);
        }
        if (ignored) {
          protectedFiles.push({
            path,
            sha256: createHash("sha256")
              .update(await readFile(resolve(root, path)))
              .digest("hex"),
          });
        }
      }
    }
  }
  await walk();
  return {
    schema_version: 1,
    protected_files: protectedFiles.sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    fixture_sources: fixtureSources.sort(),
  };
}

export async function checkInventory(manifest, root = packageRoot) {
  const current = await inventory(root);
  if (JSON.stringify(current) !== JSON.stringify(manifest)) {
    throw new Error("Protected bytes or fixture inventory changed");
  }
  return current;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, manifestPath] = process.argv.slice(2);
  if (!["snapshot", "check"].includes(command) || !manifestPath) {
    throw new Error(
      "Usage: node scripts/format-inventory.mjs snapshot|check MANIFEST",
    );
  }
  const result =
    command === "snapshot"
      ? await inventory()
      : await checkInventory(JSON.parse(await readFile(manifestPath, "utf8")));
  if (command === "snapshot") {
    await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(
    `format inventory: PASS (${result.protected_files.length} protected files, ${result.fixture_sources.length} fixture sources)`,
  );
}
