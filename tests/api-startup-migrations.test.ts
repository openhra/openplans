import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import ts from "typescript";

function migrationImports(source: string): string[] {
  const tree = ts.createSourceFile(
    "startup.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return tree.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        /\/db\/migrate(?:\.js)?$/.test(node.moduleSpecifier.text),
    )
    .flatMap((node) => {
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return ["*"];
      return bindings.elements.map((e) => (e.propertyName ?? e.name).text);
    })
    .filter((name) => name !== "migrationsDirectory");
}

describe("API startup stays separate from migration jobs", () => {
  it("starts the production API directly in Compose and the image", async () => {
    const compose = await readFile(
      new URL("../compose.yml", import.meta.url),
      "utf8",
    );
    const api = compose.split("\n  api:\n")[1]!.split(/\n {2}[a-z]+:\n/)[0]!;
    expect(api).toMatch(/command: \["node", "dist\/api\/server.js"\]/);
    expect(api).not.toContain("migrate");
    expect(
      await readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    ).toMatch(/CMD \["node", "dist\/api\/server.js"\]/);
    const mutant = api.replace(
      'command: ["node", "dist/api/server.js"]',
      'command: ["sh", "-c", "worker migrate && node dist/api/server.js"]',
    );
    expect(mutant).toContain("migrate");
    expect(mutant).not.toMatch(/command: \["node", "dist\/api\/server.js"\]/);
  });
  it.each(["server.ts", "pglite.ts"])(
    "does not import a migration executor in %s",
    async (name) => {
      const source = await readFile(
        new URL(`../src/api/${name}`, import.meta.url),
        "utf8",
      );
      expect(migrationImports(source)).toEqual([]);
      expect(
        migrationImports(
          source + '\nimport { migrate as onStartup } from "../db/migrate.js";',
        ),
      ).toEqual(["migrate"]);
    },
  );
});
