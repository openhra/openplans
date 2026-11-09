import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, migrationsDirectory } from "../../dist/db/migrate.js";
import { importPufs } from "../../dist/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../dist/ingest/puf/import-source.js";
import { plansForCounty } from "../../dist/ingest/puf/import-repository.js";
import { checkRate, classifyJson } from "./logic.mjs";

export function database(pg) {
  const session = {
    query: (sql, args) => pg.query(sql, args),
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
  return {
    ...session,
    close: () => pg.close(),
    transaction: (run) =>
      pg.transaction((tx) =>
        run({
          query: (sql, args) => tx.query(sql, args),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
  };
}
export async function portableMigrations(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(migrationsDirectory)) {
    if (name.endsWith(".sql") && name !== "002_postgis.sql")
      await cp(join(migrationsDirectory, name), join(directory, name));
  }
  return directory;
}

export async function negativeControls(directory, sample) {
  const path = join(directory, "synthetic-mutated-rate.json");
  await writeFile(path, JSON.stringify(sample));
  const copy = JSON.parse(await readFile(path, "utf8"));
  const original = checkRate(copy.expected, copy.rows);
  const target = copy.rows.find(
    (row) => row.provenance.sourceRowNumber === copy.expected.source_row,
  );
  if (!target || target.individualRateCents === null)
    throw new Error("Negative control needs a published individual rate");
  target.individualRateCents += 1;
  await writeFile(path, JSON.stringify(copy));
  const mutated = JSON.parse(await readFile(path, "utf8"));
  const broken = checkRate(mutated.expected, mutated.rows);
  const rate = {
    name: "rate_plus_one_cent",
    passed:
      !original.mismatches.length &&
      broken.mismatches.length > 0 &&
      broken.mismatches.every((m) => m.actual_cents === m.expected_cents + 1),
    baseline_mismatches: original.mismatches.length,
    mutant_mismatches: broken.mismatches.length,
    example: broken.mismatches[0],
    scope: "temporary JSON copy of a real imported rate group",
  };

  const pg = new PGlite(),
    db = database(pg);
  let statewide;
  try {
    await migrate(db, await portableMigrations(join(directory, "migrations")));
    const fixtures = fileURLToPath(
      new URL("../../tests/fixtures/puf/import/", import.meta.url),
    );
    const provenance = JSON.parse(
      await readFile(join(fixtures, "provenance.json"), "utf8"),
    );
    const files = await Promise.all(
      IMPORT_KINDS.map(async (kind) => {
        const path = join(fixtures, `${kind}.csv`),
          bytes = await readFile(path);
        return {
          kind,
          path,
          format: "csv",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          retrievedAt: "2026-11-07T00:00:00Z",
          url: provenance.files.find((file) => file.kind === kind).url,
        };
      }),
    );
    const report = await importPufs(db, {
      year: 2026,
      state: "TX",
      files,
      dataDir: directory,
    });
    if (!report.passed) throw new Error("Control import did not reconcile");
    const present = (
      await plansForCounty(db, "48201", 2026, "Individual")
    ).filter((p) => p.issuer_id === "12846");
    const outside = await plansForCounty(db, "36061", 2026, "Individual");
    // Deliberately reproduce D3 only in this disposable DB, then assert the same query fails.
    await db.exec(
      "UPDATE service_area_county SET cover_entire_state=FALSE WHERE issuer_id='12846'",
    );
    const missing = (
      await plansForCounty(db, "48201", 2026, "Individual")
    ).filter((p) => p.issuer_id === "12846");
    statewide = {
      name: "statewide_county_query_D3",
      passed:
        present.length > 0 && missing.length === 0 && outside.length === 0,
      baseline_plans: present.map((p) => p.base_plan_id),
      mutant_plans: missing.map((p) => p.base_plan_id),
      other_state_plans: outside.length,
      scope: "real-cut CSV import into a disposable in-memory database",
    };
  } finally {
    await db.close();
  }

  const complete = '[{"synthetic":true},{"synthetic":false}]';
  const tailPath = join(directory, "synthetic-truncated-provider.json");
  await writeFile(tailPath, complete.slice(0, complete.indexOf(",") + 1));
  const classified = classifyJson(await readFile(tailPath, "utf8"));
  const truncated = {
    name: "truncated_json_tail_D1",
    passed:
      classified.classification === "truncated" &&
      classified.snapshot_state === "QUARANTINED" &&
      classified.provider_status === "unknown" &&
      classifyJson(complete).classification === "complete" &&
      classifyJson("[{bad}]").classification === "invalid",
    ...classified,
    scope:
      "small explicitly synthetic JSON ending after an array comma; no issuer tar extraction",
  };
  return [rate, statewide, truncated];
}
