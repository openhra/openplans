import { catalogRule, stateCatalog, stateRatingArea } from '../ingest/state/catalog.js';
import { providerAvailability } from '../domain/providers/availability.js';
import { drugAvailability } from '../domain/drugs/availability.js';
import { coverageManifest } from '../db/availability.js';
import type { SqlSession } from '../db/database.js';
import { ratingRule } from '../ingest/rating-rules/index.js';

/** Imported rate evidence and supported rating policy are separate requirements. */
export async function dataAvailability(db: SqlSession): Promise<Record<string, unknown>[]> {
  const manifest = await coverageManifest(db);
  const drugs = await drugAvailability(db);
  const providers = await providerAvailability(db);
  const geography = (await db.query<{ state: string; plan_year: number; county_areas: number; zip3_areas: number }>(`
    SELECT g.state,g.plan_year,
      (SELECT count(*)::int FROM rating_area r WHERE r.snapshot_id=g.rating_snapshot_id AND r.state=g.state AND r.plan_year=g.plan_year) AS county_areas,
      (SELECT count(*)::int FROM rating_area_zip z WHERE z.snapshot_id=g.rating_snapshot_id AND z.state=g.state AND z.plan_year=g.plan_year) AS zip3_areas
    FROM geo_import g`)).rows;
  const entryAvailability = async (entry: typeof manifest[number]) => {
    const drug = drugs.find(d => d.issuer_id === entry.issuer_id && d.plan_year === entry.plan_year && d.state === entry.state);
    const result = { ...entry, drug_coverage: drug ?? { status: 'unknown', reason: 'source_set_not_available' },
      drug_status: drug?.status ?? 'unknown' };
    if (drug && drug.status !== 'complete') result.formulary_status = 'unknown';
    for (const key of ['catalog_status', 'premium_status', 'provider_status', 'formulary_status'] as const) {
      if (result[key] === 'not_yet_verified') result[key] = 'unknown';
    }
    if (entry.catalog_status !== 'available') return result;
    const { rows } = await db.query<{ snapshot_id: string; rate_rows: number; medical_plans: number }>(`
      SELECT rf.snapshot_id, count(r.base_plan_id)::int AS rate_rows,
        count(DISTINCT p.base_plan_id)::int AS medical_plans
      FROM puf_active_catalog a
      JOIN puf_import_file pf ON pf.import_id=a.import_id AND pf.kind='plan-attributes'
      JOIN puf_import_file rf ON rf.import_id=a.import_id AND rf.kind='rate'
      LEFT JOIN plan p ON p.snapshot_id=pf.snapshot_id AND NOT p.dental_only AND p.market=$3
        AND ($4::text IS NULL OR p.issuer_id=$4)
      LEFT JOIN rate r ON r.snapshot_id=rf.snapshot_id AND r.base_plan_id=p.base_plan_id
      WHERE a.state=$1 AND a.plan_year=$2 AND a.import_id=$5 GROUP BY rf.snapshot_id`,
    [entry.state, entry.plan_year, entry.market, entry.issuer_id, entry.snapshot_id]);
    const evidence = rows[0];
    if (!evidence) return result;
    const rule = await ratingRule(db, entry.state, entry.plan_year, entry.market);
    const geo = geography.find(g => g.state === entry.state && g.plan_year === entry.plan_year);
    const hasGeography = geo !== undefined && geo.county_areas + geo.zip3_areas > 0;
    result.premium_status = rule?.method === 'per_member' && evidence.medical_plans > 0
      ? evidence.rate_rows > 0 && hasGeography ? 'available' : 'unknown' : 'unsupported';
    return { ...result, rate_snapshot_id: evidence.snapshot_id, rate_rows: evidence.rate_rows,
      rating_area_geography: geo ? { county_areas: geo.county_areas, zip3_areas: geo.zip3_areas } : null,
      ...(result.premium_status === 'unknown' && !hasGeography ? { premium_reason: 'UNRESOLVED_RATING_AREA' } : {}),
      rating_rule_snapshot_id: rule?.snapshot_id ?? null };
  };
  const entries: Awaited<ReturnType<typeof entryAvailability>>[] = [];
  // Bound work below the five-connection pool limit. A national manifest must not
  // enqueue hundreds of acquisitions against its two-second checkout timeout.
  for (let at = 0; at < manifest.length; at += 4) {
    entries.push(...await Promise.all(manifest.slice(at, at + 4).map(entryAvailability)));
  }
  // Discovery has issuer/year evidence even when catalog data has not been imported.
  const additional = drugs.filter(drug => !manifest.some(e => e.issuer_id === drug.issuer_id
    && e.plan_year === drug.plan_year && e.state === drug.state)).map(drug => ({
      state: drug.state, plan_year: drug.plan_year, market: null, issuer_id: drug.issuer_id,
      catalog_status: 'unknown', premium_status: 'unknown', provider_status: 'unknown',
      formulary_status: drug.status === 'complete' ? 'available' : 'unknown',
      snapshot_id: drug.snapshot_id, drug_coverage: drug, drug_status: drug.status,
    }));
  const combined: Record<string,unknown>[] = [...entries,...additional].map(entry => {
    const provider = providers.find(p => p.issuer_id === entry.issuer_id && p.plan_year === entry.plan_year && p.state === entry.state);
    return provider ? { ...entry,provider_coverage: provider,provider_status: provider.status === 'complete' ? 'available' : 'unknown' } : entry;
  });
  for (const provider of providers) if (!combined.some(e => e.issuer_id === provider.issuer_id
    && e.plan_year === provider.plan_year && e.state === provider.state)) combined.push({
      state: provider.state,plan_year: provider.plan_year,market: null,issuer_id: provider.issuer_id,
      catalog_status: 'unknown',premium_status: 'unknown',provider_status: provider.status === 'complete' ? 'available' : 'unknown',
      formulary_status: 'unknown',snapshot_id: provider.snapshot_id,drug_coverage: { status: 'unknown',reason: 'source_set_not_available' },
      drug_status: 'unknown',provider_coverage: provider,
    });
  const scopes = (await db.query<{ state: string; plan_year: number }>(`SELECT a.state,a.plan_year FROM state_rate_active a
    JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE' ORDER BY a.state,a.plan_year`)).rows;
  for (const scope of scopes) {
    const rows = await stateCatalog(db, scope.plan_year, scope.state);
    for (const issuer of [...new Set(rows.map(r => r.raw_record.issuer))]) {
      const rates = rows.filter(r => r.raw_record.issuer === issuer);
      const supported = rates.every(r => catalogRule(r) !== null);
      const counts = new Map<string, number>();
      for (const r of rates) counts.set(`${r.plan_key}:${r.region}`, (counts.get(`${r.plan_key}:${r.region}`) ?? 0) + 1);
      combined.push({ state: scope.state, plan_year: scope.plan_year, market: 'Individual', issuer_id: issuer,
        catalog_status: 'available', premium_status: supported ? 'available' : 'unsupported',
        premium_scope: 'supported_subscriber_spouse_children_under_26',
        conflicting_plan_area_keys: [...counts.values()].filter(n => n > 1).length,
        provider_status: 'unknown', formulary_status: 'unknown', drug_status: 'unknown',
        snapshot_id: rates[0]!.import_id, rate_rows: rates.length, medical_plans: new Set(rates.map(r => r.plan_key)).size,
        rating_method: 'community_family_tier', quote_method: 'state_filed_tier', bindable_quote: false,
        on_exchange: scope.state === 'NY' ? 'unknown' : true,
        enrollment_eligibility: 'unknown', subsidy_status: 'requires_state_rules',
        rating_area_geography: stateRatingArea(scope.state, scope.plan_year, scope.state === 'NY' ? '36061' : '50007'),
        provenance: { publication_snapshot_ids: [...new Set(rates.map(r => r.publication_snapshot_id))] } });
    }
  }
  return combined;
}
