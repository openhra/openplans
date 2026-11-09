#!/usr/bin/env node
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = await realpath(
  process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)),
);
const failures = [];
const outside = (path) => {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
};
function checkPath(file, value, base = dirname(file)) {
  if (value.startsWith("file:")) {
    try {
      value = fileURLToPath(value);
    } catch {
      failures.push(`${relative(root, file)}: invalid file URL`);
      return;
    }
  }
  if (
    isAbsolute(value) ||
    (value.startsWith(".") && outside(resolve(base, value)))
  ) {
    failures.push(`${relative(root, file)}: external path ${value}`);
  }
}

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", ".git", ".claude-plan", "coverage"].includes(
        entry.name,
      ) ||
      (entry.name.startsWith(".env") && entry.name !== ".env.example")
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (outside(await realpath(path)))
        failures.push(`${relative(root, path)}: external symlink`);
      continue;
    }
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name)) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          checkPath(path, node.moduleSpecifier.text);
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument))
            checkPath(path, argument.text);
        }
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(source) === "URL" &&
          node.arguments?.[1]?.getText(source) === "import.meta.url"
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument))
            checkPath(path, argument.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    if (entry.name === "package.json") {
      const pkg = JSON.parse(await readFile(path, "utf8"));
      if (pkg.workspaces)
        failures.push(`${relative(root, path)}: workspace coupling`);
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        for (const value of Object.values(pkg[section] ?? {})) {
          if (value.startsWith("file:") || value.startsWith("link:"))
            checkPath(path, value.slice(5));
        }
      }
    }
    if (entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (config.extends) checkPath(path, config.extends);
      for (const field of ["include", "exclude", "files"]) {
        for (const value of config[field] ?? []) checkPath(path, value);
      }
      for (const reference of config.references ?? [])
        checkPath(path, reference.path);
      const options = config.compilerOptions ?? {};
      for (const field of ["baseUrl", "rootDir", "outDir", "declarationDir"]) {
        if (options[field]) checkPath(path, options[field]);
      }
      for (const values of Object.values(options.paths ?? {})) {
        for (const value of values)
          checkPath(
            path,
            value,
            resolve(dirname(path), options.baseUrl ?? "."),
          );
      }
    }
    // Docs describe the enclosing repository and external data cache by design.
    if (
      !relative(root, path).startsWith("docs/") &&
      !["package-lock.json", "LICENSE"].includes(entry.name)
    ) {
      const content = await readFile(path, "utf8");
      // Also cover literal relative paths in shell commands and build config.
      for (const match of content.matchAll(
        /(?:^|[\s'"`=:(])(\.\.\/[^\s'"`;)\]}]*)/gm,
      )) {
        checkPath(path, match[1]);
      }
    }
  }
}

if (!(await stat(root)).isDirectory())
  throw new Error("Extraction root must be a directory");
await scan(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("extraction: PASS");
}
