import type { SqlSession } from "../../db/database.js";
import { validNpi } from "./parse.js";
export interface Provider extends Record<string, unknown> {
  npi: string;
  entity_type: "1" | "2" | null;
  deactivated: boolean;
  snapshot_id: string;
  addresses: Record<string, unknown>[];
  taxonomies: Record<string, unknown>[];
}
const projection = `p.*,p.enumeration_date::text enumeration_date,p.last_update_date::text last_update_date,
  p.deactivation_date::text deactivation_date,p.reactivation_date::text reactivation_date,p.data_date::text data_date,
  COALESCE((SELECT jsonb_agg(a ORDER BY kind,ordinal) FROM npi_address a WHERE a.npi=p.npi),'[]'::jsonb) addresses,
  COALESCE((SELECT jsonb_agg(t ORDER BY ordinal) FROM npi_taxonomy t WHERE t.npi=p.npi),'[]'::jsonb) taxonomies`;
/** Includes deactivated and formerly in-state identities, with explicit status and snapshot provenance. */
export async function providerByNpi(
  db: SqlSession,
  npi: string,
): Promise<Provider | null> {
  if (!validNpi(npi)) throw new Error("Invalid NPI");
  return (
    (
      await db.query<Provider>(
        `SELECT ${projection} FROM npi_provider p WHERE p.npi=$1`,
        [npi],
      )
    ).rows[0] ?? null
  );
}
/** Exact ZIP5 practice-location match only: no coordinates, radius or participation claim. */
export async function providersNearZip(
  db: SqlSession,
  zip: string,
  specialtyTaxonomy?: string,
  state?: string,
): Promise<Provider[]> {
  if (
    !/^\d{5}$/.test(zip) ||
    (specialtyTaxonomy !== undefined &&
      !/^[A-Z0-9]{10}$/.test(specialtyTaxonomy)) ||
    (state !== undefined && !/^[A-Z]{2}$/.test(state))
  )
    throw new Error("Invalid ZIP/taxonomy/state");
  return (
    await db.query<Provider>(
      `SELECT ${projection} FROM npi_provider p WHERE p.in_scope
    AND EXISTS(SELECT 1 FROM npi_address a WHERE a.npi=p.npi AND a.kind='practice' AND a.zip5=$1)
    AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM npi_taxonomy t WHERE t.npi=p.npi AND t.code=$2))
    AND EXISTS(SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.in_scope
      AND ($3::text IS NULL OR s.state_filter=$3)) ORDER BY p.npi`,
      [zip, specialtyTaxonomy ?? null, state ?? null],
    )
  ).rows;
}
