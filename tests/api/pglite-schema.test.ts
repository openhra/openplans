import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import * as ready from "../../src/db/schema-ready.js";
import { plantMutantFile } from "../mutant-file.js";
import { testDatabase } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";

const source = new URL("../../src/db/schema-ready.ts", import.meta.url);

describe("PGlite runner refuses an unmigrated database", () => {
  let pg: PGlite;
  let directory: string;
  beforeEach(async () => {
    pg = new PGlite();
    directory = await mkdtemp(join(tmpdir(), "openplans-schema-ready-"));
    // Synthetic migrations: only the journal check is under test.
    await writeFile(join(directory, "1_one.sql"), "CREATE TABLE one (v int);");
    await writeFile(join(directory, "2_two.sql"), "CREATE TABLE two (v int);");
  });
  afterEach(async () => {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function expectChecks(check: typeof ready.unappliedMigrations) {
    const db = testDatabase(pg);
    expect(await check(db, directory)).toEqual(["1_one.sql", "2_two.sql"]);
    expect(
      (
        await pg.query(
          "SELECT to_regclass('public.schema_migrations') IS NULL AS absent",
        )
      ).rows,
    ).toEqual([{ absent: true }]);
    await migrate(db, directory);
    expect(await check(db, directory)).toEqual([]);
    await writeFile(join(directory, "3_three.sql"), "SELECT 1;");
    expect(await check(db, directory)).toEqual(["3_three.sql"]);
  }

  it("lists every file before migrate and only new files after", async () => {
    await expectChecks(ready.unappliedMigrations);
  });

  it("rejects a planted copy that treats a missing journal as migrated", async () => {
    const mutated = replaceSyntax(
      await readFile(source, "utf8"),
      "if (!journal[0]?.present) return files.map(({ name }) => name);",
      "if (!journal[0]?.present) return [];",
    );
    const mutant = await plantMutantFile(source, mutated);
    try {
      const planted = (await import(mutant.url.href)) as typeof ready;
      await expect(expectChecks(planted.unappliedMigrations)).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("stops the built runner before it serves a new database", async () => {
    const result = spawnSync(process.execPath, ["dist/api/pglite.js"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        OPENPLANS_CONFIG: "",
        OPENPLANS_PLUGINS: "",
        OPENPLANS_PGLITE_DIR: join(directory, "db"),
        PORT: "43292",
      },
      encoding: "utf8",
      timeout: 60000,
    });
    expect(result.stderr).toBe(
      "The PGlite database has unapplied migrations; run `npm run api:pglite -- migrate` first\n",
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  }, 70000);
});
