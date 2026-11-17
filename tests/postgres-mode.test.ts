import type * as Crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { PGlite as Postgres } from "./postgres.js";
import { coreMigrations } from "./pglite.js";
import { readFile, readdir } from "node:fs/promises";
import { importMutant, withMutantFile } from "./mutant-file.js";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof Crypto>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

const savedUrl = process.env.OPENPLANS_POSTGRES_TEST_URL;
const savedContainer = process.env.OPENPLANS_POSTGIS_CONTAINER;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.OPENPLANS_POSTGRES_TEST_URL;
  else process.env.OPENPLANS_POSTGRES_TEST_URL = savedUrl;
  if (savedContainer === undefined)
    delete process.env.OPENPLANS_POSTGIS_CONTAINER;
  else process.env.OPENPLANS_POSTGIS_CONTAINER = savedContainer;
});

it.each([
  [
    "postgres://synthetic@127.0.0.1:1/production",
    "openplans-fa14-nightly-synthetic",
  ],
  [
    "postgres://synthetic@127.0.0.2:1/openplans_nightly",
    "openplans-fa14-nightly-synthetic",
  ],
  ["postgres://synthetic@127.0.0.1:1/openplans_nightly", "openplans-public"],
])(
  "negative control: refuses an unsafe nightly target %s in %s",
  async (url, container) => {
    process.env.OPENPLANS_POSTGRES_TEST_URL = url;
    process.env.OPENPLANS_POSTGIS_CONTAINER = container;
    await expect(new Postgres().query("SELECT 1")).rejects.toThrow(
      "disposable nightly",
    );
  },
);

it.runIf(process.env.OPENPLANS_TEST_DB === "postgres")(
  "uses PostgreSQL and includes the PostGIS migration",
  async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const core = await coreMigrations();
    try {
      const result = await db.query<{ version: string }>("SELECT version()");
      expect(result.rows[0]?.version).toContain("PostgreSQL");
      expect(result.rows[0]?.version).not.toContain("PGlite");
      expect(await readdir(core.directory)).toContain("002_postgis.sql");
      await db.exec("CREATE EXTENSION postgis");
      expect(
        (await db.query("SELECT postgis_version() AS version")).rows[0],
      ).toHaveProperty("version");
    } finally {
      await db.close();
      await core.cleanup();
    }
  },
);

async function checkIsolation(Backend: typeof Postgres) {
  const db = new Backend();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tx: Promise<void> | undefined;
  try {
    await db.exec("CREATE TABLE synthetic_transaction (value integer)");
    tx = db.transaction(async (session) => {
      await session.exec("INSERT INTO synthetic_transaction VALUES (1)");
      enter();
      await held;
    });
    await entered;
    let answered = false;
    const outside = db
      .query("SELECT count(*)::int AS n FROM synthetic_transaction")
      .then((result) => {
        answered = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Negative control: a shared unpinned client would answer from inside the transaction.
    expect(answered).toBe(false);
    release();
    await tx;
    expect((await outside).rows).toEqual([{ n: 1 }]);
  } finally {
    release?.();
    try {
      await tx;
    } finally {
      await db.close();
    }
  }
}

it.runIf(process.env.OPENPLANS_TEST_DB === "postgres")(
  "keeps an outside query out of an open transaction",
  async () => {
    await checkIsolation(Postgres);
  },
);

it.runIf(process.env.OPENPLANS_TEST_DB === "postgres")(
  "negative control: a second pool connection breaks single-backend isolation",
  async () => {
    const original = new URL("./postgres.ts", import.meta.url);
    const source = await readFile(original, "utf8");
    expect(source).toContain("max: 1");
    await withMutantFile(
      original,
      source.replace("max: 1", "max: 2"),
      async (file) => {
        const mutant = await importMutant<{ PGlite: typeof Postgres }>(
          file,
          "PGlite",
        );
        await expect(checkIsolation(mutant.PGlite)).rejects.toThrow(/expected/);
      },
    );
  },
);

async function checkIdentities(Backend: typeof Postgres) {
  const first = new Backend();
  const second = new Backend();
  try {
    await first.exec("CREATE TABLE synthetic_identity (id integer)");
    await second.exec("CREATE TABLE synthetic_identity (id integer)");
    await first.exec("INSERT INTO synthetic_identity VALUES (1)");
    expect(
      (await second.query("SELECT * FROM synthetic_identity")).rows,
    ).toEqual([]);
  } finally {
    // A colliding backend can fail before opening its connection.
    await Promise.allSettled([first.close(), second.close()]);
  }
}

it.runIf(process.env.OPENPLANS_TEST_DB === "postgres")(
  "keeps fixture database identities independent of application UUID mocks",
  async () => {
    await checkIdentities(Postgres);
  },
);

it.runIf(process.env.OPENPLANS_TEST_DB === "postgres")(
  "negative control: reusing the mocked application identity collides",
  async () => {
    const original = new URL("./postgres.ts", import.meta.url);
    const source = await readFile(original, "utf8");
    expect(source).toContain('randomBytes(16).toString("hex")');
    await withMutantFile(
      original,
      source.replace(
        'randomBytes(16).toString("hex")',
        '"00000000000040008000000000000001"',
      ),
      async (file) => {
        const mutant = await importMutant<{ PGlite: typeof Postgres }>(
          file,
          "PGlite",
        );
        await expect(checkIdentities(mutant.PGlite)).rejects.toThrow(
          /already exists/,
        );
      },
    );
  },
);
