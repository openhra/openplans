#!/usr/bin/env node
// Developer-only real corpus check. Run after npm run build; no network in CI.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  ingestStateRates,
  stagedStatePremium,
} from "../../../dist/ingest/state/index.js";
import { dataDirectory } from "../../../dist/config/access.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dataDir = resolve(process.argv[2] ?? dataDirectory());
const pg = new PGlite();
const db = {
  query: (sql, parameters) => pg.query(sql, parameters),
  exec: async (sql) => {
    await pg.exec(sql);
  },
  transaction: (run) =>
    pg.transaction((tx) =>
      run({
        query: (sql, parameters) => tx.query(sql, parameters),
        exec: async (sql) => {
          await tx.exec(sql);
        },
      }),
    ),
  close: () => pg.close(),
};
const report = {
  status: "PASS",
  database: "ephemeral PGlite; PostGIS migration omitted",
  imports: [],
  premiums: [],
  native_http_checks:
    "NOT RUN: state catalog/API integration outside P8a lease",
};
try {
  for (const file of (await readdir(join(root, "migrations")))
    .filter((n) => n.endsWith(".sql") && n !== "002_postgis.sql")
    .sort()) {
    await db.exec(await readFile(join(root, "migrations", file), "utf8"));
  }
  for (const state of ["NY", "VT"]) {
    const path = join(
      dataDir,
      "derived/state-rating",
      `${state.toLowerCase()}-2026.json`,
    );
    const prepared = JSON.parse(await readFile(path, "utf8"));
    assert(prepared.sources.every((source) => source.status === 200));
    const result = await ingestStateRates(db, path, state);
    const actual = (
      await db.query(
        `SELECT count(*)::int AS count FROM state_community_rate r
      JOIN state_rate_active a ON a.import_id=r.import_id WHERE a.state=$1`,
        [state],
      )
    ).rows[0].count;
    assert.equal(
      actual,
      prepared.sources.reduce((n, source) => n + source.records.length, 0),
    );
    report.imports.push({
      ...result,
      original_hashes_verified: true,
      stored_rows: actual,
      acquisition_http_status: 200,
    });
  }
  // SYNTHETIC households; all prices are the acquired states' actual filed cents.
  const single = [
    { id: "s", relationship: "subscriber", age: 40, tobaccoUse: false },
  ];
  const couple = [
    ...single,
    { id: "p", relationship: "spouse", age: 45, tobaccoUse: false },
  ];
  const parent = [
    ...single,
    { id: "c", relationship: "child", age: 10, tobaccoUse: false },
  ];
  const family = [
    ...couple,
    { id: "c1", relationship: "child", age: 10, tobaccoUse: false },
    { id: "c2", relationship: "child", age: 17, tobaccoUse: false },
  ];
  for (const [state, location, key, area, prices] of [
    [
      "NY",
      "NYC",
      "11177NY0220001",
      "Rating Area 4",
      [127098, 254196, 216067, 362229],
    ],
    [
      "VT",
      "Burlington",
      "BCBSVT:Gold Plan",
      "Vermont",
      [134545, 269090, 259672, 378071],
    ],
  ]) {
    for (const [index, members] of [single, couple, parent, family].entries()) {
      const result = await stagedStatePremium(
        db,
        state,
        key,
        area,
        members,
        "2026-01-01",
      );
      assert.equal(result.status, "rated");
      assert.equal(result.totalCents, prices[index]);
      report.premiums.push({
        state,
        location,
        plan_key: key,
        tier: result.tier,
        total_cents: result.totalCents,
      });
    }
  }
  const directory = join(dataDir, "reports");
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, "p8a-state-rating.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, report_path: reportPath }));
} finally {
  await db.close();
}
