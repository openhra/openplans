import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import * as prettier from "prettier";
import { checkInventory, inventory, packageRoot } from "./format-inventory.mjs";

import {
  findingsFromResults,
  checkBaseline,
  assertOnlyShrinks,
  assertHistoryOnlyShrinks,
} from "./lint-baseline.mjs";

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
  [
    "tests/hidden-any.ts",
    "export type Body = ReturnType<typeof JSON.parse>;",
    "no-restricted-syntax",
  ],
  ["scripts/server.mjs", "document.title = 'server';", "no-undef"],
  ["scripts/module.mjs", "require('node:fs');", "no-undef"],
]) {
  const [result] = await eslint.lintText(text, { filePath: path });
  assert(result.messages.some((message) => message.ruleId === rule));
  assert(result.errorCount > 0);
}
// The hidden-any ban stays narrow: other ReturnType<typeof ...> uses still lint clean.
{
  const [result] = await eslint.lintText(
    "export type Text = ReturnType<typeof JSON.stringify>;\nexport type Clock = ReturnType<typeof Date.now>;",
    { filePath: "tests/typed.ts" },
  );
  assert.deepEqual(result.messages, []);
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
const legacyRule = "@typescript-eslint/no-explicit-any";
const legacyPath = "tests/legacy.ts";
const legacyText = "export const legacy: any = 1;";
const lintLegacy = async (source) =>
  findingsFromResults(await eslint.lintText(source, { filePath: legacyPath }));
const initialFindings = await lintLegacy(legacyText);
assert.equal(initialFindings.length, 1);
const initialPolicy = {
  schema_version: 1,
  entries: {
    [legacyPath]: {
      rule: legacyRule,
      cleanup: "Replace the synthetic legacy type.",
      fingerprints: initialFindings.map((finding) => finding.fingerprint),
      context_fingerprints: initialFindings.map(
        (finding) => finding.contextFingerprint,
      ),
    },
  },
};
const initialSuppressions = { [legacyPath]: { [legacyRule]: { count: 1 } } };
assert.deepEqual(
  checkBaseline(initialFindings, initialSuppressions, initialPolicy),
  initialPolicy,
);
const extraFindings = await lintLegacy(
  legacyText + "\nexport const added: any = 2;",
);
assert.throws(
  () => checkBaseline(extraFindings, initialSuppressions, initialPolicy),
  /Stale or expanded suppression/,
);
const replacementFindings = await lintLegacy(
  "export const replacement: any = 1;",
);
assert.throws(
  () => checkBaseline(replacementFindings, initialSuppressions, initialPolicy),
  /New or stale baseline finding/,
);
assert.throws(
  () => checkBaseline([], initialSuppressions, initialPolicy),
  /Stale or expanded suppression/,
);
const expandedSuppressions = { [legacyPath]: { [legacyRule]: { count: 2 } } };
assert.throws(
  () => checkBaseline(initialFindings, expandedSuppressions, initialPolicy),
  /Stale or expanded suppression/,
);
const expandedPolicy = structuredClone(initialPolicy);
expandedPolicy.entries[legacyPath].fingerprints = extraFindings
  .map((finding) => finding.fingerprint)
  .sort();
assert.throws(
  () => assertOnlyShrinks(initialPolicy, expandedPolicy),
  /Baseline expansion/,
);
expandedPolicy.entries[legacyPath].context_fingerprints = extraFindings
  .map((finding) => finding.contextFingerprint)
  .sort();
const firstTest = await lintLegacy(
  'import { it } from "vitest"; it("first", () => { const legacy: any = 1; return legacy; });',
);
const movedTest = await lintLegacy(
  'import { it } from "vitest"; it("second", () => { const legacy: any = 1; return legacy; });',
);
assert.equal(firstTest[0].fingerprint, movedTest[0].fingerprint);
assert.notEqual(
  firstTest[0].contextFingerprint,
  movedTest[0].contextFingerprint,
);
const scopedPolicy = structuredClone(initialPolicy);
scopedPolicy.entries[legacyPath].fingerprints = firstTest.map(
  (finding) => finding.fingerprint,
);
scopedPolicy.entries[legacyPath].context_fingerprints = firstTest.map(
  (finding) => finding.contextFingerprint,
);
checkBaseline(firstTest, initialSuppressions, scopedPolicy);
assert.throws(
  () => checkBaseline(movedTest, initialSuppressions, scopedPolicy),
  /New or stale baseline context/,
);
const reboundPolicy = structuredClone(scopedPolicy);
reboundPolicy.entries[legacyPath].context_fingerprints = movedTest.map(
  (finding) => finding.contextFingerprint,
);
assert.throws(
  () => assertOnlyShrinks(scopedPolicy, reboundPolicy),
  /Baseline expansion/,
);
const prunedPolicy = checkBaseline([], {}, initialPolicy, { prune: true });
assert.deepEqual(prunedPolicy.entries, {});
assertOnlyShrinks(initialPolicy, prunedPolicy);

const syntheticIdentity = [
  "synthetic-lint-test",
  "users.noreply.github.com",
].join("@");
const baselineHistory = await mkdtemp(
  join(tmpdir(), "openplans-lint-history-"),
);
try {
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Synthetic lint test",
        "-c",
        `user.email=${syntheticIdentity}`,
        ...args,
      ],
      { cwd: baselineHistory, stdio: "pipe" },
    );
  git("init", "--quiet");
  await writeFile(
    join(baselineHistory, "eslint-baseline.json"),
    JSON.stringify(initialPolicy),
  );
  git("add", "eslint-baseline.json");
  git("commit", "--quiet", "-m", "synthetic baseline");
  assertHistoryOnlyShrinks(initialPolicy, baselineHistory);
  assertHistoryOnlyShrinks(prunedPolicy, baselineHistory);
  assert.throws(
    () => assertHistoryOnlyShrinks(expandedPolicy, baselineHistory),
    /Baseline expansion/,
  );
  await writeFile(
    join(baselineHistory, "eslint-baseline.json"),
    JSON.stringify(expandedPolicy),
  );
  git("add", "eslint-baseline.json");
  git("commit", "--quiet", "-m", "synthetic expansion control");
  assert.throws(
    () => assertHistoryOnlyShrinks(expandedPolicy, baselineHistory),
    /Baseline expansion/,
  );
} finally {
  await rm(baselineHistory, { recursive: true, force: true });
}

const inlineSuppression = await eslint.lintText(
  "/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic bypass control. */\n" +
    legacyText,
  { filePath: legacyPath },
);
assert.throws(
  () => findingsFromResults(inlineSuppression),
  /Unapproved inline suppression/,
);
console.log(
  `lint setup: PASS (undefined reference, type import, hidden any, nested ternary, stale disable, server globals, formatting, payload mutation, baseline expansion/replacement/staleness, moved statements and inline bypass rejected; ${current.fixture_sources.length} fixture sources selected)`,
);
