import { createReadStream } from "node:fs";
import { readCsv } from "@openplans/plugin-sdk";
import type { Database, SqlSession } from "@openplans/plugin-sdk";
import type { AcquiredRelease } from "./release.js";

export interface TaxonomyRow {
  code: string;
  display_name: string;
  classification: string;
  specialization: string | null;
}
/** The JSON line `worker ingest taxonomy` prints after an import. */
export interface TaxonomyImport {
  version: string;
  source_url: string;
  snapshot_id: string;
  codes: number;
}

const REQUIRED_HEADERS = [
  "Code",
  "Classification",
  "Specialization",
  "Display Name",
];
const INSERT_BATCH = 500;

/** Reads every code from a NUCC CSV. Throws on a missing header, a bad code or an empty file. */
export async function parseTaxonomy(path: string): Promise<TaxonomyRow[]> {
  const rows: TaxonomyRow[] = [];
  const stream = createReadStream(path);
  let headersChecked = false;
  for await (const row of readCsv(stream, { maxRecordLength: 1024 * 1024 })) {
    const v = row.values;
    if (!headersChecked) {
      for (const field of REQUIRED_HEADERS)
        if (!(field in v)) throw new Error(`NUCC missing ${field}`);
      headersChecked = true;
    }
    const code = v.Code!.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(code))
      throw new Error(`Invalid NUCC taxonomy code at row ${row.rowNumber}`);
    if (!v["Display Name"]!.trim() || !v.Classification!.trim())
      throw new Error(`Incomplete NUCC taxonomy row ${row.rowNumber}`);
    rows.push({
      code,
      display_name: v["Display Name"]!.trim(),
      classification: v.Classification!.trim(),
      specialization: v.Specialization!.trim() || null,
    });
  }
  if (!headersChecked || !rows.length)
    throw new Error("Empty NUCC taxonomy CSV");
  return rows;
}

/**
 * Records the release as an ACTIVE snapshot named by the CSV's SHA-256 and replaces every
 * `provider_taxonomy` row with this release's codes. A release already imported keeps its
 * snapshot row; its codes are written again.
 */
export async function writeTaxonomy(
  tx: SqlSession,
  release: AcquiredRelease,
  rows: readonly TaxonomyRow[],
): Promise<TaxonomyImport> {
  await tx.query(`INSERT INTO source(source_id,publisher,source_kind) VALUES ('nucc-provider-taxonomy','National Uniform Claim Committee','taxonomy')
      ON CONFLICT(source_id) DO NOTHING`);
  await tx.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,retrieved_at,http_status,content_type,
      compressed_bytes,uncompressed_bytes,sha256,raw_path,schema_version,expected_children,fetched_children,validation_state,activated_at)
      VALUES ($1,'nucc-provider-taxonomy',$2,$2,now(),200,'text/csv',$3,$3,$1,$4,$5,1,1,'ACTIVE',now()) ON CONFLICT(snapshot_id) DO NOTHING`,
    [
      release.metadata.sha256,
      release.url,
      release.metadata.bytes,
      release.path,
      release.version,
    ],
  );
  await tx.query("DELETE FROM provider_taxonomy");
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH),
      values: unknown[] = [];
    const tuples = batch.map((row) => {
      values.push(
        row.code,
        row.display_name,
        row.classification,
        row.specialization,
        release.version,
        release.metadata.sha256,
      );
      const j = values.length - 5;
      return `($${j},$${j + 1},$${j + 2},$${j + 3},$${j + 4},$${j + 5})`;
    });
    await tx.query(
      `INSERT INTO provider_taxonomy(code,display_name,classification,specialization,version,snapshot_id) VALUES ${tuples.join(",")}
        ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,classification=excluded.classification,
          specialization=excluded.specialization,version=excluded.version,snapshot_id=excluded.snapshot_id`,
      values,
    );
  }
  return {
    version: release.version,
    source_url: release.url,
    snapshot_id: release.metadata.sha256,
    codes: rows.length,
  };
}

/** Parses, then writes in one transaction. `worker bootstrap --with-nucc-taxonomy` uses this. */
export async function importTaxonomy(
  db: Database,
  release: AcquiredRelease,
): Promise<TaxonomyImport> {
  const rows = await parseTaxonomy(release.path);
  return db.transaction((tx) => writeTaxonomy(tx, release, rows));
}
