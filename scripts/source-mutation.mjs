import assert from "node:assert/strict";
import ts from "typescript";

function tokens(source) {
  const tree = ts.createSourceFile(
    "mutation.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = [];
  function visit(node) {
    const children = node.getChildren(tree);
    if (children.length) {
      children.forEach(visit);
      return;
    }
    if (node.kind > ts.SyntaxKind.LastToken || node.getWidth(tree) === 0)
      return;
    result.push({
      kind: node.kind,
      value: ts.isStringLiteral(node) ? node.text : node.getText(tree),
      start: node.getStart(tree),
      end: node.end,
    });
  }
  visit(tree);
  // A formatter can add a trailing comma to a list or parameter declaration.
  return result.filter(
    (token, index) =>
      token.kind !== ts.SyntaxKind.CommaToken ||
      ![
        ts.SyntaxKind.CloseParenToken,
        ts.SyntaxKind.CloseBracketToken,
        ts.SyntaxKind.CloseBraceToken,
      ].includes(result[index + 1]?.kind ?? ts.SyntaxKind.Unknown),
  );
}

/** Match syntax tokens, keeping source spelling and trivia outside the replaced span. */
export function replaceSyntax(source, before, after) {
  const input = tokens(source),
    needle = tokens(before);
  assert(needle.length > 0, "Mutation target must contain syntax");
  const matches = input.flatMap((_token, index) =>
    needle.every(
      (expected, offset) =>
        expected.kind === input[index + offset]?.kind &&
        expected.value === input[index + offset]?.value,
    )
      ? [index]
      : [],
  );
  assert.equal(matches.length, 1, "Mutation target must match exactly once");
  const start = matches[0];
  const result =
    source.slice(0, input[start].start) +
    after +
    source.slice(input[start + needle.length - 1].end);
  assert.notEqual(result, source, "Mutation must change the source");
  return result;
}

/** Rebase static relative imports in a disposable module without depending on quotes. */
export function rebaseImports(source, base) {
  const tree = ts.createSourceFile(
    "mutation.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = tree.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      return [];
    const specifier = statement.moduleSpecifier;
    return specifier &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith(".")
      ? [specifier]
      : [];
  });
  for (const specifier of imports.reverse()) {
    source =
      source.slice(0, specifier.getStart(tree)) +
      JSON.stringify(new URL(specifier.text, base).href) +
      source.slice(specifier.end);
  }
  return source;
}
