import { readFile } from 'node:fs/promises';
import type { SqlSession } from '../../db/database.js';
import type { CommunityFamilyRule, CommunityRate } from '../../domain/rating/index.js';
import { parseCommunityRules } from './index.js';

const geography = JSON.parse(await readFile(new URL('../../../data/rating-rules/state-geography-2026.json', import.meta.url), 'utf8')) as {
  plan_year: number;
  NY: { citation: string; references: string[]; source_sha256: string;
    counties: { county_fips: string; county: string; rating_area_id: string; region: string }[] };
  VT: { region: string; citation: string; references: string[] };
};

/** NY rate evidence is regional, not proof of county-specific enrollment eligibility.
 * VT guidance explicitly makes every Vermont ZIP part of the service area. */
export function stateRatingArea(state: string, year: number, county: string) {
  if (year !== geography.plan_year) return null;
  if (state === 'VT' && /^50(00[13579]|01[13579]|02[1357])$/.test(county)) {
    return { rating_area_id: geography.VT.region, citation: geography.VT.citation, references: geography.VT.references,
      scope: 'statewide' as const };
  }
  if (state !== 'NY') return null;
  const row = geography.NY.counties.find(row => row.county_fips === county);
  return row ? { rating_area_id: row.rating_area_id, citation: geography.NY.citation, references: geography.NY.references,
    source_sha256: geography.NY.source_sha256, county_fips: county, scope: 'rating_area' as const } : null;
}

export interface StateCatalogRow extends Record<string, unknown> {
  state: 'NY' | 'VT'; plan_year: number; import_id: string; publication_snapshot_id: string;
  record_index: number; plan_key: string; region: string; rate: CommunityRate;
  raw_record: { plan_id: string | null; issuer: string; plan_name?: string; metal: string | null;
    exchange: string; prices: Record<string, string>; raw: Record<string, string> };
  rules_document: unknown;
}
export async function stateCatalog(db: SqlSession, year: number, state?: string, key?: string, region?: string) {
  return (await db.query<StateCatalogRow>(`SELECT a.state,a.plan_year,r.*,i.rules_document FROM state_rate_active a
    JOIN state_rate_import i ON i.import_id=a.import_id
    JOIN snapshot s ON s.snapshot_id=i.import_id AND s.validation_state='ACTIVE'
    JOIN state_community_rate r ON r.import_id=i.import_id
    WHERE a.plan_year=$1 AND ($2::text IS NULL OR a.state=$2)
      AND ($3::text IS NULL OR r.plan_key=$3) AND ($4::text IS NULL OR r.region=$4)
    ORDER BY r.plan_key,r.region,r.source_index,r.record_index`, [year, state ?? null, key ?? null, region ?? null])).rows;
}
export function catalogRule(row: StateCatalogRow): CommunityFamilyRule | null {
  // Revalidate the stored authorization at the API boundary; a per-age mutant
  // must not be accepted even if the import pointer is otherwise active.
  try { return parseCommunityRules(JSON.stringify(row.rules_document)).find(rule => rule.state === row.state) ?? null; }
  catch { return null; }
}
export function stateSourceCell(row: StateCatalogRow, tier: string) {
  const column = row.state === 'NY' ? ({ single: 'E', couple: 'G', adult_children: 'H:J', family: 'K:M' } as Record<string, string>)[tier] : tier;
  return { publication_snapshot_id: row.publication_snapshot_id, source_url: row.rate.provenance.sourceUrl,
    source_sha256: row.rate.provenance.sourceSha256, source_record: row.rate.provenance.sourceRecord,
    column, tier, value: row.raw_record.prices[tier], currency: 'USD', period: 'month' };
}
