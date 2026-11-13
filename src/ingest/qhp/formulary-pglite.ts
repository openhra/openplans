#!/usr/bin/env node
/** Real-data developer runner; isolated PGlite DB and report stay in the data cache. */
import { PGlite } from "@electric-sql/pglite";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrationsDirectory } from "../../db/migrate.js";
import { runWorker } from "../../worker/commands.js";
import { readJsonArray } from "../json/index.js";
import { createDrugRepository } from "../../domain/drugs/repository.js";
import { dataDirectory } from "../../config/access.js";

const cache = dataDirectory();
const path =
  process.env.OPENPLANS_FORMULARY_DB ?? join(cache, "formulary-pglite-p2c");
const directory = await mkdtemp(
  join(tmpdir(), "openplans-formulary-migrations-"),
);
let pg: PGlite | undefined;
async function insert(table: string, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const keys = Object.keys(row);
    await pg!.query(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING`,
      keys.map((key) =>
        row[key] !== null &&
        typeof row[key] === "object" &&
        !(row[key] instanceof Date)
          ? JSON.stringify(row[key])
          : row[key],
      ),
    );
  }
}
async function bootstrap() {
  const puf = new PGlite(join(cache, "puf-pglite-p1d"));
  const plans = (
    await puf.query<
      Record<string, unknown>
    >(`SELECT p.* FROM puf_active_catalog a
    JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id WHERE a.state='TX' AND a.plan_year=2026 AND p.issuer_id='76589'`)
  ).rows;
  if (!plans.length) throw new Error("Cigna PUF catalog unavailable");
  const catalog = String(plans[0]!.snapshot_id);
  const files = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM puf_import_file WHERE snapshot_id=$1",
      [catalog],
    )
  ).rows;
  const importId = files[0]!.import_id;
  const snapshots = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM snapshot WHERE snapshot_id=ANY($1::text[])",
      [[catalog, importId]],
    )
  ).rows;
  const sources = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM source WHERE source_id=ANY($1::text[])",
      [snapshots.map((s) => s.source_id)],
    )
  ).rows;
  const imports = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM puf_import WHERE import_id=$1",
      [importId],
    )
  ).rows;
  const active = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
    )
  ).rows;
  const variants = (
    await puf.query<Record<string, unknown>>(
      "SELECT * FROM plan_variant WHERE snapshot_id=$1 AND issuer_id='76589'",
      [catalog],
    )
  ).rows;
  await puf.close();
  await insert("source", sources);
  await insert("snapshot", snapshots);
  await insert("puf_import", imports);
  await insert("puf_import_file", files);
  await insert("puf_active_catalog", active);
  await insert("plan", plans);
  await insert("plan_variant", variants);
  // Load exact real RxNorm atoms for the feed's codes; no synthetic terminology seed.
  const rxcuis = new Set<string>(["6809"]);
  const children = (
    await pg!.query<{
      raw_path: string;
    }>(`SELECT DISTINCT s.raw_path FROM snapshot s
    JOIN qhp_child_url c USING(snapshot_id) WHERE c.issuer_id='76589' AND c.plan_year=2026 AND c.kind='formulary_urls'`)
  ).rows;
  for (const child of children)
    for await (const value of readJsonArray<{ rxnorm_id: string }>(
      createReadStream(child.raw_path),
    ))
      rxcuis.add(value.rxnorm_id);
  const rx = new PGlite(join(cache, "rxnorm-pglite-p2a"));
  const release = (
    await rx.query<
      Record<string, unknown>
    >(`SELECT r.* FROM rx_release r JOIN snapshot s USING(snapshot_id)
    WHERE s.validation_state='ACTIVE' ORDER BY source_version DESC LIMIT 1`)
  ).rows;
  const rxSnapshots = (
    await rx.query<Record<string, unknown>>(
      "SELECT * FROM snapshot WHERE snapshot_id=$1",
      [release[0]!.snapshot_id],
    )
  ).rows;
  const rxSources = (
    await rx.query<Record<string, unknown>>(
      "SELECT * FROM source WHERE source_id=$1",
      [rxSnapshots[0]!.source_id],
    )
  ).rows;
  const concepts = (
    await rx.query<Record<string, unknown>>(
      "SELECT * FROM rx_concept WHERE snapshot_id=$1 AND rxcui=ANY($2::text[])",
      [release[0]!.snapshot_id, [...rxcuis]],
    )
  ).rows;
  await rx.close();
  await insert("source", rxSources);
  await insert("snapshot", rxSnapshots);
  await insert("rx_release", release);
  await insert("rx_concept", concepts);
  console.log(
    JSON.stringify({
      bootstrap: {
        catalog_plans: plans.length,
        variants: variants.length,
        rxnorm_atoms: concepts.length,
        note: "RxNorm atoms restricted to feed codes plus 6809, copied from real ACTIVE release",
      },
    }),
  );
}
try {
  for (const name of await readdir(migrationsDirectory))
    if (name.endsWith(".sql") && name !== "002_postgis.sql") {
      await cp(join(migrationsDirectory, name), join(directory, name));
    }
  let exists = true;
  try {
    await stat(path);
  } catch {
    exists = false;
  }
  if (!exists)
    await cp(join(cache, "qhp-pglite-p2b-integrated"), path, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  pg = new PGlite(path);
  if (!exists) await bootstrap();
  const session: SqlSession = {
    query: (sql, args) => pg!.query(sql, args),
    exec: async (sql) => {
      await pg!.exec(sql);
    },
  };
  const db: Database = {
    ...session,
    close: async () => {},
    transaction: (run) =>
      pg!.transaction((tx) =>
        run({
          query: (sql, args) => tx.query(sql, args),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
  };
  const messages: string[] = [];
  process.exitCode = await runWorker(
    process.argv.slice(2),
    () => db,
    {
      out: (message) => {
        messages.push(message);
        console.log(message);
      },
      error: (message) => console.error(message),
    },
    directory,
  );
  if (messages.length) {
    const report = JSON.parse(messages[0]!);
    const flags = (
      await db.query(
        `SELECT
      count(*)::int AS edges,count(DISTINCT rxcui)::int AS rxcuis,count(DISTINCT base_hios_id)::int AS plans,
      count(*) FILTER (WHERE prior_authorization IS NULL)::int AS pa_null,
      count(*) FILTER (WHERE prior_authorization IS FALSE)::int AS pa_false,
      count(*) FILTER (WHERE prior_authorization IS TRUE)::int AS pa_true,
      count(*) FILTER (WHERE step_therapy IS NULL)::int AS st_null,
      count(*) FILTER (WHERE step_therapy IS FALSE)::int AS st_false,
      count(*) FILTER (WHERE step_therapy IS TRUE)::int AS st_true,
      count(*) FILTER (WHERE quantity_limit IS NULL)::int AS ql_null,
      count(*) FILTER (WHERE quantity_limit IS FALSE)::int AS ql_false,
      count(*) FILTER (WHERE quantity_limit IS TRUE)::int AS ql_true
      FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id) WHERE s.source_set_id=$1`,
        [report.snapshot_id],
      )
    ).rows;
    const plans = (
      await db.query(
        `SELECT base_hios_id,count(*)::int AS edges,count(DISTINCT rxcui)::int AS rxcuis
      FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id) WHERE s.source_set_id=$1
      GROUP BY base_hios_id ORDER BY base_hios_id`,
        [report.snapshot_id],
      )
    ).rows;
    const sampleEdges = (
      await db.query(
        `SELECT e.rxcui,e.base_hios_id,e.plan_year,e.drug_tier,
      e.prior_authorization,e.step_therapy,e.quantity_limit,e.source_record,e.source_plan_index
      FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id) WHERE s.source_set_id=$1
      ORDER BY e.source_record,e.source_plan_index LIMIT 1000`,
        [report.snapshot_id],
      )
    ).rows;
    const codes = (
      await db.query<{ rxcui: string }>(
        `SELECT DISTINCT e.rxcui FROM formulary_edge e
      JOIN formulary_shard s USING(snapshot_id) WHERE s.source_set_id=$1 ORDER BY e.rxcui`,
        [report.snapshot_id],
      )
    ).rows.map((row) => row.rxcui);
    const tiers = (
      await db.query(
        `SELECT e.drug_tier,count(*)::int AS edges FROM formulary_edge e
      JOIN formulary_shard s USING(snapshot_id) WHERE s.source_set_id=$1 GROUP BY e.drug_tier ORDER BY e.drug_tier`,
        [report.snapshot_id],
      )
    ).rows;
    const shards = (
      await db.query(
        `SELECT f.*,s.sha256,s.compressed_bytes,s.raw_path FROM formulary_shard f
      LEFT JOIN snapshot s ON s.snapshot_id=f.raw_snapshot_id WHERE f.source_set_id=$1`,
        [report.snapshot_id],
      )
    ).rows;
    const sample = await createDrugRepository(db).drugCoverage(
      String(plans[0]?.base_hios_id),
      "311354",
      2026,
    );
    await mkdir(join(cache, "reports"), { recursive: true });
    const output = join(
      cache,
      "reports",
      process.env.OPENPLANS_FORMULARY_REPORT ?? "p2c-formulary-realdata.json",
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          database: "PGlite file; PostGIS migration omitted",
          path,
          report,
          flags,
          plans,
          sample,
          sample_edges: sampleEdges,
          rxcuis: codes,
          tiers,
          shards,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ report: output, flags }));
  }
} catch {
  console.error(
    "Formulary PGlite run failed; check real cached databases and schema",
  );
  process.exitCode = 1;
} finally {
  await pg?.close();
  await rm(directory, { recursive: true, force: true });
}
