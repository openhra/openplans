#!/usr/bin/env node
/**
 * After the initial recording, regenerate only when a lane brief explicitly
 * authorizes a response change.
 * Never update these files just to make a regression test pass.
 * Run from any directory: node scripts/plugins/record-digests.mjs
 * Uses the same Vitest replay as CI, with fixed JS/SQL clocks, import IDs and cursor secret.
 * Existing API fixture cuts are reused; requests and credentials are synthetic.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/plugins/byte-identical.test.ts",
  ],
  {
    cwd: root,
    env: { ...process.env, OPENPLANS_RECORD_DIGESTS: "1" },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
