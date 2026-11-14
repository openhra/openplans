import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// scripts/source-mutation.mjs rewrites a planted mutant's relative imports to file URLs. Vitest 5
// maps a relative `.js` import to the `.ts` source beside it, but not a `.js` file URL.
const fileUrlSources: Plugin = {
  name: "openplans-file-url-sources",
  enforce: "pre",
  resolveId(id) {
    if (!id.startsWith("file://")) return null;
    const path = fileURLToPath(id);
    if (!path.endsWith(".js") || existsSync(path)) return null;
    const source = `${path.slice(0, -3)}.ts`;
    return existsSync(source) ? source : null;
  },
};

// Test files run in parallel worker processes. Several test runs often share one machine, so one
// run takes a third of the CPUs, at most 3 workers, and 1 worker below 6 CPUs.
// OPENPLANS_TEST_WORKERS=<n> sets the count; 1 runs the files one at a time.
export function testWorkers(
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number {
  const value = env.OPENPLANS_TEST_WORKERS;
  if (value !== undefined && value !== "") {
    if (!/^[1-9][0-9]*$/.test(value))
      throw new Error(
        `OPENPLANS_TEST_WORKERS must be a positive whole number, got '${value}'`,
      );
    return Number(value);
  }
  return Math.max(1, Math.min(3, Math.floor(cpus / 3)));
}

export default defineConfig({
  plugins: [fileUrlSources],
  test: {
    include: [
      "tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "plugins/*/tests/**/*.test.ts",
    ],
    setupFiles: ["tests/response-columns.setup.ts"],
    pool: "forks",
    maxWorkers: testWorkers(),
    // Vitest 5 clears mock calls before every test by default; keep them as earlier versions did.
    clearMocks: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
