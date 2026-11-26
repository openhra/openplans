import { readdir, stat, access, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/database.js";
import { loadMigrations, migrationsDirectory } from "../db/migrate.js";
import { releaseFacts } from "../api/release-facts.js";
import { databaseErrorDiagnostic } from "./database-error.js";
import { applicationVersion } from "../mcp/version.js";

export const DOCTOR_USAGE = "Usage: worker doctor";

/** Below this the data directory cannot hold another import. */
export const DOCTOR_MIN_FREE_BYTES = 2 * 1024 ** 3;

/** Settings whose presence the last line reports. Values are never read into the output. */
export const DOCTOR_SETTINGS = [
  "DATABASE_URL",
  "OPENPLANS_DATA_DIR",
  "CMS_API_KEY",
  "OPENPLANS_GEOCODER_URL",
  "OPENPLANS_OPEN_GEOCODER_URL",
  "OPENPLANS_PLUGINS",
  "OPENPLANS_CONFIG",
] as const;

export interface DoctorOptions {
  openDatabase: () => Database;
  output: { out(message: string): void; error(message: string): void };
  /** Settings as the configuration resolves them, keyed by variable name. */
  settings: Readonly<Record<string, string | undefined>>;
  directory?: string;
  /** Free bytes at a path; tests replace it. */
  freeBytes?: (path: string) => Promise<number>;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const pass = (name: string, detail: string): Check => ({
  name,
  ok: true,
  detail,
});
const fail = (name: string, detail: string): Check => ({
  name,
  ok: false,
  detail,
});

async function realFreeBytes(path: string): Promise<number> {
  const disk = await statfs(path);
  return Number(disk.bavail) * Number(disk.bsize);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function databaseChecks(
  options: DoctorOptions,
  directory: string,
  settings: Readonly<Record<string, string | undefined>>,
): Promise<Check[]> {
  if (!settings.DATABASE_URL)
    return [
      fail(
        "database",
        "DATABASE_URL is not set; under Compose it is built from POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB in .env, so check that .env exists and run `docker compose up -d db`",
      ),
    ];
  let db: Database | undefined;
  try {
    db = options.openDatabase();
    await db.query("SELECT 1");
  } catch (error) {
    // Driver errors can hold credentials or URLs; only known diagnostics are printed.
    const checks = [
      fail(
        "database",
        `cannot connect${databaseErrorDiagnostic(error)}; start the database with \`docker compose up -d db\` and check DATABASE_URL`,
      ),
    ];
    try {
      await db?.close();
    } catch {
      // The connection never opened.
    }
    return checks;
  }
  const checks: Check[] = [pass("database", "reachable")];
  try {
    const files = (await loadMigrations(directory)).map(({ name }) => name);
    const present = (
      await db.query<{ present: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
      )
    ).rows[0]?.present;
    const journal = present
      ? (
          await db.query<{ name: string }>("SELECT name FROM schema_migrations")
        ).rows.map(({ name }) => name)
      : [];
    const known = new Set(files);
    const applied = new Set(journal);
    const pending = files.filter((name) => !applied.has(name)).length;
    // Plugin migrations are journaled as `plugin:<name>/<file>`; only core names are compared.
    const newer = journal.filter(
      (name) => !name.startsWith("plugin:") && !known.has(name),
    ).length;
    if (pending > 0)
      checks.push(
        fail(
          "migrations",
          `${pending} of ${files.length} migration files are not applied; run \`docker compose run --rm --no-deps worker migrate\``,
        ),
      );
    else
      checks.push(pass("migrations", `${files.length} applied, none pending`));
    if (newer > 0)
      checks.push(
        fail(
          "image",
          `release ${applicationVersion} does not know ${newer} migrations the database has applied; the image is older than the data, so set OPENPLANS_IMAGE to the release that wrote it`,
        ),
      );
    else
      checks.push(
        pass(
          "image",
          `release ${applicationVersion} matches the database schema`,
        ),
      );
    if (pending === 0 && newer === 0) {
      const facts = await releaseFacts(db, files.length);
      checks.push(
        facts.plan_years.length > 0
          ? pass(
              "data",
              `plan years ${facts.plan_years.join(",")}, generation ${facts.generation ?? "unknown"}`,
            )
          : fail(
              "data",
              "no plan data is loaded; run `OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker bootstrap --states TX --years 2026`",
            ),
      );
    }
  } catch (error) {
    checks.push(
      fail(
        "migrations",
        `cannot read the migration journal${databaseErrorDiagnostic(error)}; run \`docker compose run --rm --no-deps worker migrate\``,
      ),
    );
  } finally {
    try {
      await db.close();
    } catch {
      checks.push(fail("database", "shutdown failed"));
    }
  }
  return checks;
}

async function fileChecks(
  options: DoctorOptions,
  settings: Readonly<Record<string, string | undefined>>,
): Promise<Check[]> {
  const root = settings.OPENPLANS_DATA_DIR;
  if (!root)
    return [
      fail(
        "data dir",
        "OPENPLANS_DATA_DIR is not set; Compose sets it to /data in the worker, and a native run needs it exported",
      ),
    ];
  if (!(await isDirectory(root)))
    return [
      fail(
        "data dir",
        "$OPENPLANS_DATA_DIR does not exist; create it on the host with `mkdir -p $OPENPLANS_DATA_DIR/raw $OPENPLANS_DATA_DIR/reports $OPENPLANS_DATA_DIR/work` (Compose does not create host mount sources)",
      ),
    ];
  const under = (sub: string) => join(root, sub);
  const checks: Check[] = [];
  const missing: string[] = [];
  for (const sub of ["raw", "reports", "work"])
    if (!(await isDirectory(under(sub)))) missing.push(sub);
  if (missing.length)
    checks.push(
      fail(
        "data dir",
        `missing ${missing.map((sub) => `$OPENPLANS_DATA_DIR/${sub}`).join(", ")}; create ${missing.length === 1 ? "it" : "them"} on the host with mkdir -p`,
      ),
    );
  else {
    const locked = [];
    for (const sub of ["reports", "work"])
      if (!(await writable(under(sub)))) locked.push(sub);
    checks.push(
      locked.length
        ? fail(
            "data dir",
            `$OPENPLANS_DATA_DIR/${locked.join(", $OPENPLANS_DATA_DIR/")} not writable; give the image's node user (UID 1000) write access`,
          )
        : pass(
            "data dir",
            (await writable(under("raw")))
              ? "raw, reports and work are writable"
              : "reports and work are writable; raw is read-only (set OPENPLANS_RAW_READ_ONLY=false for downloads)",
          ),
    );
  }
  try {
    const free = await (options.freeBytes ?? realFreeBytes)(root);
    const gib = (free / 1024 ** 3).toFixed(1);
    checks.push(
      free < DOCTOR_MIN_FREE_BYTES
        ? fail(
            "disk",
            `${gib} GiB free under $OPENPLANS_DATA_DIR; free at least 2 GiB before an import`,
          )
        : pass("disk", `${gib} GiB free`),
    );
  } catch {
    checks.push(
      fail("disk", "cannot read free space under $OPENPLANS_DATA_DIR"),
    );
  }
  if (!missing.includes("raw")) {
    const entries = await readdir(under("raw")).catch(() => []);
    checks.push(
      entries.length
        ? pass("raw cache", `${entries.length} entries`)
        : fail(
            "raw cache",
            "raw/ is empty; fill it with `OPENPLANS_RAW_READ_ONLY=false docker compose run --rm worker bootstrap --states TX --years 2026` (add --dry-run to preview)",
          ),
    );
  }
  return checks;
}

/**
 * `worker doctor`: one line per check, in the order a fresh install needs them fixed. Exits 1
 * when any check fails and ends with the first failing line. It prints whether a setting is
 * present, never its value.
 */
export async function runDoctor(
  args: string[],
  options: DoctorOptions,
): Promise<number> {
  if (args.length !== 0) {
    options.output.error(DOCTOR_USAGE);
    return 1;
  }
  const { settings } = options;
  const checks = [
    ...(await databaseChecks(
      options,
      options.directory ?? migrationsDirectory,
      settings,
    )),
    ...(await fileChecks(options, settings)),
  ];
  for (const check of checks)
    options.output.out(
      `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
    );
  options.output.out(
    `settings: ${DOCTOR_SETTINGS.map((key) => `${key} ${settings[key] ? "present" : "absent"}`).join(", ")}`,
  );
  const first = checks.find((check) => !check.ok);
  if (first) {
    options.output.error(`doctor: ${first.name}: ${first.detail}`);
    return 1;
  }
  options.output.out("doctor: all checks passed");
  return 0;
}
