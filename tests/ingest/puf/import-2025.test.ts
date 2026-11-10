import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { runPufImport } from "../../../src/ingest/puf/import-command.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import type { ImportFile } from "../../../src/ingest/puf/import-source.js";
import { validateImportHeader } from "../../../src/ingest/puf/import-parse.js";

const pg = new PGlite();
const db = testDatabase(pg);
let directory: string;
let core: Awaited<ReturnType<typeof coreMigrations>>;
let files: ImportFile[];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-py2025-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  // Labelled synthetic year substitution of real PY2026 cuts; no PY2025 premiums are claimed.
  files = await Promise.all(
    IMPORT_KINDS.map(async (kind) => {
      const data = Buffer.from(
        (
          await readFile(
            new URL(`../../fixtures/puf/import/${kind}.csv`, import.meta.url),
            "utf8",
          )
        ).replaceAll("2026", "2025"),
      );
      const path = join(directory, `synthetic-2025-${kind}.csv`);
      await writeFile(path, data);
      return {
        kind,
        path,
        format: "csv" as const,
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
        retrievedAt: "2026-11-10T17:10:00Z",
        url: `https://synthetic.example/2025/${kind}.csv`,
      };
    }),
  );
});
afterAll(async () => {
  await db.close();
  await core?.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("imports PY2025 without granting rating support and admits the CLI year", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  // The production cache path is exercised in the real-state proof. Here supply only fixture files.
  const report = await importPufs(db, {
    year: 2025,
    state: "TX",
    files,
    dataDir: directory,
  });
  expect(report.status, JSON.stringify(report)).toBe("ACTIVE");
  expect(
    (
      await db.query(
        "SELECT DISTINCT schema_version FROM snapshot WHERE snapshot_id LIKE $1",
        [`${report.import_id}%`],
      )
    ).rows,
  ).toEqual([{ schema_version: "cms-puf-2025-2027-observed" }]);
  expect((await db.query("SELECT DISTINCT plan_year FROM rate")).rows).toEqual([
    { plan_year: 2025 },
  ]);
  expect(
    (
      await db.query(
        "SELECT DISTINCT method FROM state_rating_rule WHERE plan_year=2025",
      )
    ).rows,
  ).toEqual([{ method: "unsupported" }]);
  let opened = false;
  const code = await runPufImport(
    ["--year", "2025", "--state", "TX"],
    () => {
      opened = true;
      throw new Error("synthetic database failure after argument validation");
    },
    { out: (line) => lines.push(line), error: (line) => errors.push(line) },
    core.directory,
  );
  expect(code).toBe(1);
  expect(opened).toBe(true);
  expect(lines).toEqual([]);
  expect(errors[0]).toContain("worker ingest puf import failed");
});

it.each([2024, 2028])(
  "negative control: refuses unreviewed year %s before opening a database",
  async (year) => {
    let opened = false;
    expect(
      await runPufImport(
        ["--year", String(year), "--state", "TX"],
        () => {
          opened = true;
          return db;
        },
        { out: () => {}, error: () => {} },
      ),
    ).toBe(1);
    expect(opened).toBe(false);
    await expect(
      importPufs(db, { year, state: "TX", files, dataDir: directory }),
    ).rejects.toThrow("Invalid PUF import scope");
  },
);

it("validates all observed PY2025 headers and rejects a renamed critical column", async () => {
  const audit = JSON.parse(
    await readFile(
      new URL("../../fixtures/puf/headers-2025.json", import.meta.url),
      "utf8",
    ),
  );
  const previous = JSON.parse(
    await readFile(
      new URL("../../fixtures/puf/headers-2026-2027.json", import.meta.url),
      "utf8",
    ),
  );
  expect(audit.plan_year).toBe(2025);
  expect(Object.keys(audit.files).sort()).toEqual([...IMPORT_KINDS].sort());
  for (const kind of IMPORT_KINDS) {
    const observed = audit.files[kind];
    expect(observed.columns).toEqual(previous.files[kind]["2026"].columns);
    expect(observed.sha256).toMatch(/^[a-f0-9]{64}$/);
    const values = Object.fromEntries(
      observed.columns.map((key: string) => [key, ""]),
    );
    expect(() => validateImportHeader(kind, values, 2025)).not.toThrow();
    const mutant = { ...values };
    delete mutant.BusinessYear;
    mutant.RenamedBusinessYear = "";
    expect(() => validateImportHeader(kind, mutant, 2025)).toThrow(
      "BusinessYear",
    );
  }
  expect(audit.files["plan-attributes"].columns).toEqual(
    expect.arrayContaining([
      "EHBPercentTotalPremium",
      "QHPNonQHPTypeId",
      "ChildOnlyOffering",
    ]),
  );
});
