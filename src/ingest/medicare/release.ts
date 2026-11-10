import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Database, SqlSession } from "../../db/database.js";
import type { CachedArchive } from "./acquire.js";
import { labelDate, sourceIds } from "./sources.js";

export const termsReference =
  "https://www.cms.gov/about-cms/web-policies-important-links/about-website/link-to-us";
const lock = 1835365731; // "medc"

export interface ReleaseReport {
  family: string;
  contract_year: number;
  snapshot_id: string;
  as_of: string;
  as_of_label: string;
  member: string;
  outcome: "imported" | "noop";
  counts: Record<string, number>;
  elapsed_ms: number;
}

async function verify(path: string, sha256: string, bytes: number) {
  const hash = createHash("sha256");
  let seen = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    seen += (chunk as Buffer).length;
  }
  if (hash.digest("hex") !== sha256 || seen !== bytes)
    throw new Error("Medicare archive hash mismatch");
}

export function snapshotIdFor(cached: CachedArchive): string {
  return `${sourceIds[cached.archive.family]}-${cached.archive.label}-${cached.metadata.sha256}`;
}

/**
 * One transaction per archive under an advisory lock. Bytes are re-hashed first. A failure marks the
 * snapshot QUARANTINED and leaves earlier ACTIVE releases serving.
 */
export async function importRelease(
  db: Database,
  cached: CachedArchive,
  member: string,
  load: (tx: SqlSession, snapshotId: string) => Promise<Record<string, number>>,
): Promise<ReleaseReport> {
  const started = Date.now();
  const { archive, metadata } = cached;
  if (
    metadata.source !== sourceIds[archive.family] ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error("Invalid Medicare provenance");
  await verify(cached.path, metadata.sha256, metadata.bytes);
  const snapshotId = snapshotIdFor(cached);
  const fallbackDate = metadata.last_modified
    ? new Date(metadata.last_modified).toISOString().slice(0, 10)
    : metadata.fetched_at.slice(0, 10);
  const asOf = labelDate(archive.label, fallbackDate);
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
     VALUES ($1,'Centers for Medicare & Medicaid Services','cms-medicare',$2::jsonb,$3) ON CONFLICT DO NOTHING`,
    [
      sourceIds[archive.family],
      JSON.stringify([
        {
          url: termsReference,
          access: "public domain web site; no registration",
        },
      ]),
      termsReference,
    ],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
      publisher_updated_at,http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,
      schema_version,parser_version,terms_review_reference,expected_children)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'1',$16,1) ON CONFLICT DO NOTHING`,
    [
      snapshotId,
      sourceIds[archive.family],
      metadata.url,
      metadata.final_url,
      JSON.stringify(metadata.redirect_chain),
      metadata.fetched_at,
      asOf,
      metadata.status,
      metadata.etag,
      metadata.last_modified,
      metadata.content_type,
      metadata.bytes,
      metadata.sha256,
      cached.path,
      `cms-medicare-${archive.family}`,
      termsReference,
    ],
  );
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [lock]);
      const existing = (
        await tx.query<{ snapshot_id: string; counts: Record<string, number> }>(
          "SELECT snapshot_id,counts FROM medicare_release WHERE family=$1 AND contract_year=$2 AND as_of_label=$3",
          [archive.family, archive.year, archive.label],
        )
      ).rows[0];
      if (existing) {
        if (existing.snapshot_id !== snapshotId)
          throw new Error(
            "Medicare release label already imported with different bytes",
          );
        return {
          family: archive.family,
          contract_year: archive.year,
          snapshot_id: snapshotId,
          as_of: asOf,
          as_of_label: archive.label,
          member,
          outcome: "noop" as const,
          counts: existing.counts,
          elapsed_ms: Date.now() - started,
        };
      }
      await tx.query(
        `INSERT INTO medicare_release(snapshot_id,family,contract_year,as_of,as_of_label,member_name)
         VALUES($1,$2,$3,$4::date,$5,$6)`,
        [snapshotId, archive.family, archive.year, asOf, archive.label, member],
      );
      const counts = await load(tx, snapshotId);
      await tx.query(
        "UPDATE medicare_release SET counts=$2::jsonb WHERE snapshot_id=$1",
        [snapshotId, JSON.stringify(counts)],
      );
      await tx.query(
        "UPDATE snapshot SET validation_state='ACTIVE',fetched_children=1,activated_at=now() WHERE snapshot_id=$1",
        [snapshotId],
      );
      return {
        family: archive.family,
        contract_year: archive.year,
        snapshot_id: snapshotId,
        as_of: asOf,
        as_of_label: archive.label,
        member,
        outcome: "imported" as const,
        counts,
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

/** Bounded multi-row insert; identifiers are internal constants, values are parameters. */
export async function insertRows(
  tx: SqlSession,
  table: string,
  columns: readonly string[],
  batch: unknown[][],
): Promise<void> {
  if (!batch.length) return;
  const tuples = batch
    .map(
      (row, i) =>
        `(${row.map((_, j) => `$${i * columns.length + j + 1}`).join(",")})`,
    )
    .join(",");
  await tx.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples}`,
    batch.flat(),
  );
  batch.length = 0;
}

/** Newest ACTIVE release of a family for a year (or the newest year at or below it). */
export const activeRelease = (
  family: string,
) => `(SELECT r.snapshot_id FROM medicare_release r
  JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE' AND r.family='${family}'
  AND r.contract_year=$YEAR ORDER BY r.as_of DESC, r.imported_at DESC LIMIT 1)`;
