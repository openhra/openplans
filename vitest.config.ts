import { existsSync } from "node:fs";
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

export default defineConfig({
  plugins: [fileUrlSources],
  test: {
    include: [
      "tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "plugins/*/tests/**/*.test.ts",
    ],
    setupFiles: ["tests/response-columns.setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    // Vitest 5 clears mock calls before every test by default; keep them as earlier versions did.
    clearMocks: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
