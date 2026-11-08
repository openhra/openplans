import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import * as prettier from "prettier";
import { checkInventory, inventory, packageRoot } from "./format-inventory.mjs";

const eslint = new ESLint({ cwd: packageRoot });
for (const [filePath, sourceType] of [
  ["scripts/example.mjs", "module"],
  ["scripts/example.cjs", "commonjs"],
  ["src/example.ts", "module"],
  ["src/example.cts", "commonjs"],
]) {
  const config = await eslint.calculateConfigForFile(filePath);
  assert.equal(config.languageOptions.sourceType, sourceType);
}
for (const [path, text, rule] of [
  ["scripts/undefined.mjs", "console.log(missingRuntimeValue);", "no-undef"],
  [
    "src/type-import.ts",
    'import { Stats } from "node:fs"; export type Entry = Stats;',
    "@typescript-eslint/consistent-type-imports",
  ],
  [
    "scripts/nested.mjs",
    "export const result = a ? b ? 1 : 2 : 3;",
    "no-nested-ternary",
  ],
  [
    "scripts/stale.mjs",
    "/* eslint-disable no-alert */\nexport const value = 1;",
    null,
  ],
  ["scripts/server.mjs", "document.title = 'server';", "no-undef"],
  ["scripts/module.mjs", "require('node:fs');", "no-undef"],
]) {
  const [result] = await eslint.lintText(text, { filePath: path });
  assert(result.messages.some((message) => message.ruleId === rule));
  assert(result.errorCount > 0);
}
const options = await prettier.resolveConfig(
  resolve(packageRoot, "package.json"),
);
assert.deepEqual(options, {});
assert.equal(
  await prettier.check("export const a=1", {
    ...options,
    parser: "typescript",
  }),
  false,
);
assert.equal(
  await prettier.format(
    "A long paragraph that must keep its original line.\nAnother line in that paragraph.\n",
    { ...options, parser: "markdown" },
  ),
  "A long paragraph that must keep its original line.\nAnother line in that paragraph.\n",
);

const current = await inventory();
for (const path of current.fixture_sources.filter((path) =>
  /\.[cm]?[jt]s$/.test(path),
)) {
  assert.equal(
    await eslint.isPathIgnored(resolve(packageRoot, path)),
    false,
    path,
  );
}
const scratch = await mkdtemp(join(tmpdir(), "openplans-lint-setup-"));
try {
  await cp(
    resolve(packageRoot, ".prettierignore"),
    join(scratch, ".prettierignore"),
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(scratch, "tests/fixtures"), { recursive: true });
  const payload = join(scratch, "tests/fixtures/payload.json");
  const generator = join(scratch, "tests/fixtures/generate.mjs");
  await writeFile(payload, '{"synthetic":true,"value":[1,2]}\n');
  await writeFile(generator, "export const value=1;\n");
  const baseline = await inventory(scratch);
  assert.equal(baseline.protected_files.length, 1);
  assert.deepEqual(baseline.fixture_sources, ["tests/fixtures/generate.mjs"]);
  const bytes = await readFile(payload);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const ignored = await prettier.getFileInfo(payload, {
    ignorePath: join(scratch, ".prettierignore"),
  });
  assert.equal(ignored.ignored, true);
  execFileSync(
    process.execPath,
    [
      resolve(packageRoot, "node_modules/prettier/bin/prettier.cjs"),
      "--ignore-path",
      ".prettierignore",
      "--write",
      ".",
    ],
    { cwd: scratch, stdio: "pipe" },
  );
  await checkInventory(baseline, scratch);
  assert.equal(hash(await readFile(payload)), hash(bytes));
  assert.equal(await readFile(generator, "utf8"), "export const value = 1;\n");
  // Deliberately bypass the ignore on a disposable synthetic payload.
  await writeFile(
    payload,
    await prettier.format(bytes.toString(), { parser: "json" }),
  );
  assert.notEqual(hash(await readFile(payload)), hash(bytes));
  await assert.rejects(checkInventory(baseline, scratch), /Protected bytes/);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  `lint setup: PASS (undefined reference, type import, nested ternary, stale disable, server globals, formatting and payload mutation rejected; ${current.fixture_sources.length} fixture sources selected)`,
);
