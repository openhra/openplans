import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { plantMutant } from "../../src/plugins/testing/index.js";

// A synthetic package: one source file with a relative import and a package import.
let pkg: string;
const original =
  'import dep from "synthetic-dep";\nimport { b } from "./b.mjs";\nexport const value = () => dep + b + "-original";\n';
beforeEach(async () => {
  pkg = await mkdtemp(join(tmpdir(), "openplans-synthetic-kit-"));
  await mkdir(join(pkg, "src"));
  await mkdir(join(pkg, "node_modules/synthetic-dep"), { recursive: true });
  await writeFile(
    join(pkg, "node_modules/synthetic-dep/package.json"),
    JSON.stringify({ name: "synthetic-dep", type: "module", main: "index.js" }),
  );
  await writeFile(
    join(pkg, "node_modules/synthetic-dep/index.js"),
    'export default "dep-";\n',
  );
  await writeFile(join(pkg, "package.json"), '{"type":"module"}\n');
  await writeFile(join(pkg, "src/a.mjs"), original);
  await writeFile(join(pkg, "src/b.mjs"), 'export const b = "b";\n');
});
afterEach(async () => {
  await rm(pkg, { recursive: true, force: true });
});

it("plants the mutant outside the source tree, where it still resolves its imports", async () => {
  const mutant = await plantMutant(
    join(pkg, "src/a.mjs"),
    '"-original"',
    '"-mutant"',
  );
  try {
    // Nothing lands next to the original, where another test could scan it.
    expect(await readdir(join(pkg, "src"))).toEqual(["a.mjs", "b.mjs"]);
    expect(await readFile(join(pkg, "src/a.mjs"), "utf8")).toBe(original);
    const place = relative(await realpath(pkg), await realpath(mutant.path));
    expect(place.startsWith("..")).toBe(true);
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as { value(): string };
    expect(module.value()).toBe("dep-b-mutant");
  } finally {
    await mutant.cleanup();
  }
  await expect(stat(mutant.path)).rejects.toThrow();
});
