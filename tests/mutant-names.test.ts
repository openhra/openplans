import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importMutant, withMutantFile } from "./mutant-file.js";
import { fixedMutantNames } from "./mutant-names.js";
import { replaceSyntax } from "./source-mutation.js";

const root = fileURLToPath(new URL("../", import.meta.url));

async function testSources(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await testSources(path)));
    else if (
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      out.push(path);
  }
  return out;
}

// Each line names a mutant file the way the old tests did, and trips one rule.
const planted = {
  parent: 'const temporary = "../src/api/.quotes-mutant-limit.ts";',
  url: 'const temporary = new URL(".http-mutant-origin.ts", source);',
  root: 'const temporary = join(root, "src/plugins/.scope-mutant-a.ts");',
  helper:
    'const temporary = src("plugins/sources/.passthrough-mutant-events.ts");',
  rename:
    'const file = dist(path.replace(/([^/]+)$/, ".host-storage-mutant-$1"));',
};
// Names inside a fresh temp folder, or carrying the process id, are fine.
const allowed = [
  'const file = join(directory, "synthetic-auth-mutant.cjs");',
  "const file = new URL(`../src/mcp/.list-mutant-${process.pid}-${randomUUID()}.ts`, import.meta.url);",
  'import { importMutant } from "../mutant-file.js";',
  'const helper = await import("../mutant-file.js");',
  'const copy = await mkdtemp(join(packageSource, ".mutant-"));',
];

describe("planted mutant files get unique names", () => {
  it("no test writes a mutant under a fixed name in the repo", async () => {
    const files = [
      ...(await testSources(join(root, "tests"))),
      ...(
        await Promise.all(
          (await readdir(join(root, "plugins"))).map((plugin) =>
            testSources(join(root, "plugins", plugin, "tests")).catch(
              () => [] as string[],
            ),
          ),
        )
      ).flat(),
    ];
    expect(files.length).toBeGreaterThan(100);
    const found = [];
    for (const file of files)
      for (const hit of fixedMutantNames(await readFile(file, "utf8"), file))
        found.push(`${relative(root, file)}:${hit.line} ${hit.text}`);
    expect(found).toEqual([]);
  });

  it.each(Object.entries(planted))(
    "flags a fixed name built with %s",
    (_rule, line) => {
      expect(fixedMutantNames(line)).toHaveLength(1);
    },
  );

  it.each(allowed)("allows %s", (line) => {
    expect(fixedMutantNames(line)).toEqual([]);
  });

  // Planted mutants of the guard itself: each drops one rule, and its sample slips through.
  it.each([
    ["parent", 'text.includes("../")', "false"],
    ["url", 'callee === "URL"', 'callee === "NotURL"'],
    ["root", "REPO_BASE.test(args[0]!.getText(file))", "false"],
    ["helper", "REPO_HELPER.test(callee)", "false"],
    ["rename", "/\\.replace(All)?$/.test(callee) && index === 1", "false"],
  ] as const)(
    "negative control: a guard without the %s rule misses its sample",
    async (rule, before, after) => {
      const source = new URL("./mutant-names.ts", import.meta.url);
      await withMutantFile(
        source,
        replaceSyntax(await readFile(source, "utf8"), before, after),
        async (file) => {
          const mutant = await importMutant<{
            fixedMutantNames: typeof fixedMutantNames;
          }>(file, "fixedMutantNames");
          expect(() =>
            expect(mutant.fixedMutantNames(planted[rule])).toHaveLength(1),
          ).toThrow();
          // The other samples are still caught, so the copy is otherwise intact.
          for (const [other, line] of Object.entries(planted))
            if (other !== rule)
              expect(mutant.fixedMutantNames(line)).toHaveLength(1);
        },
      );
    },
  );
});
