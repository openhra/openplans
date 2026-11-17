/** Reuse independent source audits without modifying them or opening a persistent database. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rebaseImports } from "../../../scripts/source-mutation.mjs";
import { dataDirectory } from "../../../dist/config/access.js";

const result = join(dataDirectory(), "work/gvi1/filed-realdata.jsonl");
await mkdir(join(dataDirectory(), "work/gvi1"), { recursive: true });
await writeFile(result, "");
const directory = await mkdtemp(
  fileURLToPath(new URL("../../../dist/.compare-filed-", import.meta.url)),
);
try {
  for (const state of ["ny-identity", "vt-metal"]) {
    const original = new URL(
      `../../../src/ingest/state/${state}check.mjs`,
      import.meta.url,
    );
    let source = rebaseImports(await readFile(original, "utf8"), original);
    source = source.replace(
      new URL("../../../scripts/oracle/handy-filed.mjs", original).href,
      new URL("./filed-realdata-check.mjs", import.meta.url).href,
    );
    source = source.replace(
      /(?<!["'])import\.meta\.url(?!["'])/g,
      JSON.stringify(original.href),
    );
    const path = join(directory, `${state}.mjs`);
    await writeFile(path, source);
    const run = spawnSync(process.execPath, [path, "--with-lowest"], {
      stdio: "inherit",
    });
    assert.equal(run.status, 0, `${state} failed`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("PASS: NY/VT comparison source audits");
