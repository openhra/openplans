import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Builds and runs the example plugin in docs/plugins.md, so the guide cannot drift from the SDK.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guide = join(root, "docs/plugins.md");
const tsc = join(root, "node_modules/typescript/bin/tsc");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const EXAMPLE = "plugins/hello/";
const REQUIRED = [
  "plugins/hello/src/index.ts",
  "plugins/hello/tests/hello.test.ts",
];

const tsconfig = (include: string[], extra: Record<string, unknown>) =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      ...extra,
    },
    include,
  });

/** Returns each `ts` block whose first line is `// plugins/hello/<path>`, keyed by that path. */
export function exampleBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
    const body = match[1] ?? "";
    const path = /^\/\/ (\S+)\n/.exec(body)?.[1];
    if (!path?.startsWith(EXAMPLE)) continue;
    if (blocks.has(path)) throw new Error(`duplicate example block ${path}`);
    blocks.set(path, body);
  }
  return blocks;
}

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});

/**
 * Lays the blocks out as `<tmp>/plugins/hello/`, with `src`, `scripts` and `node_modules` in
 * `<tmp>` linked to this tree, so the guide's relative import of the test kit resolves unchanged.
 */
async function writeExample(blocks: Map<string, string>) {
  const base = await mkdtemp(join(tmpdir(), "openplans-doc-example-"));
  scratch.push(base);
  for (const dir of ["src", "scripts", "node_modules"])
    await symlink(join(root, dir), join(base, dir), "dir");
  await writeFile(
    join(base, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  for (const [path, body] of blocks) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), body);
  }
  const pkg = join(base, EXAMPLE);
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@example/plugin-hello",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(pkg, "tsconfig.json"),
    tsconfig(["src/**/*.ts"], {
      outDir: "dist",
      rootDir: "src",
      declaration: true,
    }),
  );
  await writeFile(
    join(pkg, "tsconfig.tests.json"),
    tsconfig(["src/**/*.ts", "tests/**/*.ts"], { noEmit: true }),
  );
  return pkg;
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const build = (pkg: string) => run(tsc, ["-p", "tsconfig.json"], pkg);

describe("plugin guide example", () => {
  it("builds against the SDK and passes its own test with the kit", async () => {
    const blocks = exampleBlocks(await readFile(guide, "utf8"));
    expect([...blocks.keys()].sort()).toEqual(REQUIRED);
    const pkg = await writeExample(blocks);

    const built = build(pkg);
    expect(built.output).toBe("");
    expect(built.status).toBe(0);

    const typed = run(tsc, ["-p", "tsconfig.tests.json"], pkg);
    expect(typed.output).toBe("");
    expect(typed.status).toBe(0);

    const tested = run(vitest, ["run", "--root", pkg, "--dir", "tests"], pkg);
    expect(tested.status, tested.output).toBe(0);
    expect(tested.output).toMatch(/Tests\s+1 passed \(1\)/);
  }, 180_000);

  it("fails when the guide's code has a broken identifier (planted mutant)", async () => {
    const markdown = await readFile(guide, "utf8");
    const target = "ctx.routes.add(";
    expect(markdown.split(target)).toHaveLength(2);
    const pkg = await writeExample(
      exampleBlocks(markdown.replace(target, "ctx.routes.addRoute(")),
    );
    const built = build(pkg);
    expect(built.status).not.toBe(0);
    expect(built.output).toMatch(/error TS\d+: .*addRoute/);
  }, 120_000);
});
