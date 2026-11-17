// Synthetic transport digests only. Historical disabled-state fixtures are never written.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "plugins/handy/tests/public.test.ts",
    "-t",
    "records separate enabled-response digests",
  ],
  {
    cwd: root,
    env: { ...process.env, RECORD_STIPEND_ON: "1" },
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
