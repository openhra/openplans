import type { SqlSession } from "../../db/database.js";
import type { GeoFile } from "./sources.js";

export const geonamesAttribution = {
  publisher: "GeoNames",
  url: "https://www.geonames.org/",
  license: "CC BY 4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
};
export async function saveFallbackSnapshot(
  db: SqlSession,
  file: GeoFile,
  publisher: string,
  requestedUrl: string,
  terms: string,
  snapshotId?: string,
): Promise<string> {
  const m = file.metadata,
    id = snapshotId ?? `${m.source}:${m.sha256}`;
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES($1,$2,'geography',$3,$4) ON CONFLICT DO NOTHING`,
    [m.source, publisher, JSON.stringify([requestedUrl]), terms],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,
    retrieved_at,http_status,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,
    terms_review_reference,expected_children,fetched_children,validation_state,activated_at)
    VALUES($1,$2,$3,$3,'[]',$4,$5,$6,$7,$8,$9,'zip-counties-v1','geo-fallback-v1',$10,0,0,'ACTIVE',now())
    ON CONFLICT DO NOTHING`,
    [
      id,
      m.source,
      requestedUrl,
      m.fetched_at,
      m.status,
      m.content_type,
      m.bytes,
      m.sha256,
      file.path,
      terms,
    ],
  );
  return id;
}
