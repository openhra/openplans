#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The standard tests assert syntax-error rollback and external-import rejection.
npm run build
npm test -- tests/migrate.test.ts tests/worker.test.ts tests/extraction.test.ts

# A full disposable package copy proves that a failed test cannot print CI PASS.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/openplans-negative.XXXXXX")"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT
node --input-type=module - "$PWD" "$scratch" <<'JS'
import { cp } from "node:fs/promises";
import { basename, join } from "node:path";

const [source, destination] = process.argv.slice(2);
const generated = new Set([
  "node_modules", "dist", "coverage", ".git", ".claude-plan",
  ".venv", "venv", "__pycache__", ".vercel", ".lanes",
]);
await cp(source, destination, {
  recursive: true,
  filter(path) {
    const name = basename(path);
    return !generated.has(name) &&
      (!name.toLowerCase().startsWith(".env") || path === join(source, ".env.example"));
  },
});
JS
# Share only dependencies; the boundary checker deliberately rejects symlinks
# outside the package except ignored generated node_modules.
ln -s "$PWD/node_modules" "$scratch/node_modules"
cat > "$scratch/tests/ci-mutant.test.ts" <<'EOF'
import { it, expect } from "vitest";
it("deliberate CI negative control", () => expect(true).toBe(false));
EOF
set +e
"$scratch/scripts/ci.sh" > "$scratch/ci.log" 2>&1
code=$?
set -e
# Test output may contain bare PASS lines from fixtures; CI's own verdict is its last line.
if [ "$code" -eq 0 ] || [ "$(tail -n 1 "$scratch/ci.log")" = 'PASS' ]; then
  echo 'FAIL: CI accepted deliberately failing test'
  exit 1
fi
if ! grep -q 'deliberate CI negative control' "$scratch/ci.log"; then
  cat "$scratch/ci.log"
  echo 'FAIL: negative control did not reach the deliberately failing test'
  exit 1
fi
echo "negative control: failing test -> CI exit $code, no final PASS"
echo 'PASS: negative controls'
