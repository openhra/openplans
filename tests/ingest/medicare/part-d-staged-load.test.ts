// Staged Part D price tables: written in short batches, unread until listed for the release, and
// resumable after a stop. Every identifier, price and fee below is synthetic. The staged rows are
// checked against what the one-transaction import stores from the same bytes.
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResponseCache } from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import { readUnitCost } from "../../../src/domain/medicare/part-d-cost/repository.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
  stageLargeTable,
} from "../../../src/ingest/medicare/spuf.js";
import type { StagedPass } from "../../../src/ingest/medicare/spuf.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { lookup, spufUrl, zip } from "./helpers.js";

const networkHeader =
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER|PHARMACY_ZIPCODE|PREFERRED_STATUS_RETAIL|PREFERRED_STATUS_MAIL|PHARMACY_RETAIL|PHARMACY_MAIL|IN_AREA_FLAG|FLOOR_PRICE|BRAND_DISPENSING_FEE_30|BRAND_DISPENSING_FEE_60|BRAND_DISPENSING_FEE_90|GENERIC_DISPENSING_FEE_30|GENERIC_DISPENSING_FEE_60|GENERIC_DISPENSING_FEE_90|SELECTED_DISPENSING_FEE_30|SELECTED_DISPENSING_FEE_60|SELECTED_DISPENSING_FEE_90";
const pricingRows = [
  "H9000|001|000|99990000001|30|1.23",
  "H9000|001|000|99990000001|60|2.4",
  "H9000|001|000|99990000001|90|3.5",
  "H9000|001|000|99990000002|30|0.0101",
  "H9000|001|001|99990000001|30|9.9999",
  "H9000|002|000|99990000001|60|2.3456",
  "H9000|003|000|99990000003|90|12",
];
const network1 = [
  "H9000|001|000|101000000001|90001|Y|N|Y|N|1|0|0.3|0.3|0|0.5|0.5|0|.|.|.",
  "H9000|001|000|101000000002|90002|Y|N|Y|N|1|1.5|2.75|2.75|0|.|.|.|1|1|1",
];
const network2 = [
  "H9000|001|000|101000000003|90003|N|N|Y|N|1|0|10.1234|10|10|1|1|1|.|.|.",
  "H9000|002|000|101000000001|90001|N|N|Y|N|1|0|5|5|5|6|6|6|.|.|.",
  "H9000|003|000|101000000004|90004|Y|N|Y|N|0|0|9|9|9|9|9|9|.|.|.",
];
const table = (header: string, rows: string[]) =>
  zip({ "synthetic.txt": Buffer.from([header, ...rows, ""].join("\r\n")) });
const members = {
  "plan information synthetic.zip": table(
    "CONTRACT_ID|PLAN_ID|SEGMENT_ID|FORMULARY_ID|PREMIUM|DEDUCTIBLE|PLAN_SUPPRESSED_YN",
    [
      "H9000|001|000|99990000|0|0|N",
      "H9000|001|001|99990000|0|0|N",
      "H9000|002|000|99990000|0|0|N",
      "H9000|003|000|99990000|0|0|N",
    ],
  ),
  "pharmacy networks file synthetic part 1.zip": table(networkHeader, network1),
  "pharmacy networks file synthetic part 2.zip": table(networkHeader, network2),
  "pricing file synthetic.zip": table(
    "CONTRACT_ID|PLAN_ID|SEGMENT_ID|NDC|DAYS_SUPPLY|UNIT_COST",
    pricingRows,
  ),
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "partd-staged-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cached(bytes = zip(members)) {
  const dataDir = await mkdtemp(join(directory, "cache-"));
  await acquireSpuf(parseSpufUrl(spufUrl)!, {
    dataDir,
    dependencies: {
      lookup,
      transport: async () => ({
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([bytes]),
      }),
    },
  });
  return (await cachedSpuf("quarterly", dataDir))[0]!;
}

/** A migrated database; `mutate` rewrites migration 1005 first, for planted mutants. */
async function database(mutate?: (sql: string) => string) {
  const migrations = await coreMigrations();
  if (mutate) {
    const file = join(migrations.directory, "1005_partd_staged_generation.sql");
    await writeFile(file, mutate(await readFile(file, "utf8")));
  }
  const db = testDatabase(new PGlite());
  await migrate(db, migrations.directory);
  return {
    db,
    close: async () => {
      await db.close();
      await migrations.cleanup();
    },
  };
}

const unitCosts = (db: Database) =>
  db
    .query(
      `SELECT k.snapshot_id,c.days_supply,c.source_row,c.contract_id,c.plan_id,c.segment_id,c.ndc,
         c.unit_cost::text FROM partd_plan_unit_cost c JOIN partd_pricing_release k USING(release_key)
       ORDER BY c.source_row`,
    )
    .then((r) => r.rows);
const feeRanges = (db: Database) =>
  db
    .query(
      `SELECT snapshot_id,contract_id,plan_id,segment_id,channel,in_area,fee_type,days_supply,pharmacies,
         fees_readable,fees_missing,min_fee::text,max_fee::text,max_floor_price::text,floors_missing,
         source_files,source_sha256,first_source_row::int
       FROM partd_dispensing_fee_range ORDER BY 2,3,4,5,6,7,8`,
    )
    .then((r) => r.rows);
const listed = async (db: Database, snapshotId: string) =>
  (
    await db.query<{ tables: string[] }>(
      "SELECT tables FROM partd_release WHERE snapshot_id=$1",
      [snapshotId],
    )
  ).rows[0]!.tables;
/** What the release tool does after its checks: list the tables in one update. */
const list = (db: Database, snapshotId: string) =>
  db.query(
    "UPDATE partd_release SET tables=tables || ARRAY['pricing','dispensing_fee']::text[] WHERE snapshot_id=$1",
    [snapshotId],
  );

/** The rows the one-transaction import stores from the same bytes. */
async function imported() {
  const state = await database();
  try {
    await importSpuf(state.db, await cached(), [
      "plan",
      "pricing",
      "dispensing_fee",
    ]);
    return {
      pricing: await unitCosts(state.db),
      fees: await feeRanges(state.db),
    };
  } finally {
    await state.close();
  }
}

/** Stops a pass right after its `at`-th batch committed, as a killed loader would. */
const stopAfter = (at: number) => (pass: StagedPass) => {
  if (pass.batches === at) throw new Error("stop");
};

describe("staged Part D price tables", () => {
  it("stores the import's rows in batches, unread until listed, and resumes after a stop", async () => {
    const expected = await imported();
    const state = await database();
    try {
      const input = await cached();
      const release = await importSpuf(state.db, input, ["plan"]);
      const snapshotId = release.snapshot_id;
      const request = {
        snapshotId,
        year: 2026,
        plan: { contractId: "H9000", planId: "001", segmentId: "0" },
        ndc: "99990000001",
        daysSupply: 30,
        channel: "preferred_retail",
        quantityUnit: "ndc_unit",
      } as const;

      // A pass stopped after two committed batches keeps exactly those rows.
      await expect(
        stageLargeTable(state.db, input, "pricing", {
          batchRows: 2,
          onBatch: stopAfter(2),
        }),
      ).rejects.toThrow("stop");
      expect((await unitCosts(state.db)).length).toBe(4);
      // Staged rows are not served: the release does not list pricing yet.
      expect(await listed(state.db, snapshotId)).toEqual(["plan"]);
      expect(await readUnitCost(state.db, request)).toMatchObject({
        status: "unknown",
        reason: "pricing_not_loaded",
      });

      const pricing = await stageLargeTable(state.db, input, "pricing", {
        batchRows: 2,
      });
      expect(pricing).toMatchObject({
        table: "pricing",
        snapshot_id: snapshotId,
        source_rows: 7,
        resumed_from: 4,
        written: 3,
        stored: 7,
        batches: 2,
        members: [
          {
            file: "pricing file synthetic.zip",
            sha256: sha(members["pricing file synthetic.zip"]),
            rows: 7,
          },
        ],
      });
      expect(await unitCosts(state.db)).toEqual(expected.pricing);

      // Fees commit whole plans: a stop after the first plan keeps that plan only.
      await expect(
        stageLargeTable(state.db, input, "dispensing_fee", {
          batchRows: 1,
          onBatch: stopAfter(1),
        }),
      ).rejects.toThrow("stop");
      const firstPlan = await feeRanges(state.db);
      expect(new Set(firstPlan.map((r) => r.plan_id))).toEqual(
        new Set(["001"]),
      );
      const fees = await stageLargeTable(state.db, input, "dispensing_fee", {
        batchRows: 1,
      });
      expect(fees).toMatchObject({
        source_rows: 5,
        plans: 3,
        resumed_from: 1,
        stored: expected.fees.length,
        ranges: expected.fees.length,
        members: [
          {
            file: "pharmacy networks file synthetic part 1.zip",
            sha256: sha(members["pharmacy networks file synthetic part 1.zip"]),
            rows: 2,
          },
          {
            file: "pharmacy networks file synthetic part 2.zip",
            sha256: sha(members["pharmacy networks file synthetic part 2.zip"]),
            rows: 3,
          },
        ],
      });
      expect(fees.written).toBe(expected.fees.length - firstPlan.length);
      expect(await feeRanges(state.db)).toEqual(expected.fees);
      expect(await listed(state.db, snapshotId)).toEqual(["plan"]);

      // Listed, the same request reads the staged row.
      await list(state.db, snapshotId);
      expect(await readUnitCost(state.db, request)).toMatchObject({
        status: "value",
        unit_cost: "1.2300",
      });
      // Once listed, a table is never staged again, and the one-transaction import refuses to
      // add a table that is staged but not listed.
      await expect(stageLargeTable(state.db, input, "pricing")).rejects.toThrow(
        "already listed",
      );
    } finally {
      await state.close();
    }
  });

  it("refuses a release that is not imported, odd batch sizes and a staged import", async () => {
    const state = await database();
    try {
      const input = await cached();
      await expect(stageLargeTable(state.db, input, "pricing")).rejects.toThrow(
        "not imported and active",
      );
      await importSpuf(state.db, input, ["plan"]);
      for (const batchRows of [0, 8001, 1.5])
        await expect(
          stageLargeTable(state.db, input, "pricing", { batchRows }),
        ).rejects.toThrow("batch size");
      await expect(
        stageLargeTable(state.db, input, "plan" as never),
      ).rejects.toThrow("not staged in batches");
      await expect(
        stageLargeTable(state.db, input, "pricing", {
          batchRows: 3,
          onBatch: stopAfter(1),
        }),
      ).rejects.toThrow("stop");
      await expect(
        importSpuf(state.db, input, ["plan", "pricing"]),
      ).rejects.toThrow("staged for this release");
    } finally {
      await state.close();
    }
  });
});

/** Each table's generation revision. */
const revisions = async (db: Database) =>
  Object.fromEntries(
    (
      await db.query<{ table_name: string; revision: string }>(
        "SELECT table_name, revision::text FROM api_data_generation",
      )
    ).rows.map((row) => [row.table_name, BigInt(row.revision)]),
  );
/** How far each table's revision moved between two readings; unmoved tables are left out. */
const moved = (before: Record<string, bigint>, after: Record<string, bigint>) =>
  Object.fromEntries(
    Object.entries(after)
      .filter(([table, revision]) => revision !== before[table])
      .map(([table, revision]) => [
        table,
        Number(revision - (before[table] ?? 0n)),
      ]),
  );
/** The release tool's listing update: keep every other table, then add `tables`. */
const setPriceTables = (db: Database, snapshotId: string, tables: string[]) =>
  db.query(
    `UPDATE partd_release SET tables=ARRAY(SELECT t FROM unnest(tables) WITH ORDINALITY u(t, o)
       WHERE t NOT IN ('pricing','dispensing_fee') ORDER BY o) || $2::text[]
     WHERE snapshot_id=$1`,
    [snapshotId, tables],
  );

/**
 * Stage both price tables, serve them, withdraw them as a failed check does, and record which
 * generation revisions each step moved. A cached response for a route that reads no Part D table
 * shows what the cache sees.
 */
async function generationSteps(db: Database) {
  const input = await cached();
  const snapshotId = (await importSpuf(db, input, ["plan"])).snapshot_id;
  const app = new Hono();
  app.use(
    "*",
    createResponseCache(db, undefined, { store: new MemoryCache(1024 * 1024) })
      .middleware,
  );
  app.get("/v1/zip-counties", (c) => c.json({ counties: [] }));
  const cacheState = async () =>
    (await app.request("/v1/zip-counties?zip=77002")).headers.get("X-Cache");
  const steps: Record<string, unknown> = { first: await cacheState() };
  let before = await revisions(db);
  const step = async (name: string, run: () => Promise<unknown>) => {
    await run();
    const after = await revisions(db);
    steps[name] = moved(before, after);
    steps[`${name}_cache`] = await cacheState();
    before = after;
  };
  const batches: number[] = [];
  await step("staging", async () => {
    for (const table of ["pricing", "dispensing_fee"] as const)
      batches.push(
        (await stageLargeTable(db, input, table, { batchRows: 2 })).batches,
      );
  });
  steps.batches = batches;
  await step("serving", () =>
    setPriceTables(db, snapshotId, ["pricing", "dispensing_fee"]),
  );
  await step("served_delete", () =>
    db.query("DELETE FROM partd_plan_unit_cost WHERE source_row=7"),
  );
  await step("demotion", () => setPriceTables(db, snapshotId, []));
  await step("unserved_delete", () =>
    db.query("DELETE FROM partd_dispensing_fee_range WHERE plan_id='003'"),
  );
  await step("truncate", () => db.query("TRUNCATE partd_dispensing_fee_range"));
  return steps;
}

const expectedSteps = {
  first: "miss",
  // Four pricing batches and three fee batches commit; nothing they write is served yet.
  batches: [4, 3],
  staging: {},
  staging_cache: "hit",
  serving: { partd_release: 1 },
  serving_cache: "miss",
  served_delete: { partd_plan_unit_cost: 1 },
  served_delete_cache: "miss",
  demotion: { partd_release: 1 },
  demotion_cache: "miss",
  unserved_delete: {},
  unserved_delete_cache: "hit",
  truncate: { partd_dispensing_fee_range: 1 },
  truncate_cache: "miss",
};

/** Replace the one occurrence of `from` in migration 1005. */
const swap = (from: string, to: string) => (sql: string) => {
  expect(sql.split(from)).toHaveLength(2);
  return sql.replace(from, to);
};
/** partd_release treated as a staged table: its row writes no longer reach the shared function. */
const releaseTruncateOnly = `DROP TRIGGER api_data_changed ON partd_release;
CREATE TRIGGER api_data_changed AFTER TRUNCATE ON partd_release
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
`;
const mutants = [
  {
    name: "a staged batch bumps the generation",
    mutate: swap("served_table = ANY (r.tables) AS served", "true AS served"),
    wrong: "staging",
  },
  {
    name: "serving does not bump the generation",
    mutate: (sql: string) => sql + releaseTruncateOnly,
    wrong: "serving",
  },
  {
    // The release row checked only as it stands after the write: listing it bumps, withdrawing
    // it does not.
    name: "a demotion does not bump the generation",
    mutate: (sql: string) =>
      swap(
        "ELSIF TG_TABLE_NAME IN ('partd_pricing_release',",
        "ELSIF TG_TABLE_NAME IN ('partd_release', 'partd_pricing_release',",
      )(sql) +
      releaseTruncateOnly +
      `CREATE TRIGGER api_data_served_update AFTER UPDATE ON partd_release
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();`,
    wrong: "demotion",
  },
] as const;

describe("staged Part D price tables and the data generation", () => {
  it("staging leaves the generation alone; serving and withdrawing move it once", async () => {
    const state = await database();
    try {
      expect(await generationSteps(state.db)).toEqual(expectedSteps);
    } finally {
      await state.close();
    }
  });

  it.each(mutants)(
    "planted mutant fails the step check: $name",
    async ({ mutate, wrong }) => {
      const state = await database(mutate);
      try {
        const steps = await generationSteps(state.db);
        expect(steps[wrong]).not.toEqual(
          expectedSteps[wrong as keyof typeof expectedSteps],
        );
        expect(() => expect(steps).toEqual(expectedSteps)).toThrow();
      } finally {
        await state.close();
      }
    },
  );
});
