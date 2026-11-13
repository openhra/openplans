import ts from "typescript";

/**
 * A code file or folder whose name says it holds a planted mutant (not one of these
 * helpers), or a `$1` replacement that renames a real file into one.
 */
const MUTANT_FILE =
  /(^|[/._-])mutant(?!-(file|names)\.)[^/]*(\.[cm]?[jt]sx?|\/|\$\d)$/i;
/** Bases that point into the repo rather than at a fresh temp folder. */
const REPO_BASE =
  /\b(root|repo|packageRoot|packageSource|src|dist|here)\b|import\.meta/;
/** Path helpers that resolve under the repo, such as `src("api/x.ts")`. */
const REPO_HELPER = /^(src|dist|at|repo|root)$/;

export interface FixedMutantName {
  line: number;
  text: string;
}

function literalText(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) {
    // A name with the process id in it differs between runs.
    if (
      node.templateSpans.some((span) =>
        /process\.pid/.test(span.expression.getText(file)),
      )
    )
      return undefined;
    return (
      node.head.text +
      node.templateSpans.map((span) => `*${span.literal.text}`).join("")
    );
  }
  return undefined;
}

/**
 * Find mutant files a test writes under a fixed name inside the repo. Two test runs
 * in one checkout would write, import and delete the same file. Plant mutants with
 * tests/mutant-file.ts instead.
 */
export function fixedMutantNames(
  source: string,
  name = "test.ts",
): FixedMutantName[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const found: FixedMutantName[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const text = literalText(node, file);
    if (text !== undefined && MUTANT_FILE.test(text)) {
      const parent = node.parent;
      const call =
        parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))
          ? parent
          : undefined;
      const callee = call?.expression.getText(file) ?? "";
      const args = call?.arguments ?? ts.factory.createNodeArray();
      const index = args.findIndex((arg) => arg === node);
      const fixed =
        text.includes("../") ||
        (call !== undefined &&
          ts.isNewExpression(call) &&
          callee === "URL" &&
          index === 0) ||
        (/^(join|resolve)$/.test(callee.split(".").pop()!) &&
          index > 0 &&
          REPO_BASE.test(args[0]!.getText(file))) ||
        (call !== undefined && REPO_HELPER.test(callee)) ||
        (/\.replace(All)?$/.test(callee) && index === 1);
      if (fixed && !(call && ts.isCallExpression(call) && callee === "import"))
        found.push({
          line:
            file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          text,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
