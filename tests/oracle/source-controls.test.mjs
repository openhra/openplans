import { readFile } from "node:fs/promises";
import { format } from "prettier";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  mutateSource,
  sourceControls,
} from "../../scripts/oracle/source-controls.mjs";
import {
  rebaseImports,
  replaceSyntax,
} from "../../scripts/source-mutation.mjs";

it.each(Object.entries(sourceControls))(
  "%s control finds exactly one target in current source and compiled formatter variants",
  async (_name, control) => {
    const source = await readFile(
      new URL(`../../src/${control.path}.ts`, import.meta.url),
      "utf8",
    );
    const compiled = await readFile(
      new URL(`../../dist/${control.path}.js`, import.meta.url),
      "utf8",
    );
    for (const input of [source, compiled]) {
      for (const candidate of [
        input,
        await format(input, { parser: "typescript", printWidth: 40 }),
        await format(input, {
          parser: "typescript",
          singleQuote: true,
          trailingComma: "none",
          printWidth: 120,
        }),
      ]) {
        const mutant = mutateSource(candidate, control);
        expect(mutant).not.toBe(candidate);
        expect(
          ts.createSourceFile("mutant.ts", mutant, ts.ScriptTarget.Latest)
            .parseDiagnostics,
        ).toEqual([]);
        // A target removed by a code change must fail before loading data.
        const missing = replaceSyntax(
          candidate,
          control.before,
          "/* removed target */",
        );
        expect(() => mutateSource(missing, control)).toThrow(
          "Mutation target must match exactly once",
        );
        // A newly ambiguous target must also stop the control.
        expect(() =>
          mutateSource(candidate + "\n" + candidate, control),
        ).toThrow("Mutation target must match exactly once");
      }
    }
  },
);

it("rebases every relative import in the compiled CSR control before loading its disposable module", async () => {
  const path = new URL("../../dist/api/validation.js", import.meta.url);
  const source = await readFile(path, "utf8");
  for (const singleQuote of [true, false]) {
    const formatted = await format(source, { parser: "babel", singleQuote });
    const mutant = rebaseImports(
      mutateSource(formatted, sourceControls.csr),
      path,
    );
    const tree = ts.createSourceFile(
      "mutant.js",
      mutant,
      ts.ScriptTarget.Latest,
    );
    const specifiers = tree.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier.text);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((specifier) => !specifier.startsWith("."))).toBe(
      true,
    );
    expect(specifiers.some((specifier) => specifier.startsWith("file:"))).toBe(
      true,
    );
  }
});
