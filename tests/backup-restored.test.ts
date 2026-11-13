// `worker backup-restored`: a restored backup keeps pass-through receipts whose answers it left
// out; the step quarantines those receipts and nothing else. All rows here are synthetic.
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import type { Database } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { backupExcludedTables } from "../src/worker/backup-args.js";
import * as Step from "../src/worker/backup-restored.js";
import { coreMigrations, testDatabase } from "./pglite.js";
import { rebaseImports } from "./source-mutation.js";
import { importMutant } from "./mutant-file.js";

type Source = PassThroughSource<Question, unknown>;
const stored = (id: string, excludeFromBackups?: boolean): Source =>
  ({
    kind: "passthrough",
    id,
    cache: { level: "stored", excludeFromBackups },
  }) as unknown as Source;
// A stored source declared with a catalog source's id must still never touch catalog receipts.
const sources = [stored("synthetic-stored"), stored("synthetic-catalog")];
const excluded = backupExcludedTables(sources);
const ORPHANS = [
  "cms-marketplace-api:drugs-covered:2026:synthetic",
  "cms-marketplace-api:providers-covered:2026:synthetic",
  "synthetic-stored:drug:2026:synthetic",
];

let live: PGlite, db: Database, restored: PGlite | undefined;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  live = new PGlite();
  db = testDatabase(live);
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await migrate(db, core.directory);
  await seed(db);
});
afterEach(async () => {
  await restored?.close();
  restored = undefined;
  await db.close();
  await cleanup();
});

async function receipt(
  session: Database,
  id: string,
  source: string,
  state = "ACTIVE",
) {
  await session.query(
    `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,sha256,expected_children,fetched_children,validation_state,activated_at)
    VALUES ($1,$2,'2026-11-10T00:00:00Z',repeat('a',64),0,0,$3,CASE WHEN $3='ACTIVE' THEN now() END)`,
    [id, source, state],
  );
}

async function seed(session: Database) {
  await session.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES
    ('synthetic-catalog','Synthetic','puf'),
    ('synthetic-stored','Synthetic','passthrough')`);
  // A catalog receipt with no rows in any table: only its source kind and id protect it.
  await receipt(session, "synthetic-catalog:2026:release", "synthetic-catalog");
  await receipt(session, ORPHANS[0]!, "cms-marketplace-api");
  await receipt(session, ORPHANS[1]!, "cms-marketplace-api");
  await receipt(session, ORPHANS[2]!, "synthetic-stored");
  // Already quarantined for its own reason; the step leaves it and its issue alone.
  await receipt(
    session,
    "cms-marketplace-api:drugs-covered:2026:old",
    "cms-marketplace-api",
    "QUARANTINED",
  );
  await session.query(
    `INSERT INTO cms_api_drug_coverage(plan_id,rxcui,plan_year,coverage,snapshot_id,source_row)
    VALUES ('00000TX0000000','0',2026,'Covered',$1,1)`,
    [ORPHANS[0]],
  );
  await session.query(
    `INSERT INTO cms_api_provider_coverage(plan_id,npi,plan_year,coverage,snapshot_id,source_row)
    VALUES ('00000TX0000000','1000000000',2026,'Covered',$1,1)`,
    [ORPHANS[1]],
  );
  await session.query(
    `INSERT INTO passthrough_answer(source_id,kind,identity,plan_year,outcome,statement,policy_name,
      snapshot_id,source_row,sourced_by,sourced_at,sourced_slug)
    VALUES ('synthetic-stored','drug','0',2026,'answer','Covered','cms_api_fallback',$1,1,
      'synthetic-stored','2026-11-10T00:00:00Z',$1)`,
    [ORPHANS[2]],
  );
}

/** What `pg_dump --exclude-table-data` then `pg_restore` gives: every table, no excluded data. */
async function backupAndRestore(): Promise<Database> {
  restored = new PGlite({ loadDataDir: await live.dumpDataDir("none") });
  const copy = testDatabase(restored);
  await copy.exec(`TRUNCATE ${excluded.map((t) => `"${t}"`).join(",")}`);
  return copy;
}

const states = async (session: Database) =>
  Object.fromEntries(
    (
      await session.query<{ snapshot_id: string; validation_state: string }>(
        "SELECT snapshot_id,validation_state FROM snapshot ORDER BY snapshot_id",
      )
    ).rows.map((r) => [r.snapshot_id, r.validation_state]),
  );
const evidence = async (session: Database) => ({
  states: await states(session),
  issues: (
    await session.query(
      "SELECT snapshot_id,severity,issue_code FROM quality_issue ORDER BY snapshot_id,quality_issue_id",
    )
  ).rows,
  events: (
    await session.query(
      "SELECT event_type,payload FROM plugin_event_outbox ORDER BY idempotency_key",
    )
  ).rows,
});
/** ACTIVE pass-through receipts with no answer row: the restored state the readiness audit refuses. */
const orphans = async (session: Database) =>
  (
    await session.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM snapshot s WHERE validation_state='ACTIVE'
      AND source_id IN ('cms-marketplace-api','synthetic-stored')
      AND NOT EXISTS (SELECT 1 FROM cms_api_drug_coverage c WHERE c.snapshot_id=s.snapshot_id)
      AND NOT EXISTS (SELECT 1 FROM cms_api_provider_coverage c WHERE c.snapshot_id=s.snapshot_id)
      AND NOT EXISTS (SELECT 1 FROM passthrough_answer c WHERE c.snapshot_id=s.snapshot_id)
      ORDER BY snapshot_id`,
    )
  ).rows.map((r) => r.snapshot_id);

type Run = typeof Step.runBackupRestored;
async function run(
  session: Database,
  manifest: unknown,
  implementation: Run = Step.runBackupRestored,
) {
  const out: string[] = [],
    err: string[] = [];
  const keep = { ...session, close: async () => {} };
  const code = await implementation(
    ["--manifest", "backup.json"],
    () => keep,
    { out: (l) => out.push(l), error: (l) => err.push(l) },
    sources,
    async () => JSON.stringify(manifest),
  );
  return { code, out, err };
}

/** The whole contract: orphans quarantined with the reason, catalog untouched, a rerun a no-op. */
async function contract(implementation: Run = Step.runBackupRestored) {
  const copy = await backupAndRestore();
  expect(await orphans(copy)).toEqual(ORPHANS);
  // An ops receipt nests the list under `backup`.
  const first = await run(
    copy,
    { backup: { excluded_table_data: excluded } },
    implementation,
  );
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out[0]!)).toEqual({
    quarantined: {
      "cms-marketplace-api": 2,
      "synthetic-stored": 1,
      "synthetic-catalog": 0,
    },
    kept: [],
  });
  expect(await orphans(copy)).toEqual([]);
  const after = await evidence(copy);
  expect(after.states["synthetic-catalog:2026:release"]).toBe("ACTIVE");
  expect(after.issues).toEqual(
    ORPHANS.map((snapshot_id) => ({
      snapshot_id,
      severity: "error",
      issue_code: "answers_excluded_from_backup",
    })),
  );
  expect(after.events).toEqual(
    ORPHANS.map((snapshotId) => ({
      event_type: "snapshot.quarantined",
      payload: {
        sourceId: snapshotId.split(":")[0],
        snapshotId,
        reasonCode: "answers_excluded_from_backup",
      },
    })),
  );
  const second = await run(
    copy,
    { excluded_table_data: excluded },
    implementation,
  );
  expect(second.code).toBe(0);
  expect(JSON.parse(second.out[0]!).quarantined).toEqual({
    "cms-marketplace-api": 0,
    "synthetic-stored": 0,
    "synthetic-catalog": 0,
  });
  expect(await evidence(copy)).toEqual(after);
}

describe("worker backup-restored", () => {
  it("leaves a restored backup with no orphaned receipt, once and again", async () => {
    await contract();
    // The live database still has its answers and receipts.
    expect(
      Object.values(await states(db)).filter((s) => s === "ACTIVE"),
    ).toHaveLength(4);
  });

  it("touches no receipt whose answers are still there", async () => {
    const result = await run(db, { excluded_table_data: excluded });
    expect(result.code).toBe(0);
    expect(Object.values(JSON.parse(result.out[0]!).quarantined)).toEqual([
      0, 0, 0,
    ]);
    expect(
      Object.values(await states(db)).filter((s) => s === "ACTIVE"),
    ).toHaveLength(4);
  });

  it("keeps the receipts of a source whose answers the backup kept", async () => {
    const copy = await backupAndRestore();
    const kept = excluded.filter((t) => !t.startsWith("passthrough_"));
    const result = await run(copy, { excluded_table_data: kept });
    expect(JSON.parse(result.out[0]!)).toEqual({
      quarantined: { "cms-marketplace-api": 2 },
      kept: ["synthetic-stored", "synthetic-catalog"],
    });
    expect((await states(copy))[ORPHANS[2]!]).toBe("ACTIVE");
    // A source that opts back in to backups is never a candidate.
    expect(
      Step.answerTables([stored("synthetic-kept", false)]).map(
        (s) => s.sourceId,
      ),
    ).toEqual(["cms-marketplace-api"]);
  });

  it("refuses a bad manifest, half a source's tables and other arguments", async () => {
    const copy = await backupAndRestore();
    for (const manifest of [
      {},
      { excluded_table_data: "cms_api_attempt" },
      {
        excluded_table_data: ["bad name"],
      },
    ]) {
      const result = await run(copy, manifest);
      expect(result.code).toBe(1);
      expect(result.err[0]).toMatch(/excluded_table_data list/);
    }
    const half = await run(copy, {
      excluded_table_data: excluded.filter((t) => t !== "cms_api_attempt"),
    });
    expect(half.code).toBe(1);
    expect(half.err[0]).toMatch(/^worker backup-restored failed/);
    expect(await orphans(copy)).toEqual(ORPHANS);
    const errors: string[] = [];
    for (const args of [
      [],
      ["--manifest"],
      ["--manifest", "a", "b"],
      ["--all", "a"],
    ])
      expect(
        await Step.runBackupRestored(
          args,
          () => {
            throw new Error("opened");
          },
          { out: () => {}, error: (l) => errors.push(l) },
          [],
        ),
      ).toBe(1);
    expect(new Set(errors)).toEqual(
      new Set(["Usage: worker backup-restored --manifest FILE|-"]),
    );
  });

  it.each([
    [
      "a catalog receipt quarantined",
      "WHERE s.source_id=$1 AND s.validation_state='ACTIVE'\n        AND r.source_kind=ANY($2::text[])",
      "WHERE s.validation_state='ACTIVE' AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL",
    ],
    [
      "a catalog-kind source quarantined",
      "AND r.source_kind=ANY($2::text[])",
      "AND $2::text[] IS NOT NULL",
    ],
    [
      "orphans left in place",
      "SET validation_state='QUARANTINED'",
      "SET validation_state=validation_state",
    ],
    [
      "a rerun that changes receipts again",
      "AND s.validation_state='ACTIVE'",
      "AND s.validation_state IS NOT NULL",
    ],
  ])("planted mutant: %s is caught", async (_name, before, after) => {
    const original = new URL(
      "../dist/worker/backup-restored.js",
      import.meta.url,
    );
    const text = await readFile(original, "utf8");
    expect(text).toContain(before);
    // Inside dist, so package imports still resolve.
    const directory = await mkdtemp(
      join(fileURLToPath(new URL("../dist/", import.meta.url)), ".mutant-"),
    );
    try {
      const path = join(directory, "backup-restored.js");
      await writeFile(
        path,
        rebaseImports(text.replace(before, after), original),
      );
      const mutant = await importMutant<{
        runBackupRestored: Parameters<typeof contract>[0];
      }>(pathToFileURL(path), "runBackupRestored");
      await expect(contract(mutant.runBackupRestored)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
