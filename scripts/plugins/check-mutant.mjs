#!/usr/bin/env node
/** Change one response byte in a disposable source tree, then require a named digest failure. */
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceSyntax } from "../source-mutation.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "openplans-digest-mutant-"));
try {
  for (const path of [
    "src",
    "tests",
    "migrations",
    "data",
    "vitest.config.ts",
    "package.json",
  ])
    await cp(join(root, path), join(temporary, path), { recursive: true });
  await symlink(
    join(root, "node_modules"),
    join(temporary, "node_modules"),
    "dir",
  );
  const path = join(temporary, "src/api/app.ts");
  const source = await readFile(path, "utf8");
  const changed = replaceSyntax(
    source,
    '{ status: "ok", db: healthy ? "ok" : "down" }',
    '{ status: "oK", db: healthy ? "ok" : "down" }',
  );
  if (Buffer.byteLength(changed) !== Buffer.byteLength(source))
    throw new Error("Expected a one-byte replacement");
  await writeFile(path, changed);
  const env = { ...process.env };
  delete env.OPENPLANS_RECORD_DIGESTS;
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/plugins/byte-identical.test.ts",
    ],
    {
      cwd: temporary,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  // A compile error or a failure elsewhere cannot count as detecting the mutant.
  if (
    result.status === 0 ||
    !output.includes(
      "FAIL  tests/plugins/byte-identical.test.ts > byte-identical HTTP > healthz GET /healthz",
    ) ||
    !output.includes("body_sha256")
  )
    throw new Error(
      `Response mutant was not rejected by the named request:\n${output}`,
    );
  console.log(
    "PASS: one-byte healthz response mutant rejected; request healthz GET /healthz named body_sha256",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
