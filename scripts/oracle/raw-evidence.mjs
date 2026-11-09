#!/usr/bin/env node
/** Public raw evidence checks; missing optional prepared databases are explicit skips. */
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonArray } from "../../dist/ingest/json/index.js";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";
import { database } from "./negative-controls.mjs";
import { runGeocodeOracle } from "./geocode.mjs";

const key = (row) =>
  JSON.stringify([row.rxcui, row.base_hios_id, row.plan_year]);
const facts = (rows) =>
  JSON.stringify([...new Set(rows.map((row) => JSON.stringify(row)))].sort());
export function compareRawDrugFacts(actual, published) {
  const mismatches = actual.filter(
    (row) => facts(row.facts) !== facts(published.get(key(row)) ?? []),
  );
  return {
    passed: actual.length > 0 && !mismatches.length,
    pairs: actual.length,
    mismatches,
  };
}

async function drugRaw(path) {
  const db = database(new PGlite(path));
  try {
    const shards = (
      await db.query(`SELECT p.raw_path,p.sha256 FROM formulary_active_set a
      JOIN formulary_shard s ON s.source_set_id=a.snapshot_id JOIN snapshot p ON p.snapshot_id=s.raw_snapshot_id
      WHERE a.issuer_id='76589' AND a.plan_year=2026 AND a.state='TX'`)
    ).rows;
    const sample = (
      await db.query(`SELECT e.rxcui,e.base_hios_id,e.plan_year,
      jsonb_agg(DISTINCT jsonb_build_array(e.drug_tier,e.prior_authorization,e.step_therapy,e.quantity_limit)) AS facts
      FROM formulary_active_set a JOIN formulary_shard s ON s.source_set_id=a.snapshot_id
      JOIN formulary_edge e ON e.snapshot_id=s.snapshot_id
      WHERE a.issuer_id='76589' AND a.plan_year=2026 AND a.state='TX'
      GROUP BY e.rxcui,e.base_hios_id,e.plan_year ORDER BY md5(e.rxcui||':'||e.base_hios_id),e.rxcui,e.base_hios_id LIMIT 5000`)
    ).rows;
    if (!shards.length || !sample.length)
      throw new Error("Raw drug check needs ACTIVE Cigna TX PY2026 evidence");
    const selected = new Set(sample.map(key)),
      published = new Map();
    for (const shard of shards) {
      const hash = createHash("sha256");
      async function* bytes() {
        for await (const chunk of createReadStream(shard.raw_path)) {
          hash.update(chunk);
          yield chunk;
        }
      }
      for await (const drug of readJsonArray(bytes()))
        for (const edge of drug.plans) {
          if (!edge.years?.includes(2026)) continue;
          const id = key({
            rxcui: drug.rxnorm_id,
            base_hios_id: edge.plan_id,
            plan_year: 2026,
          });
          if (!selected.has(id)) continue;
          if (!published.has(id)) published.set(id, []);
          published
            .get(id)
            .push([
              edge.drug_tier,
              ...["prior_authorization", "step_therapy", "quantity_limit"].map(
                (k) => edge[k] ?? null,
              ),
            ]);
        }
      if (hash.digest("hex") !== shard.sha256)
        throw new Error("Raw drug source hash mismatch");
    }
    const result = compareRawDrugFacts(sample, published);
    const mutant = structuredClone(sample);
    mutant[0].facts[0][1] = !mutant[0].facts[0][1];
    const broken = compareRawDrugFacts(mutant, published);
    const control = {
      name: "flipped_PA_flag",
      passed: result.passed && !broken.passed,
    };
    return {
      ...result,
      passed: result.passed && control.passed,
      negative_controls: [control],
    };
  } finally {
    await db.close();
  }
}

async function providerRaw(path, scratch) {
  const db = database(new PGlite(path));
  const actual = join(scratch, "provider-actual.jsonl"),
    output = join(scratch, "provider-raw.json");
  const out = await open(actual, "wx");
  let shard;
  try {
    const shards = (
      await db.query(`SELECT s.raw_path,s.sha256,f.status FROM provider_active_set a
      JOIN provider_shard f ON f.source_set_id=a.snapshot_id JOIN snapshot s ON s.snapshot_id=f.raw_snapshot_id
      WHERE a.issuer_id='76589' AND a.state='TX' AND a.plan_year=2026`)
    ).rows;
    if (shards.length !== 1 || shards[0].status !== "complete")
      throw new Error(
        "Raw provider check needs one complete ACTIVE Cigna TX PY2026 shard",
      );
    shard = shards[0];
    const plans = (
      await db.query(`SELECT DISTINCT p.base_hios_id FROM provider_active_set a
      JOIN provider_shard s ON s.source_set_id=a.snapshot_id JOIN qhp_provider_plan p ON p.snapshot_id=s.snapshot_id
      WHERE a.issuer_id='76589' AND a.state='TX' AND a.plan_year=2026`)
    ).rows;
    for (const { base_hios_id: plan } of plans) {
      const rows = (
        await db.query(
          `SELECT r.npi,count(*)::int AS n FROM provider_active_set a
        JOIN provider_shard s ON s.source_set_id=a.snapshot_id JOIN qhp_provider_plan p ON p.snapshot_id=s.snapshot_id
        JOIN qhp_provider_record r ON r.snapshot_id=p.snapshot_id AND r.record_id=p.record_id
        WHERE a.issuer_id='76589' AND a.state='TX' AND a.plan_year=2026 AND p.plan_year=2026
        AND p.base_hios_id=$1 AND r.npi IS NOT NULL GROUP BY r.npi ORDER BY r.npi`,
          [plan],
        )
      ).rows;
      await out.write(
        rows
          .map((row) => JSON.stringify([row.npi, plan, row.n]) + "\n")
          .join(""),
      );
    }
  } finally {
    await out.close();
    await db.close();
  }
  await new Promise((accept, reject) => {
    const child = spawn(
      "python3",
      [
        "-B",
        fileURLToPath(new URL("provider_raw.py", import.meta.url)),
        "--actual",
        actual,
        "--current",
        shard.raw_path,
        "--output",
        output,
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept()
        : reject(new Error(`Raw provider check failed (${code})`)),
    );
  });
  const result = JSON.parse(await readFile(output, "utf8"));
  if (result.source.sha256 !== shard.sha256)
    throw new Error("Raw provider source hash mismatch");
  return result;
}

export async function rawEvidence(cache) {
  await mkdir(join(cache, "reports"), { recursive: true });
  const scratch = await mkdtemp(join(cache, "reports/.raw-evidence-"));
  const result = { passed: true, checks: {} };
  try {
    for (const [kind, path, check] of [
      [
        "drugs",
        process.env.OPENPLANS_FORMULARY_DB ??
          join(cache, "formulary-pglite-p2d"),
        drugRaw,
      ],
      [
        "providers",
        process.env.OPENPLANS_PROVIDER_DB ?? join(cache, "provider-pglite-p3b"),
        providerRaw,
      ],
      [
        "geocode",
        process.env.OPENPLANS_GEOCODE_DB ?? join(cache, "geocode-pglite-p3c"),
        () => runGeocodeOracle(cache, scratch),
      ],
    ]) {
      try {
        await access(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        result.checks[kind] = {
          status: "skipped",
          reason: "optional prepared public-data database is absent",
        };
        console.log(`raw evidence: ${kind} SKIP (prepared database absent)`);
        continue;
      }
      result.checks[kind] = await check(path, scratch);
      result.passed &&= result.checks[kind].passed;
    }
    await writeFile(
      join(cache, "reports/public-raw-evidence.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    if (!result.passed)
      throw new Error("Raw evidence mismatch or negative control failure");
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await rawEvidence(importDataDirectory());
}
