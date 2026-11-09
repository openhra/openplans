import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("requires ISSUER_TAR before reading the cache or changing any fixtures", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-provider-regenerate-"),
  );
  const fixtures = fileURLToPath(
    new URL("../../fixtures/qhp/provider/", import.meta.url),
  );
  async function hashes() {
    const names = (await readdir(fixtures)).sort();
    return Promise.all(
      names.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(fixtures, name)))
          .digest("hex"),
      ]),
    );
  }
  try {
    const before = await hashes();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENPLANS_DATA_DIR: join(directory, "absent-cache"),
    };
    delete env.ISSUER_TAR;
    const error = await promisify(execFile)(
      process.execPath,
      [join(fixtures, "regenerate.mjs")],
      { cwd: directory, env },
    ).catch((error) => error);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("Usage: ISSUER_TAR=");
    expect(error.stdout).toBe("");
    expect(await readdir(directory)).toEqual([]);
    expect(await hashes()).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
