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
  hios_id: string | null; hios_match: 'matched' | 'ambiguous' | 'none' | null;
  hios_match_reason: string | null; hios_candidates: Record<string, unknown>[] | null;
  hios_match_rule: string | null; hios_match_provenance: Record<string, unknown> | null;
  sbe_exchange?: { on_exchange: boolean; off_exchange: boolean;
    snapshot_id: string; source_rows: number[] } | null;
}
export async function stateCatalog(db: SqlSession, year: number, state?: string, key?: string, region?: string) {
  return (await db.query<StateCatalogRow>(`SELECT a.state,a.plan_year,r.*,i.rules_document,
    h.hios_id,h.hios_match,h.reason AS hios_match_reason,h.candidates AS hios_candidates,
    h.rule_version AS hios_match_rule,e.sbe_exchange,
    CASE WHEN h.state_import_id IS NOT NULL THEN jsonb_build_object(
      'state_import_id',h.state_import_id,'publication_snapshot_id',h.publication_snapshot_id,
      'filed',h.filed_provenance,'sbe_import_id',h.sbe_import_id) END AS hios_match_provenance
    FROM state_rate_active a
    JOIN state_rate_import i ON i.import_id=a.import_id
    JOIN snapshot s ON s.snapshot_id=i.import_id AND s.validation_state='ACTIVE'
    JOIN state_community_rate r ON r.import_id=i.import_id
    LEFT JOIN state_vt_hios_current h ON h.state_import_id=r.import_id
      AND h.source_index=r.source_index AND h.record_index=r.record_index
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('on_exchange',bool_or(pa.on_exchange),
        'off_exchange',bool_or(pa.off_exchange),'snapshot_id',f.snapshot_id,
        'source_rows',jsonb_agg(pa.source_row ORDER BY pa.source_row)) AS sbe_exchange
      FROM puf_import_file f JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id
      WHERE f.import_id=h.sbe_import_id AND f.kind='plan-attributes'
        AND h.hios_match='matched' AND pa.base_plan_id=h.hios_id
        AND pa.state='VT' AND pa.plan_year=a.plan_year AND pa.market='Individual' AND NOT pa.dental_only
      GROUP BY f.snapshot_id
    ) e ON true
    WHERE a.plan_year=$1 AND ($2::text IS NULL OR a.state=$2)
      AND ($3::text IS NULL OR r.plan_key=$3 OR h.hios_id=$3) AND ($4::text IS NULL OR r.region=$4)
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
