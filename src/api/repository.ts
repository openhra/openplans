import { attributeCostSharing, selectedVariant } from '../domain/csr/index.js';
import { catalogRule, stateCatalog, stateRatingArea } from '../ingest/state/catalog.js';
import type { StateCatalogRow } from '../ingest/state/catalog.js';
import type { SqlSession } from '../db/database.js';
import { ratingAreaForLocation, zipToCounties } from '../ingest/geo/repository.js';
import { ratingRule } from '../ingest/rating-rules/index.js';
import { dentalRatingRule } from '../domain/rating/index.js';
import { plansForCounty } from '../ingest/puf/import-repository.js';
import type { CountyPlan } from '../ingest/puf/import-repository.js';
import type { LocationInput } from './validation.js';
import { fail } from './validation.js';

// Stable Census identifiers, independent of state rating policy.
const STATE_FIPS = Object.fromEntries('AL:01 AK:02 AZ:04 AR:05 CA:06 CO:08 CT:09 DE:10 DC:11 FL:12 GA:13 HI:15 ID:16 IL:17 IN:18 IA:19 KS:20 KY:21 LA:22 ME:23 MD:24 MA:25 MI:26 MN:27 MS:28 MO:29 MT:30 NE:31 NV:32 NH:33 NJ:34 NM:35 NY:36 NC:37 ND:38 OH:39 OK:40 OR:41 PA:42 RI:44 SC:45 SD:46 TN:47 TX:48 UT:49 VT:50 VA:51 WA:53 WV:54 WI:55 WY:56'.split(' ').map(pair => pair.split(':')));
export const countyState = (county: string): string | null => Object.keys(STATE_FIPS).find(state => STATE_FIPS[state] === county.slice(0, 2)) ?? null;

export interface Plan extends Record<string, unknown> {
  base_plan_id: string; plan_year: number; state: string; issuer_id: string; market: string;
  metal: string; dental_only: boolean; plan_name: string; network_id: string; service_area_id: string;
  on_exchange: boolean; off_exchange: boolean; snapshot_id: string; source_row: number;
  state_catalog?: boolean; plan_key?: string; hios_id?: string | null;
  hios_match?: StateCatalogRow['hios_match']; hios_match_reason?: string;
  hios_candidates?: Record<string, unknown>[]; hios_match_rule?: string | null;
  hios_match_provenance?: Record<string, unknown> | null;
}
export async function resolveLocation(db: SqlSession, input: LocationInput) {
  if (!input.zip) return { status: 'available' as const, ...input, counties: [], county: input.county! };
  const result = await zipToCounties(db, input.zip);
  if (result.status === 'unknown') return { ...input, status: 'unknown' as const, counties: result.counties };
  // A multi-county Vermont ZCTA has the same statewide medical service area.
  if (!input.county && result.counties.length > 1 && result.counties.every(c => c.county_fips.startsWith('50'))) {
    return { ...input, status: 'available' as const, counties: result.counties,
      county: result.counties[0]!.county_fips, location_scope: 'VT_statewide' };
  }
  if (input.county && !result.counties.some(c => c.county_fips === input.county)) fail('county', 'ZIP_COUNTY_MISMATCH');
  if (!input.county && result.counties.length !== 1) return { ...input, status: 'ambiguous' as const, counties: result.counties };
  return { ...input, status: 'available' as const, counties: result.counties, county: input.county ?? result.counties[0]!.county_fips };
}
export function zipEligible(plan: CountyPlan, zip?: string): boolean {
  return !plan.zip_restricted || (zip !== undefined && plan.zip_codes.includes(zip));
}
export async function countyPlans(db: SqlSession, county: string, year: number, zip?: string, coverage: 'medical' | 'dental' = 'medical') {
  const stateScope = countyState(county);
  if (stateScope === 'NY' || stateScope === 'VT') return coverage === 'dental' ? [] : stateCountyPlans(db, stateScope, county, year);
  const plans = (await plansForCounty(db, county, year, 'Individual')).filter(p => p.dental_only === (coverage === 'dental') && zipEligible(p, zip));
  const state = countyState(county);
  if (!state || !plans.length) return plans;
  const [resolution, rule] = await Promise.all([
    ratingAreaForLocation(db, state, year, county, zip), ratingRule(db, state, year, 'Individual'),
  ]);
  const area = resolution.status === 'available' ? resolution.areas[0]! : null;
  const supported = coverage === 'dental' ? dentalRatingRule(state, year, 'Individual') !== null : rule?.method === 'per_member';
  const premiumAvailability = !supported
    ? { status: 'unsupported_rating_method', reason: 'STATE_RATING_METHOD_UNSUPPORTED' }
    : area ? { status: 'available', rating_area_id: area.rating_area_id,
      rating_area_provenance: { snapshot_id: area.snapshot_id, source_row: area.source_row } }
      : { status: resolution.status, reason: 'UNRESOLVED_RATING_AREA' };
  return plans.map(plan => ({ ...plan, premium_availability: premiumAvailability }));
}
function statePlan(rows: StateCatalogRow[]): Plan & CountyPlan {
  const row = rows[0]!, raw = row.raw_record;
  const identityEvidence = Boolean(row.hios_candidates?.length);
  return { base_plan_id: row.plan_key, plan_key: row.plan_key, hios_id: raw.plan_id ?? row.hios_id,
    ...(row.state === 'VT' ? { hios_match: row.hios_match ?? 'none',
      // An unrelated supplemental catalog must not change an absence response.
      // The audit table retains precise no-candidate reasons and both sources.
      hios_match_reason: identityEvidence ? row.hios_match_reason! : 'no_verified_hios_match',
      hios_candidates: row.hios_candidates ?? [], hios_match_rule: identityEvidence ? row.hios_match_rule : null,
      hios_match_provenance: identityEvidence ? row.hios_match_provenance : null } : {}),
    plan_year: row.plan_year, state: row.state, issuer_id: row.hios_id?.slice(0, 5) ?? raw.issuer, market: 'Individual',
    metal: raw.metal ?? 'unknown', dental_only: false, plan_name: raw.plan_name ?? 'unknown',
    network_id: '', service_area_id: '',
    on_exchange: row.sbe_exchange?.on_exchange ?? (row.state === 'VT' && raw.exchange === 'On'),
    off_exchange: row.sbe_exchange?.off_exchange ?? false,
    ...(row.sbe_exchange ? { exchange_provenance: row.sbe_exchange } : {}),
    snapshot_id: row.import_id, source_row: row.record_index + 1, state_catalog: true,
    zip_restricted: false, zip_codes: [], raw_zip_codes: [], rating_method: 'community_family_tier' };
}
async function stateCountyPlans(db: SqlSession, state: 'NY' | 'VT', county: string, year: number) {
  const area = stateRatingArea(state, year, county);
  if (!area) return [];
  const rows = await stateCatalog(db, year, state, undefined, area.rating_area_id);
  const keys = [...new Set(rows.map(r => r.plan_key))];
  return keys.map(key => {
    const matches = rows.filter(r => r.plan_key === key), plan = statePlan(matches);
    const supported = matches.every(row => catalogRule(row) !== null);
    return { ...plan, premium_availability: {
      status: !supported ? 'unsupported_rating_method' : matches.length > 1 ? 'ambiguous' : 'available',
      ...(!supported ? { reason: 'NO_APPLICABLE_COMMUNITY_RULE' } : {}),
      rating_area_id: area.rating_area_id, rating_area_provenance: area,
      quote_method: 'state_filed_tier', bindable_quote: false,
    } };
  });
}
export async function findPlan(db: SqlSession, base: string, year: number): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(`SELECT p.* FROM puf_active_catalog a
    JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id
    WHERE p.base_plan_id=$1 AND a.plan_year=$2 AND p.plan_year=a.plan_year AND p.state=a.state`, [base, year]);
  if (rows[0] && !['NY', 'VT'].includes(rows[0].state)) return rows[0];
  const stateRows = await stateCatalog(db, year, undefined, base);
  return stateRows.length ? statePlan(stateRows) : rows[0] ?? null;
}
export async function snapshots(db: SqlSession, plan: Plan): Promise<Record<string, string>> {
  if (plan.state_catalog) return { 'state-rates': plan.snapshot_id };
  const { rows } = await db.query<{ kind: string; snapshot_id: string }>(`SELECT f.kind,f.snapshot_id
    FROM puf_import_file anchor JOIN puf_import_file f ON f.import_id=anchor.import_id
    WHERE anchor.kind='plan-attributes' AND anchor.snapshot_id=$1`, [plan.snapshot_id]);
  return Object.fromEntries(rows.map(row => [row.kind, row.snapshot_id]));
}
export interface CostSharingOptions { csrVariant?: string; requestedVariant?: string | null; allBenefits?: boolean }
export async function planCostSharing(db: SqlSession, plan: Plan, options: CostSharingOptions = {}) {
  const selected = plan.state_catalog ? null : selectedVariant(plan.base_plan_id, options.csrVariant, options.requestedVariant);
  const files = await snapshots(db, plan);
  const [attributes, benefits] = plan.state_catalog ? [{ rows: [] }, { rows: [] }] : await Promise.all([
    db.query<{ variant_plan_id: string; csr_variation_type: string; variant_name: string; exchange_status: string;
      source_row: number; raw: Record<string, string> }>(`SELECT variant_plan_id,csr_variation_type,variant_name,exchange_status,source_row,raw
      FROM plan_variant WHERE snapshot_id=$1 AND base_plan_id=$2 ORDER BY variant_plan_id`, [plan.snapshot_id, plan.base_plan_id]),
    db.query<{ published_plan_id: string; benefit_name: string; cost_sharing_raw: Record<string, string>;
      cost_sharing_parsed: Record<string, unknown>; raw: Record<string, string>; snapshot_id: string; source_row: number }>(
      `SELECT published_plan_id,benefit_name,cost_sharing_raw,cost_sharing_parsed,raw,snapshot_id,source_row FROM plan_benefit
      WHERE snapshot_id=$1 AND base_plan_id=$2 AND ($3::text IS NULL OR published_plan_id=$3)
      ORDER BY published_plan_id,source_row`, [files['benefits-and-cost-sharing'], plan.base_plan_id, options.allBenefits ? null : selected]),
  ]);
  const variants = attributes.rows.map(({ raw, ...row }) => ({ ...row,
    ...attributeCostSharing(raw), provenance: { snapshot_id: plan.snapshot_id, source_row: row.source_row },
    ...(options.allBenefits ? { benefits_status: benefits.rows.some(b => b.published_plan_id === row.variant_plan_id) ? 'available' : 'unknown',
      benefits: benefits.rows.filter(b => b.published_plan_id === row.variant_plan_id) } : {}),
  }));
  const attribute = variants.find(row => row.variant_plan_id === selected);
  const amounts = attributeCostSharing(attributes.rows.find(row => row.variant_plan_id === selected)?.raw ?? {});
  // Orphan benefit rows never authorize substitution for missing variant attributes.
  const rows = attribute ? benefits.rows.filter(row => row.published_plan_id === selected) : [];
  return {
    // Shared identity metadata accompanies both plan views and premium estimates.
    // The internal key continues to select the unchanged filed tier cells.
    ...(plan.state_catalog && plan.state === 'VT' ? {
      base_plan_id: plan.hios_id ?? null, hios_id: plan.hios_id ?? null, plan_key: plan.plan_key,
      hios_match: plan.hios_match, hios_match_reason: plan.hios_match_reason,
      hios_candidates: plan.hios_candidates, hios_match_rule: plan.hios_match_rule,
      hios_match_provenance: plan.hios_match_provenance,
    } : {}),
    variant_ids: variants.map(row => row.variant_plan_id), variants,
    csr_eligibility_status: 'not_evaluated' as const,
    premium_basis: plan.state_catalog ? 'state_filed_tier' : 'base_plan_rate_puf',
    premium_varies_by_csr: plan.state_catalog ? null : false,
    premium_note: plan.state_catalog ? null : 'Rate PUF premiums are filed at base plan level; CSR selection does not change the gross premium.',
    cost_sharing: { status: attribute ? 'available' as const : 'unknown' as const,
      selected_variant_id: selected, selection: options.csrVariant !== undefined || options.requestedVariant != null ? 'explicit' : 'standard_on_exchange_default',
      ...amounts, ...(attribute ? { provenance: attribute.provenance } : {}),
      benefits_status: rows.length ? 'available' as const : 'unknown' as const, benefits: rows },
  };
}
export async function planView(db: SqlSession, plan: Plan, options: CostSharingOptions = {}) {
  const sharing = await planCostSharing(db, plan, options);
  if (plan.state_catalog) return { base_plan_id: plan.hios_id, hios_id: plan.hios_id, plan_key: plan.plan_key,
    ...sharing, plan_year: plan.plan_year, state: plan.state, market: 'individual',
    plan_name: plan.plan_name, metal: plan.metal, issuer: { issuer_id: plan.issuer_id, marketing_names: [] },
    network: { status: 'unknown', records: [] }, on_exchange: plan.state === 'NY' ? 'unknown' : plan.on_exchange,
    off_exchange: plan.exchange_provenance ? plan.off_exchange : 'unknown', enrollment_eligibility: 'unknown',
    availability_basis: plan.state === 'NY' ? 'filed_rating_area' : 'DVHA_2026_section_2.3_statewide',
    ...(plan.premium_availability ? { premium_availability: plan.premium_availability } : {}),
    provenance: { snapshot_ids: { 'state-rates': plan.snapshot_id },
      ...(plan.exchange_provenance ? { exchange: plan.exchange_provenance } : {}) } };

  const files = await snapshots(db, plan);
  const [issuer, networks] = await Promise.all([
    db.query(`SELECT issuer_id,marketing_names,snapshot_id,source_row FROM issuer WHERE snapshot_id=$1 AND issuer_id=$2`, [plan.snapshot_id, plan.issuer_id]),
    db.query(`SELECT network_id,network_name,network_url,snapshot_id,source_row FROM network
      WHERE snapshot_id=$1 AND issuer_id=$2 AND network_id=$3 AND market=$4 AND dental_only=$5 ORDER BY source_row`,
    [files.network, plan.issuer_id, plan.network_id, plan.market, plan.dental_only]),
  ]);
  return { base_plan_id: plan.base_plan_id, ...sharing,
    plan_year: plan.plan_year, state: plan.state, market: plan.market.toLowerCase(), plan_name: plan.plan_name,
    metal: plan.metal, issuer: issuer.rows[0] ?? { issuer_id: plan.issuer_id, status: 'unknown' },
    network: { network_id: plan.network_id, status: networks.rows.length ? 'available' : 'unknown', records: networks.rows },
    on_exchange: plan.on_exchange, off_exchange: plan.off_exchange,
    ...(plan.premium_availability ? { premium_availability: plan.premium_availability } : {}),
    provenance: { snapshot_ids: files, plan_source_row: plan.source_row } };
}
export async function variantExists(db: SqlSession, plan: Plan, full: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2', [plan.snapshot_id, full])).rows.length === 1;
}
