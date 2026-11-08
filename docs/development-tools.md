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

The first two commands currently report legacy findings and exit nonzero.
They are available for review but are not called by `scripts/ci.sh` yet.
The formatting migration runs later in an exclusive editing window. Lint fixes
and CI enforcement follow in a separate change. Do not use autofix as part of
the formatting migration.

`npm run format` writes formatting changes. Do not run it across this source tree
until the formatting window is approved. Both format commands explicitly use
`.prettierignore`. Prettier uses its default options from `.prettierrc.json`,
including Markdown `proseWrap: preserve`. It does not reflow prose paragraphs.
Handwritten JSON configuration stays selected; lockfiles and payload JSON do not.

ESLint uses the JavaScript recommended rules, the ordinary TypeScript recommended
preset for TypeScript files, and `eslint-config-prettier/flat` last. The two extra
rules are `no-nested-ternary` and `@typescript-eslint/consistent-type-imports`.
There is no typed lint pass. Code runs in Node with ESM parsing, with CommonJS
parsing for `.cjs` and `.cts` files. Tests import their test symbols; no test or
browser globals are enabled. Unused disable comments are errors. Future browser
scripts need their own scoped configuration.

No suppression file is created in this preparation change. Later lint adoption
can use ESLint's native `eslint-suppressions.json` for reviewed legacy findings.
Each allowance needs a cleanup task. Do not suppress parser failures, undefined
runtime references or test failures. Remove relevant allowances when editing a
function, prune stale entries, and review replacements that keep the same count.

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

The current export mapping still overlays `.editorconfig` from the imported
scaffold. That copy has the same general settings but lacks the Python override.
Reconcile the mapping and its import-contract test in the export lane before
claiming editor parity for the public tree. The formatter and linter configs
already live at the package root and export without parent dependencies.

After the formatting-only commit, the enforcement change records its commit ID
in `.git-blame-ignore-revs`. Use it locally without changing global Git settings:

```sh
git blame --ignore-revs-file .git-blame-ignore-revs -- src/api/app.ts
```

Public squash commits have different IDs. The release ledger must map the source
formatting commit to the public formatting commit. Export the public ID list in a
later metadata release; never copy private commit IDs into the public blame file.
