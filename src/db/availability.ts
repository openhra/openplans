import type { SqlSession } from './database.js';

export type CoverageStatus = 'not_yet_verified' | 'available' | 'partial' | 'unknown'
  | 'unavailable' | 'unsupported' | 'stale' | 'conflicted';

export interface CoverageEntry extends Record<string, unknown> {
  state: string;
  plan_year: number;
  market: string;
  issuer_id: string | null;
  catalog_status: CoverageStatus;
  premium_status: CoverageStatus;
  provider_status: CoverageStatus;
  formulary_status: CoverageStatus;
  snapshot_id: string;
}

export async function checkDatabase(db: SqlSession): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function coverageManifest(db: SqlSession): Promise<CoverageEntry[]> {
  const { rows } = await db.query<CoverageEntry>(`
    SELECT state, plan_year, market, issuer_id, catalog_status, premium_status,
           provider_status, formulary_status, snapshot_id
    FROM data_availability
    ORDER BY state, plan_year, market, issuer_id NULLS FIRST
  `);
  return rows;
}
