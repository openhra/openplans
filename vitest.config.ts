import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import TimedSequencer from "./scripts/test-sequencer.js";

// A slower or busier host (the hosted macOS runner) sets GATE_LOAD_FACTOR, for example 2, to scale
// every test and hook timeout. Unset means 1.
const loadFactor = Number(process.env.GATE_LOAD_FACTOR || "1");
if (!Number.isFinite(loadFactor) || loadFactor < 1 || loadFactor > 10)
  throw new Error("GATE_LOAD_FACTOR must be a number from 1 to 10");

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

// These files rebuild the complete host module graph or scan an optional large SQLite cache.
// Run them without sibling workers competing for CPU and I/O, keeping their original timeouts.
export const isolatedOracles = [
  "tests/plugins/passthrough-wiring.test.ts",
  "tests/oracle/harness.test.mjs",
];

export default defineConfig({
  plugins: [fileUrlSources],
  test: {
    setupFiles: [
      "tests/postgres.setup.ts",
      "tests/response-columns.setup.ts",
      "tests/no-network.setup.ts",
    ],
    pool: "forks",
    maxWorkers: testWorkers(),
    // Vitest 5 clears mock calls before every test by default; keep them as earlier versions did.
    clearMocks: false,
    sequence: { sequencer: TimedSequencer },
    projects: [
      {
        extends: true,
        test: {
          name: "parallel",
          include: [
            "tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
            "plugins/*/tests/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, ...isolatedOracles],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "isolated-oracles",
          include: isolatedOracles,
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    testTimeout: 20_000 * loadFactor,
    hookTimeout: 30_000 * loadFactor,
  },
});
