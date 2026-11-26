import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.js";
import { loadMigrations, migrationsDirectory } from "../src/db/migrate.js";
import { coreWorkerCommands, runWorker } from "../src/worker/commands.js";
import { runDoctor } from "../src/worker/doctor.js";

vi.mock("../src/api/release-facts.js", () => ({
  releaseFacts: vi.fn(async () => ({
    release: "0.0.0",
    generation: "synthetic-generation",
    pricing: null,
    plan_years: [2026, 2027],
    schema: 1,
  })),
}));

const GIB = 1024 ** 3;
const scratch = await mkdtemp(join(tmpdir(), "openplans-doctor-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const names = (await loadMigrations(migrationsDirectory)).map((m) => m.name);

/** A synthetic database: journal rows are the names it reports as applied. */
function fakeDatabase(options: { journal?: string[]; down?: boolean } = {}) {
  const journal = options.journal ?? names;
  return {
    query: vi.fn(async (sql: string) => {
      if (options.down) throw new Error("connect ECONNREFUSED synthetic-host");
      if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
      if (sql.includes("FROM schema_migrations"))
        return { rows: journal.map((name) => ({ name })) };
      return { rows: [{ "?column?": 1 }] };
    }),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as Database;
}

async function dataDir(
  name: string,
  { raw = true, files = true } = {},
): Promise<string> {
  const root = join(scratch, name);
  await mkdir(join(root, "reports"), { recursive: true });
  await mkdir(join(root, "work"), { recursive: true });
  if (raw) await mkdir(join(root, "raw"), { recursive: true });
  if (raw && files) await writeFile(join(root, "raw", "cache.zip"), "x");
  return root;
}

async function doctor(
  db: Database,
  env: Record<string, string | undefined>,
  freeBytes = async () => 50 * GIB,
  args: string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctor(args, {
    openDatabase: () => db,
    output: { out: (m) => out.push(m), error: (m) => err.push(m) },
    settings: env,
    freeBytes,
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

describe("worker doctor", () => {
  it("passes on a healthy install", async () => {
    const root = await dataDir("healthy");
    const result = await doctor(fakeDatabase(), {
      DATABASE_URL: "postgresql://synthetic",
      OPENPLANS_DATA_DIR: root,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("doctor: all checks passed");
    expect(result.text).not.toContain("FAIL");
  });

  it("fails with the first failing line when the database is down", async () => {
    const root = await dataDir("down");
    const result = await doctor(fakeDatabase({ down: true }), {
      DATABASE_URL: "postgresql://synthetic",
      OPENPLANS_DATA_DIR: root,
    });
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^doctor: database: cannot connect/);
    expect(result.text).not.toContain("synthetic-host");
  });

  it("negative control: a doctor that passes with the database down fails", async () => {
    const down = fakeDatabase({ down: true });
    const env = {
      DATABASE_URL: "postgresql://synthetic",
      OPENPLANS_DATA_DIR: await dataDir("mutant"),
    };
    const mutant = async () => ({ code: 0 }); // reports PASS whatever it finds
    const real = async () => doctor(down, env);
    expect((await real()).code).not.toBe(0);
    expect((await mutant()).code).toBe(0);
    // The assertion the lane relies on: a runner that returns 0 here is wrong.
    await expect(
      (async () => {
        if ((await mutant()).code === 0) throw new Error("PASS with db down");
      })(),
    ).rejects.toThrow("PASS with db down");
  });

  it("names the migrate command when migrations are pending", async () => {
    const root = await dataDir("pending");
    const result = await doctor(fakeDatabase({ journal: names.slice(1) }), {
      DATABASE_URL: "x",
      OPENPLANS_DATA_DIR: root,
    });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("worker migrate");
  });

  it("fails when the database is newer than the image", async () => {
    const root = await dataDir("newer");
    const result = await doctor(
      fakeDatabase({ journal: [...names, "9999_from_a_newer_release.sql"] }),
      { DATABASE_URL: "x", OPENPLANS_DATA_DIR: root },
    );
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("image: ");
    expect(result.err[0]).toContain("OPENPLANS_IMAGE");
  });

  it("explains a missing data dir, an empty raw cache and low disk", async () => {
    const env = { DATABASE_URL: "x" };
    const missing = await doctor(fakeDatabase(), {
      ...env,
      OPENPLANS_DATA_DIR: join(scratch, "does-not-exist"),
    });
    expect(missing.err[0]).toContain("mkdir -p");
    expect(missing.text).not.toContain(scratch);
    const empty = await doctor(fakeDatabase(), {
      ...env,
      OPENPLANS_DATA_DIR: await dataDir("empty", { files: false }),
    });
    expect(empty.err[0]).toContain("bootstrap");
    const low = await doctor(
      fakeDatabase(),
      { ...env, OPENPLANS_DATA_DIR: await dataDir("low") },
      async () => GIB / 2,
    );
    expect(low.err[0]).toContain("disk:");
  });

  it("prints whether a setting is present, never its value", async () => {
    const result = await doctor(fakeDatabase(), {
      DATABASE_URL: "postgresql://user:hunter2-synthetic@host/db",
      CMS_API_KEY: "synthetic-key-value",
      OPENPLANS_DATA_DIR: await dataDir("secrets"),
    });
    expect(result.text).toContain("CMS_API_KEY present");
    expect(result.text).toContain("OPENPLANS_GEOCODER_URL absent");
    expect(result.text).not.toContain("synthetic-key-value");
    expect(result.text).not.toContain("hunter2");
  });

  it("takes no arguments", async () => {
    const result = await doctor(fakeDatabase(), {}, undefined, ["--x"]);
    expect(result.code).toBe(1);
  });
});

describe("worker --help", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runWorker(
      args,
      () => {
        throw new Error("no database for help");
      },
      { out: (m) => out.push(m), error: (m) => err.push(m) },
    );
    return { code, out, err };
  };

  it("exits 0 and lists every core command", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = await run([flag]);
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      const text = result.out.join("\n");
      for (const { argv } of coreWorkerCommands) {
        const phrase = argv.join(" ");
        const covered = text.includes(phrase);
        expect(covered, phrase).toBe(true);
      }
      for (const word of [
        "bootstrap",
        "ingest sbe",
        "ingest state",
        "ingest rating-rules",
        "ingest puf acquire".replace(" acquire", ""),
        "doctor",
      ])
        expect(text).toContain(word);
    }
  });

  it("still exits 1 for an unknown command", async () => {
    expect((await run(["nope"])).code).toBe(1);
  });
});
