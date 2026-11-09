import { format } from "prettier";
import { expect, it } from "vitest";
import { rebaseImports, replaceSyntax } from "./source-mutation.js";

it("matches the same mutation across quotes, comments, wrapping and trailing commas", async () => {
  const source =
    "const value = call('synthetic', /* retained outside mutation */ [first, second]);";
  for (const candidate of [
    source,
    await format(source, { parser: "typescript", printWidth: 20 }),
  ]) {
    const mutant = replaceSyntax(
      candidate,
      "call('synthetic', [first, second])",
      "false",
    );
    expect(mutant).toMatch(/^const\s+value\s*=\s*false;\s*$/);
  }
});

it("rejects missing, ambiguous, empty and unchanged mutation targets", () => {
  for (const [source, before, after] of [
    ["const x = true;", "false", "true"],
    ["const x = true, y = true;", "true", "false"],
    ["const x = true;", "/* comment */", "false"],
    ["const x = true;", "true", "true"],
  ])
    expect(() => replaceSyntax(source!, before!, after!)).toThrow();
  expect(() => replaceSyntax('const x = "a b";', '"ab"', "false")).toThrow();
});

it("finds targets after nested template literals and regular expressions", async () => {
  const source =
    "const template = `outer ${`inner ${value}`} tail`; const pattern = /[a-z]+/i; const enabled = true;";
  for (const candidate of [
    source,
    await format(source, { parser: "typescript" }),
  ]) {
    expect(
      replaceSyntax(candidate, "enabled = true", "enabled = false"),
    ).toContain("enabled = false");
  }
});

it("rebases parsed module specifiers in original and formatted modules without rewriting data strings", async () => {
  const source =
    "import { a } from './a.js'; export { b } from './b.js'; const data = './a.js';";
  for (const candidate of [
    source,
    await format(source, { parser: "typescript" }),
  ]) {
    const result = rebaseImports(
      candidate,
      new URL("file:///synthetic/module.js"),
    );
    expect(result).toContain('from "file:///synthetic/a.js"');
    expect(result).toContain('from "file:///synthetic/b.js"');
    expect(result).toMatch(/const data = ['"]\.\/a.js['"]/);
  }
});
