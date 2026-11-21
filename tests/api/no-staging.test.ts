import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { stagingTables, buildOnlyTables } from "../../src/db/table-classes.js";

const root = fileURLToPath(new URL("../../src/", import.meta.url));
const entries = ["api/app.ts", "services/calculation-worker.ts"].map((p) =>
  resolve(root, p),
);

/** Follow runtime imports so a staging query moved into a shared helper still fails. */
async function stagingReads(overrides = new Map<string, string>()) {
  const pending = [...entries];
  const visited = new Set<string>();
  const offenders: string[] = [];
  const names = new RegExp(
    `\\b(${[...stagingTables, ...buildOnlyTables].join("|")})\\b`,
    "i",
  );
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = overrides.get(path) ?? (await readFile(path, "utf8"));
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      // Type-only imports cannot execute a query.
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        if (names.test(node.getText(tree))) offenders.push(path);
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith(".")) {
          const dependency = resolve(
            dirname(path),
            specifier.replace(/\.js$/, ".ts"),
          );
          if (existsSync(dependency)) pending.push(dependency);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return { offenders: [...new Set(offenders)], visited };
}

describe("API staging boundary", () => {
  it("no API route or transitive query helper names a staging table", async () => {
    const result = await stagingReads();
    expect(result.visited.size).toBeGreaterThan(100);
    expect(result.offenders).toEqual([]);
  });
  it("negative control: a staging read planted in a shared repository is detected", async () => {
    const path = resolve(root, "api/provider-repository.ts");
    const source = await readFile(path, "utf8");
    for (const table of [...stagingTables, ...buildOnlyTables]) {
      const result = await stagingReads(
        new Map([
          [path, `${source}\nconst syntheticRead = "SELECT * FROM ${table}";`],
        ]),
      );
      expect(result.offenders).toContain(path);
    }
  });
});
