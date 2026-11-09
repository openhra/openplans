import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { format } from "prettier";
import { packageRoot } from "./format-inventory.mjs";

const legacyRule = "@typescript-eslint/no-explicit-any";
const policyName = "eslint-baseline.json";
const suppressionsName = "eslint-suppressions.json";

function functionContext(node, source) {
  const frames = [];
  let scope;
  for (let parent = node; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent))
      frames.push({ binding: parent.name.getText(source) });
    if (ts.isCallExpression(parent))
      frames.push({
        call: parent.expression.getText(source),
        arguments: parent.arguments
          .filter((argument) => !ts.isFunctionLike(argument))
          .map((argument) => argument.getText(source)),
      });
    if (ts.isFunctionLike(parent)) {
      if (parent.name) frames.push({ function: parent.name.getText(source) });
      // Suite callbacks organize tests; an untouched sibling test keeps its own allowance.
      const suite =
        ts.isCallExpression(parent.parent) &&
        /^describe(?:[.(]|$)/.test(parent.parent.expression.getText(source));
      if (!scope && !suite) scope = parent.getText(source);
    }
  }
  return { frames, scope: scope ?? null };
}

/** Statement hashes prevent a removed allowance from paying for a different violation. */
export function findingsFromResults(results, root = packageRoot) {
  const findings = [];
  for (const result of results) {
    for (const message of result.suppressedMessages) {
      assert(
        message.ruleId === "no-control-regex" &&
          message.suppressions.every(
            (suppression) =>
              typeof suppression.justification === "string" &&
              suppression.justification.trim(),
          ),
        `Unapproved inline suppression: ${message.ruleId}`,
      );
    }
    if (!result.messages.length) continue;
    const source = ts.createSourceFile(
      result.filePath,
      result.source,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const message of result.messages) {
      assert.equal(
        message.ruleId,
        legacyRule,
        `Unbaselined rule: ${message.ruleId}`,
      );
      assert.equal(message.severity, 2);
      const position = source.getPositionOfLineAndCharacter(
        message.line - 1,
        message.column - 1,
      );
      let statement = source;
      let location = source;
      function visit(node) {
        if (position < node.getStart(source) || position >= node.end) return;
        location = node;
        if (ts.isStatement(node)) statement = node;
        ts.forEachChild(node, visit);
      }
      visit(source);
      findings.push({
        path: relative(root, result.filePath).split("\\").join("/"),
        fingerprint: createHash("sha256")
          .update(statement.getText(source))
          .digest("hex"),
        contextFingerprint: createHash("sha256")
          .update(
            JSON.stringify([
              statement.getText(source),
              functionContext(location, source),
            ]),
          )
          .digest("hex"),
      });
    }
  }
  return findings;
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function assertOnlyShrinks(previous, current) {
  for (const [path, entry] of Object.entries(current.entries)) {
    for (const field of ["fingerprints", "context_fingerprints"]) {
      const prior = previous.entries[path]?.[field];
      // Adding context to the original statement-only baseline narrows its existing allowances.
      if (field === "context_fingerprints" && prior === undefined) continue;
      const remaining = counts(prior ?? []);
      for (const fingerprint of entry[field]) {
        assert(
          (remaining.get(fingerprint) ?? 0) > 0,
          `Baseline expansion or replacement: ${path}`,
        );
        remaining.set(fingerprint, remaining.get(fingerprint) - 1);
      }
    }
  }
}

export function checkBaseline(
  findings,
  suppressions,
  policy,
  { prune = false } = {},
) {
  assert.equal(policy.schema_version, 1);
  const current = { schema_version: 1, entries: {} };
  const paths = new Set([
    ...Object.keys(suppressions),
    ...Object.keys(policy.entries),
    ...findings.map((f) => f.path),
  ]);
  for (const path of [...paths].sort()) {
    assert(
      path.startsWith("tests/"),
      `Only test typing debt may be suppressed: ${path}`,
    );
    const entry = policy.entries[path];
    assert(
      entry && typeof entry.cleanup === "string" && entry.cleanup.trim(),
      `Missing cleanup entry: ${path}`,
    );
    assert.equal(entry.rule, legacyRule, `Rule cannot be suppressed: ${path}`);
    assert(Array.isArray(entry.fingerprints) && entry.fingerprints.length > 0);
    assert(
      Array.isArray(entry.context_fingerprints) &&
        entry.context_fingerprints.length === entry.fingerprints.length,
    );
    assert(
      [...entry.fingerprints, ...entry.context_fingerprints].every((hash) =>
        /^[a-f0-9]{64}$/.test(hash),
      ),
    );
    const actual = findings
      .filter((finding) => finding.path === path)
      .map((finding) => finding.fingerprint)
      .sort();
    const expected = [...entry.fingerprints].sort();
    const actualContexts = findings
      .filter((finding) => finding.path === path)
      .map((finding) => finding.contextFingerprint)
      .sort();
    const allowed = suppressions[path] ?? {};
    if (actual.length || !prune) {
      assert.deepEqual(
        Object.keys(allowed),
        [legacyRule],
        `Unexpected suppression: ${path}`,
      );
      assert.deepEqual(
        allowed[legacyRule],
        { count: actual.length },
        `Stale or expanded suppression: ${path}`,
      );
    } else {
      assert.deepEqual(allowed, {}, `Prune native suppressions first: ${path}`);
    }
    if (!prune)
      assert.deepEqual(
        actual,
        expected,
        `New or stale baseline finding: ${path}`,
      );
    if (!prune)
      assert.deepEqual(
        actualContexts,
        [...entry.context_fingerprints].sort(),
        `New or stale baseline context: ${path}`,
      );
    if (actual.length)
      current.entries[path] = {
        ...entry,
        fingerprints: actual,
        context_fingerprints: actualContexts,
      };
  }
  assertOnlyShrinks(policy, current);
  return current;
}

function committedPolicies(root) {
  root = realpathSync(root);
  let repository;
  try {
    repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [];
  }
  const path = relative(repository, resolve(root, policyName))
    .split("\\")
    .join("/");
  const policies = [];
  for (const ref of ["HEAD", "HEAD^"]) {
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Exported snapshots and the adoption commit have no earlier baseline.
      continue;
    }
    policies.push(JSON.parse(bytes));
  }
  return policies;
}

export function assertHistoryOnlyShrinks(current, root = packageRoot) {
  for (const previous of committedPolicies(root))
    assertOnlyShrinks(previous, current);
}

async function main() {
  const args = process.argv.slice(2);
  assert(
    args.length === 0 || (args.length === 1 && args[0] === "--prune"),
    "Usage: node scripts/lint-baseline.mjs [--prune]",
  );
  const prune = args[0] === "--prune";
  const policy = JSON.parse(
    await readFile(resolve(packageRoot, policyName), "utf8"),
  );
  const suppressions = JSON.parse(
    await readFile(resolve(packageRoot, suppressionsName), "utf8"),
  );
  const results = await new ESLint({ cwd: packageRoot }).lintFiles(["."]);
  const findings = findingsFromResults(results);
  const current = checkBaseline(findings, suppressions, policy, { prune });
  assertHistoryOnlyShrinks(current);
  if (prune) {
    for (const [name, data] of [
      [policyName, current],
      [suppressionsName, suppressions],
    ])
      await writeFile(
        resolve(packageRoot, name),
        await format(JSON.stringify(data), { parser: "json" }),
      );
  }
  console.log(
    `lint baseline: PASS (${findings.length} reviewed findings; ${Object.keys(current.entries).length} cleanup entries; no new or stale allowances)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
