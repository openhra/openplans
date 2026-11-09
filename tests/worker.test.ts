import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../src/worker/commands.js";
import { coreMigrations, testDatabase } from "./pglite.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("worker CLI", () => {
  it.each([[], ["unknown"], ["status", "extra"], ["ingest", "other"]])(
    "rejects invalid arguments %j",
    (...args) => {
      const result = spawnSync(
        process.execPath,
        ["dist/worker/cli.js", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: "" },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: worker");
      expect(result.stdout).toBe("");
    },
  );

  it.each(["puf", "qhp"])(
    "rejects unimplemented ingest %s without connecting",
    (kind) => {
      const result = spawnSync(
        process.execPath,
        ["dist/worker/cli.js", "ingest", kind],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: "" },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not implemented");
    },
  );

  it("requires DATABASE_URL and does not expose driver or credential errors", () => {
    const result = spawnSync(
      process.execPath,
      ["dist/worker/cli.js", "migrate"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worker migrate failed");
    expect(result.stderr).not.toContain("Error:");
  });

  it("dispatches migrate twice and status against the database", async () => {
    const pg = new PGlite();
    const db = testDatabase(pg);
    const core = await coreMigrations();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = {
      out: (message: string) => stdout.push(message),
      error: (message: string) => stderr.push(message),
    };
    const open = () => ({ ...db, close: async () => {} });
    try {
      expect(await runWorker(["migrate"], open, output, core.directory)).toBe(
        0,
      );
      expect(JSON.parse(stdout[0]!)).toEqual({
        applied: (await readdir(core.directory))
          .filter((name) => name.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      });
      expect(await runWorker(["migrate"], open, output, core.directory)).toBe(
        0,
      );
      expect(JSON.parse(stdout[1]!)).toEqual({ applied: [] });
      expect(await runWorker(["status"], open, output)).toBe(0);
      expect(JSON.parse(stdout[2]!)).toEqual([]);
      expect(stderr).toEqual([]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });

  it("negative control: a syntax error makes the runner command fail and records nothing", async () => {
    const pg = new PGlite();
    const db = testDatabase(pg);
    const directory = await mkdtemp(join(tmpdir(), "openplans-broken-"));
    const errors: string[] = [];
    try {
      await writeFile(
        join(directory, "001_broken.sql"),
        "CREATE TABLE transient (id integer); INVALID SQL;",
      );
      const code = await runWorker(
        ["migrate"],
        () => ({ ...db, close: async () => {} }),
        {
          out: () => {
            throw new Error("Broken migration must not succeed");
          },
          error: (message) => errors.push(message),
        },
        directory,
      );
      expect(code).toBe(1);
      expect(errors[0]).toContain("worker migrate failed");
      expect(
        (
          await pg.query(
            "SELECT to_regclass('schema_migrations') AS journal, to_regclass('transient') AS table_name",
          )
        ).rows,
      ).toEqual([{ journal: null, table_name: null }]);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrate opens the database with a long query timeout, keeping an explicit operator value", async () => {
    const pg = new PGlite();
    const db = testDatabase(pg);
    const core = await coreMigrations();
    const seen: (string | undefined)[] = [];
    const open = (connection?: string) => {
      seen.push(connection);
      return { ...db, close: async () => {} };
    };
    const output = { out: () => {}, error: () => {} };
    const previous = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL =
        "postgresql://user:secret@127.0.0.1:5432/openplans";
      expect(await runWorker(["migrate"], open, output, core.directory)).toBe(
        0,
      );
      process.env.DATABASE_URL =
        "postgresql://user:secret@127.0.0.1:5432/openplans?query_timeout=900000";
      expect(await runWorker(["migrate"], open, output, core.directory)).toBe(
        0,
      );
      expect(await runWorker(["status"], open, output)).toBe(0);
      expect(
        seen.map(
          (url) => url && new URL(url).searchParams.get("query_timeout"),
        ),
      ).toEqual(["3600000", "900000", undefined]);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await db.close();
      await core.cleanup();
    }
  });
});
