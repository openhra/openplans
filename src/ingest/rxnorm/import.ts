import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Database, SqlSession } from "../../db/database.js";
import type { SnapshotMetadata } from "../../fetch/index.js";
import { sourceId } from "./acquire.js";
import { archiveInput, rrfRecords } from "./rrf.js";
import type { RrfFile, RrfInput } from "./rrf.js";

export const relations = new Set([
  "has_ingredient",
  "ingredient_of",
  "has_precise_ingredient",
  "precise_ingredient_of",
  "tradename_of",
  "has_tradename",
  "consists_of",
  "constitutes",
  "has_dose_form",
  "dose_form_of",
  "form_of",
  "has_form",
  "contains",
  "contained_in",
  "has_part",
  "part_of",
]);
export interface ImportOptions {
  version: string;
  path: string;
  metadata: SnapshotMetadata;
  /** Trusted offline fixture adapter; production always reads the verified ZIP. */
  input?: RrfInput;
}
export interface ImportReport {
  snapshot_id: string;
  source_version: string;
  outcome: "imported" | "noop";
  concepts: number;
  relations: number;
  ndcs: number;
  elapsed_ms: number;
}
const terms =
  "https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html";
function numeric(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value))
    throw new Error("Invalid RxNorm identifier");
  return value;
}
async function verify(path: string, metadata: SnapshotMetadata) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (hash.digest("hex") !== metadata.sha256 || bytes !== metadata.bytes)
    throw new Error("RxNorm archive hash mismatch");
}
async function insertBatch(
  tx: SqlSession,
  table: string,
  columns: string[],
  batch: unknown[][],
  filter = "",
) {
  if (!batch.length) return;
  // All identifiers are internal constants, values are parameters. Bounded batch, no giant feed buffers.
  const values = batch.flat();
  const tuples = batch
    .map(
      (row, i) =>
        `(${row.map((_, j) => `$${i * columns.length + j + 1}`).join(",")})`,
    )
    .join(",");
  const projection = columns
    .map((column) =>
      column === "source_record" ? "v.source_record::bigint" : `v.${column}`,
    )
    .join(",");
  await tx.query(
    `INSERT INTO ${table} (${columns.join(",")}) SELECT ${projection} FROM (VALUES ${tuples}) AS v(${columns.join(",")}) ${filter} ON CONFLICT DO NOTHING`,
    values,
  );
  batch.length = 0;
}

export async function importRxnorm(
  db: Database,
  options: ImportOptions,
): Promise<ImportReport> {
  const started = Date.now(),
    { version, metadata } = options;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(version) ||
    new Date(version).toISOString().slice(0, 10) !== version ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    metadata.source !== sourceId
  )
    throw new Error("Invalid RxNorm provenance");
  await verify(options.path, metadata);
  const snapshotId = `rxnorm-${version}-${metadata.sha256}`;
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES ($1,'National Library of Medicine','rxnorm',$2::jsonb,$3) ON CONFLICT DO NOTHING`,
    [
      sourceId,
      JSON.stringify([{ url: terms, access: "public CPC; no UMLS login" }]),
      terms,
    ],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
    publisher_updated_at,http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,terms_review_reference,expected_children)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,'rxnorm-rrf','1',$15,3) ON CONFLICT DO NOTHING`,
    [
      snapshotId,
      sourceId,
      metadata.url,
      metadata.final_url,
      JSON.stringify(metadata.redirect_chain),
      metadata.fetched_at,
      version,
      metadata.status,
      metadata.etag,
      metadata.last_modified,
      metadata.content_type,
      metadata.bytes,
      metadata.sha256,
      options.path,
      terms,
    ],
  );
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(1869636976)");
      const existing = (
        await tx.query<{
          snapshot_id: string;
          concept_count: number;
          relation_count: number;
          ndc_count: number;
        }>("SELECT * FROM rx_release WHERE source_version=$1::date", [version])
      ).rows[0];
      if (existing) {
        if (existing.snapshot_id !== snapshotId)
          throw new Error(
            "RxNorm release date already imported with different bytes",
          );
        return {
          snapshot_id: snapshotId,
          source_version: version,
          outcome: "noop",
          concepts: existing.concept_count,
          relations: existing.relation_count,
          ndcs: existing.ndc_count,
          elapsed_ms: Date.now() - started,
        };
      }
      const input = options.input ?? (await archiveInput(options.path));
      await tx.query(
        "INSERT INTO rx_release(snapshot_id,source_version) VALUES($1,$2::date)",
        [snapshotId, version],
      );
      for (const name of [
        "RXNCONSO.RRF",
        "RXNREL.RRF",
        "RXNSAT.RRF",
      ] as RrfFile[]) {
        let table;
        if (name === "RXNCONSO.RRF") {
          table = "rx_concept";
        } else if (name === "RXNREL.RRF") {
          table = "rx_relation";
        } else {
          table = "rx_ndc";
        }
        let columns;
        if (name === "RXNCONSO.RRF") {
          columns = [
            "snapshot_id",
            "rxcui",
            "rxaui",
            "name",
            "tty",
            "suppress",
            "source_record",
          ];
        } else if (name === "RXNREL.RRF") {
          columns = [
            "snapshot_id",
            "source_rxcui",
            "target_rxcui",
            "rela",
            "suppress",
            "source_record",
          ];
        } else {
          columns = [
            "snapshot_id",
            "rxcui",
            "ndc",
            "suppress",
            "source_record",
          ];
        }
        let filter;
        if (name === "RXNCONSO.RRF") {
          filter = "";
        } else if (name === "RXNREL.RRF") {
          filter =
            "WHERE EXISTS(SELECT 1 FROM rx_concept c WHERE c.snapshot_id=v.snapshot_id AND c.rxcui=v.source_rxcui) AND EXISTS(SELECT 1 FROM rx_concept c WHERE c.snapshot_id=v.snapshot_id AND c.rxcui=v.target_rxcui)";
        } else {
          filter =
            "WHERE EXISTS(SELECT 1 FROM rx_concept c WHERE c.snapshot_id=v.snapshot_id AND c.rxcui=v.rxcui)";
        }
        const batch: unknown[][] = [];
        let line = 0;
        for await (const fields of rrfRecords(input(name), name)) {
          line++;
          if (name === "RXNCONSO.RRF") {
            if (fields[11] !== "RXNORM") continue;
            if (!fields[14] || !fields[12])
              throw new Error("Missing RxNorm name or TTY");
            batch.push([
              snapshotId,
              numeric(fields[0]),
              numeric(fields[7]),
              fields[14],
              fields[12],
              fields[16],
              line,
            ]);
          } else if (name === "RXNREL.RRF") {
            if (
              fields[10] !== "RXNORM" ||
              !relations.has(fields[7]!) ||
              !fields[0] ||
              !fields[4]
            )
              continue;
            batch.push([
              snapshotId,
              numeric(fields[4]),
              numeric(fields[0]),
              fields[7],
              fields[14],
              line,
            ]);
          } else {
            if (fields[9] !== "RXNORM" || fields[8] !== "NDC") continue;
            if (!/^\d{11}$/.test(fields[10]!))
              throw new Error("RXNORM NDC must be 11 published digits");
            batch.push([
              snapshotId,
              numeric(fields[0]),
              fields[10],
              fields[11],
              line,
            ]);
          }
          if (batch.length >= 500)
            await insertBatch(tx, table, columns, batch, filter);
        }
        await insertBatch(tx, table, columns, batch, filter);
      }
      const counts = (
        await tx.query<{ concepts: number; relations: number; ndcs: number }>(
          `SELECT
        (SELECT count(*)::int FROM rx_concept WHERE snapshot_id=$1) AS concepts,
        (SELECT count(*)::int FROM rx_relation WHERE snapshot_id=$1) AS relations,
        (SELECT count(*)::int FROM rx_ndc WHERE snapshot_id=$1) AS ndcs`,
          [snapshotId],
        )
      ).rows[0]!;
      if (!counts.concepts || !counts.relations || !counts.ndcs)
        throw new Error("Incomplete/empty RxNorm source set");
      await tx.query(
        "UPDATE rx_release SET concept_count=$2,relation_count=$3,ndc_count=$4 WHERE snapshot_id=$1",
        [snapshotId, counts.concepts, counts.relations, counts.ndcs],
      );
      await tx.query(
        "UPDATE snapshot SET validation_state='ACTIVE',fetched_children=3,activated_at=now() WHERE snapshot_id=$1",
        [snapshotId],
      );
      return {
        snapshot_id: snapshotId,
        source_version: version,
        outcome: "imported",
        ...counts,
        elapsed_ms: Date.now() - started,
      };
    });
  } catch (error) {
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1 AND validation_state<>'ACTIVE'",
      [snapshotId],
    );
    throw error;
  }
}
