# Formatting and lint tools

Use the Node and npm versions in `.node-version` and `.github/npm-version`.
Run `npm ci` once with network access to install the locked development tools.
Later CI runs stay offline. No configuration imports a parent directory.

| Tool                   | Version |
| ---------------------- | ------- |
| Prettier               | 3.9.10  |
| ESLint and @eslint/js  | 9.39.5  |
| typescript-eslint      | 8.72.1  |
| eslint-config-prettier | 10.1.8  |
| globals                | 17.14.0 |
| TypeScript             | 5.9.3   |

Run these commands from the package root:

```sh
npm run format:check
npm run lint
npm run check:lint-setup
```

`scripts/ci.sh` runs format checking, lint and the tooling negative controls before
TypeScript checks, builds and tests. It uses the locked tools and stays offline
after the npm cache has been primed.

`npm run format` writes formatting changes across selected files in the package.
For a focused edit, run the installed formatter on that file with
`--ignore-path .prettierignore`. Keep whole-tree formatting in its own mechanical
commit. Prettier uses its defaults from `.prettierrc.json`, including Markdown
`proseWrap: preserve`. It does not reflow prose paragraphs. Handwritten JSON
configuration stays selected; lockfiles and payload JSON do not.

ESLint uses the JavaScript recommended rules, the ordinary TypeScript recommended
preset for TypeScript files, and `eslint-config-prettier/flat` last. The two extra
rules are `no-nested-ternary` and `@typescript-eslint/consistent-type-imports`.
There is no typed lint pass. Code runs in Node with ESM parsing, with CommonJS
parsing for `.cjs` and `.cts` files. Tests import their test symbols; no test or
browser globals are enabled. Unused disable comments are errors.
Unused callback parameters start with `_`;
rest destructuring may discard named fields. Other unused bindings fail lint.
TypeScript also checks unused locals and parameters. Future browser
scripts need their own scoped configuration.

## Finite lint baseline

The initial baseline contains 228 `@typescript-eslint/no-explicit-any` findings in
27 test files. Production source has no allowances. Parser failures, undefined
runtime references, nested ternaries and incorrect type imports cannot enter the
baseline.

`eslint-suppressions.json` uses ESLint's native file/rule counts. The companion
`eslint-baseline.json` records a cleanup task for each file and a SHA-256 hash of
each affected statement and its function context. `scripts/lint-baseline.mjs`
checks the counts and hashes against the actual lint results. Identical statements in different tests have
different context hashes. A new finding, a same-count replacement or an
unused allowance fails. Only documented control-character validators may use
inline exceptions; other inline suppressions fail the policy check.

The checker also compares the policy with `HEAD` and its first parent when those
versions exist. Increasing an allowance or replacing a statement hash fails even
when the policy change has already been committed. An exported snapshot needs no
Git metadata. It still checks every statement/context hash, count and cleanup entry; the
source gate checks history before export.

Fix the unchecked types in a touched function rather than refreshing its hashes.
After removing old findings, prune both files:

```sh
npm run lint:prune
npm run lint
```

Pruning accepts only a subset of the recorded statement and context hashes. It
cannot add allowances. The normal lint command requires an exact match and never rewrites
the baseline. Run `npm run check:lint-setup` to exercise the negative controls for
new findings, same-count replacements, stale allowances, baseline growth,
committed growth, moved statements and inline bypasses.

## Protected files and fixture sources

`.prettierignore` protects all fixture payloads under any `fixtures/` directory,
JSON evidence under `tests/`, snapshots, the generated subsidy registry, lockfiles,
imported scaffold assets/documents, internal plans and research. It also protects
legal documents and entire mixed pages that contain publisher terms. Legal text
stays outside formatting and prose review. Fixture source files with JavaScript,
TypeScript or Python extensions remain outside the payload exclusion. Prettier
formats supported extensions. ESLint selects the JavaScript and TypeScript
helpers; Python is outside this linter's scope.

Capture a hash manifest outside the package before mechanical formatting, then
compare it afterward. Use the same tree for both commands:

```sh
node scripts/format-inventory.mjs snapshot /tmp/openplans-protected.json
npm run format
node scripts/format-inventory.mjs check /tmp/openplans-protected.json
```

The inventory lists protected file hashes and every fixture source path. It skips
dependencies, build output and local environment/tool state. It refuses a selected
payload or ignored fixture source. Comparing manifests
also detects additions, deletions and changes in source selection. Keep the
migration manifest with the release evidence, outside the source package. Capture
a fresh manifest after concurrent fixture work has merged and before F2 starts.

`npm run check:lint-setup` checks the current fixture inventory and uses disposable
synthetic examples. It requires rejection of an undefined JavaScript reference,
a value import used only as a type, a nested ternary, a stale disable comment,
a browser global in Node code, unformatted source and a reformatted payload.
It never formats existing source or payloads.

## Editors and blame

Use the package's installed Prettier and ESLint binaries. Enable format-on-save
only when the editor honors the package's `.prettierignore`; point the Prettier
extension's ignore path at that file. Keep prose soft wrap enabled. Do not enable
a separate formatter on ignored legal, fixture or generated files. The root
`.editorconfig` uses UTF-8, LF, two spaces, four spaces for Python, final newlines
and preserved Markdown hard breaks. It sets no maximum line length.

The root `.editorconfig`, formatter and linter configuration export unchanged.
Scaffold mappings cannot override runtime or tool configuration.

The source `.git-blame-ignore-revs` records the formatting and mechanical lint
commits. Use it locally without changing global Git settings:

```sh
git blame --ignore-revs-file .git-blame-ignore-revs -- src/api/app.ts
```

That file is excluded from public snapshots because source commit IDs do not
identify public commits. The release ledger must map each source mechanical
commit to its public commit before publishing a public blame file.
