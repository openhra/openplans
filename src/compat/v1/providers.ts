import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../../db/database.js';
import { taxonomyRelation } from '../../api/provider-repository.js';
import * as v from '../../api/validation.js';

type Row = Record<string, any>;
const PROVIDER_GAPS = ['vendor_provider_and_specialty_ids_unavailable', 'provider_metadata_limited_to_native_evidence',
  'vendor_state_ids_unavailable', 'provider_address_membership_not_evaluated'];
const header = (c: { header(name: string, value: string): void }, reasons: Iterable<string>) =>
  c.header('x-openplans-gaps', [...new Set(reasons)].join(', '));
function paging(body: Row, fallback = 10) {
  const page = body.page ?? 1, size = body.per_page ?? fallback;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 1000
    || !Number.isSafeInteger(page * size)) return v.fail('page');
  return { start: (page - 1) * size, size };
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return v.fail(field);
  return value.trim();
}
const addressKey = (a: Row) => JSON.stringify([a.line_1 ?? a.address, a.line_2 ?? a.address_2, a.city, a.state, a.zip ?? a.zip5]
  .map(value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()));

function primaryTaxonomy(row: Row): Row | undefined {
  return row.taxonomy?.find((t: Row) => t.is_primary) ?? row.taxonomy?.[0];
}
function taxonomyName(t: Row | undefined) {
  return t?.taxonomy_status === 'known' ? t.taxonomy_display_name ?? null : null;
}
function taxonomyGaps(rows: Row[]) {
  return rows.some(row => !taxonomyName(primaryTaxonomy(row))) ? ['specialty_descriptions_unavailable'] : [];
}

/** Dedupe the wire location, retaining every contributing record and edge separately. */
export function mapProviders(records: Row[]) {
  const merged = new Map<string, Row>();
  for (const row of records) for (const a of row.addresses.length ? row.addresses : [{}]) {
    const key = `${row.npi ?? `${row.snapshot_id}:${row.record_id}`}|${addressKey(a)}`;
    const existing = merged.get(key);
    const trace = { record_id: row.record_id, snapshot_id: row.snapshot_id, source_record: row.source_record ?? null,
      source_set_id: row.source_set_id ?? null, raw_snapshot_id: row.raw_snapshot_id ?? null,
      source_url: row.source_url ?? null, nppes_snapshot_id: row.nppes_snapshot_id ?? null,
      source_updated_at: row.source_updated_at ?? null, retrieved_at: row.retrieved_at ?? null,
      publisher_updated_at: row.publisher_updated_at ?? null, address: a,
      participation: row.participation ?? 'not_evaluated', participation_scope: row.participation_scope ?? null,
      evidence: row.evidence ?? row.plan_participations ?? [] };
    if (existing) { existing.provenance.push(trace); continue; }
    const name = row.name && typeof row.name === 'object' ? row.name : {};
    const taxonomy = primaryTaxonomy(row), known = taxonomy?.taxonomy_status === 'known';
    const individual = row.type ? row.type === 'INDIVIDUAL' : row.entity_type === '1';
    const first = row.first_name ?? name.first ?? null, last = row.last_name ?? name.last ?? null;
    const organization = row.organization_name ?? row.facility_name ?? row.group_name ?? null;
    merged.set(key, { id: row.npi ? Number(row.npi) : null, npis: row.npi ? [Number(row.npi)] : [],
      type: individual ? 'individual' : 'organization', first_name: first, last_name: last,
      middle_name: row.middle_name ?? name.middle ?? null, organization_name: organization,
      presentation_name: individual ? [first, last].filter(Boolean).join(' ') || null : organization,
      doing_business_as_name: null, gender: null, suffix: row.name_suffix ?? null, title: row.name_prefix ?? null,
      credentials: row.credential ? [row.credential] : [],
      specialty: row.specialties?.join(', ') || taxonomyName(taxonomy) || taxonomy?.code || null,
      npi_specialty: { id: taxonomy?.code ?? null, taxonomy_code: taxonomy?.code ?? null,
        name: taxonomyName(taxonomy), display_name: taxonomyName(taxonomy),
        taxonomy_source: known ? 'nucc' : 'nppes_code_only', sub_specialty: known ? taxonomy.specialization ?? null : null },
      city: a.city ?? null, state: a.state ?? null, state_id: null,
      street_line_1: a.line_1 ?? a.address ?? null, street_line_2: a.line_2 ?? a.address_2 ?? null,
      zip_code: a.zip ?? a.zip5 ?? null, phone: a.phone ?? null,
      latitude: a.latitude ?? null, longitude: a.longitude ?? null,
      distance_miles: a.distance_miles ?? row.distance_miles ?? null,
      provenance: [trace] });
  }
  return [...merged.values()];
}

export function providerCompatRoutes(db: SqlSession, native: Hono) {
  const app = new Hono();
  app.post('/providers/search', bodyLimit({ maxSize: 65_536, onError: c => c.json({ error: 'Request too large' }, 400) }), async c => {
    let body: Row;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return v.fail('body');
    if (!body.zip_code) return c.json({ error: 'zip_code required' }, 400);
    const zip = v.zip(body.zip_code), { start, size } = paging(body);
    const params = new URLSearchParams({ zip });
    const reasons = new Set(PROVIDER_GAPS);
    // ZIP-only searches must remain local, even when no explicit radius is sent.
    const radius = body.radius ?? 25;
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > 500) return v.fail('radius');
    params.set('radius_miles', String(radius));
    if (body.radius === undefined) reasons.add('provider_radius_defaulted_to_25_miles');
    if (body.search_term !== undefined) params.set('name', text(body.search_term, 'search_term'));
    if (body.plan_id !== undefined) {
      params.set('plan_id', v.planId(body.plan_id).full); params.set('year', String(v.year(String(body.year ?? 2026))));
      if (body.year === undefined) reasons.add('plan_year_defaulted_to_2026');
    } else if (body.year !== undefined) v.year(String(body.year));
    if (body.specialty !== undefined && body.taxonomy !== undefined) return v.fail('specialty');
    if (body.taxonomy !== undefined || body.specialty !== undefined) {
      const value = text(body.taxonomy ?? body.specialty, 'specialty');
      params.set(body.taxonomy !== undefined || /^[A-Z0-9]{10}$/.test(value) ? 'taxonomy' : 'specialty', value);
    }
    if (body.type !== undefined && !['individual', 'organization'].includes(body.type)) return v.fail('type');
    if (body.type === 'individual') params.set('type', 'individual');
    if (body.sort !== undefined && !['distance', 'name', '-distance', '-name'].includes(body.sort)) return v.fail('sort');
    if (body.network_ids !== undefined && (!Array.isArray(body.network_ids) || body.network_ids.some((id: unknown) => !Number.isSafeInteger(id)))) return v.fail('network_ids');
    const rows: Row[] = [];
    let origin: Row | null = null;
    for (let page = 1; ; page++) {
      params.set('page', String(page));
      const response = await native.request(`/providers?${params}`);
      if (!response.ok) return response;
      const result = await response.json() as Row;
      origin = result.meta?.origin ?? null;
      if (origin?.method === 'zcta_centroid') reasons.add('provider_origin_zip_centroid_approximate');
      if (result.status === 'unknown') reasons.add(result.reason ?? 'provider_source_incomplete');
      if (result.warnings?.length) reasons.add('provider_source_incomplete');
      if (result.meta?.unlocated) reasons.add('provider_unlocated_addresses_excluded');
      if (result.providers.some((r: Row) => r.warnings?.includes('UNRESOLVED_NETWORK_TIER'))) reasons.add('provider_unresolved_network_tier');
      rows.push(...result.providers);
      if (!result.next_page) break;
    }
    if (rows.some(r => r.addresses.some((a: Row) => a.method === 'zcta_centroid' || a.precision === 'approximate'))) reasons.add('provider_location_zip_centroid_approximate');
    let providers = mapProviders(rows).filter(p => !body.type || p.type === body.type);
    for (const reason of taxonomyGaps(rows)) reasons.add(reason);
    if (body.carrier_id !== undefined || body.network_ids?.length) {
      // No vendor ID crosswalk exists. Do not silently ignore a coverage filter.
      reasons.add('vendor_carrier_or_network_filter_unsupported'); providers = [];
    }
    if (body.sort?.endsWith('name')) providers.sort((a, b) => String(a.presentation_name ?? '').localeCompare(String(b.presentation_name ?? '')));
    else providers.sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
    if (body.sort?.startsWith('-')) providers.reverse();
    header(c, reasons);
    return c.json({ meta: { total: providers.length }, providers: providers.slice(start, start + size), states: [] });
  });
  app.get('/providers/:npi', async c => {
    const params = new URLSearchParams();
    if (c.req.query('year')) params.set('year', c.req.query('year')!);
    const response = await native.request(`/providers/${encodeURIComponent(c.req.param('npi'))}?${params}`);
    if (!response.ok) return response;
    const result = await response.json() as Row, identity = result.identity ?? {};
    const rows = result.issuer_records.map((r: Row) => ({ ...identity, ...r, nppes_snapshot_id: identity.snapshot_id ?? null, taxonomy: identity.taxonomy,
      specialties: [r.speciality ?? r.specialty].flat().filter((s: unknown) => typeof s === 'string') }));
    if (identity.npi) rows.push({ ...identity, record_id: identity.npi, type: identity.entity_type === '1' ? 'INDIVIDUAL' : 'GROUP' });
    const locations = mapProviders(rows);
    header(c, [...PROVIDER_GAPS, ...taxonomyGaps(rows), 'provider_detail_coordinates_unavailable']);
    return c.json({ provider: { ...locations[0], locations, plan_participations: result.plan_participations,
      provider_coverage: result.provider_coverage } });
  });
  app.get('/specialties', async c => {
    const taxonomy = await taxonomyRelation(db);
    // Mirror native taxonomy enrichment, including its explicit unknown-code status.
    const { rows } = await db.query<Row>(`SELECT DISTINCT t.code,nt.display_name AS taxonomy_display_name,
      nt.classification,nt.specialization,CASE WHEN nt.code IS NULL THEN 'unknown_code' ELSE 'known' END AS taxonomy_status
      FROM npi_taxonomy t JOIN npi_provider n ON n.npi=t.npi
      LEFT JOIN ${taxonomy} nt ON nt.code=t.code WHERE n.in_scope ORDER BY t.code`);
    header(c, [...(rows.some(r => !taxonomyName(r)) ? ['specialty_descriptions_unavailable'] : []),
      'specialty_ids_are_taxonomy_codes', 'specialties_limited_to_loaded_nppes']);
    return c.json({ meta: { total: rows.length }, specialties: rows.map(r => ({ id: r.code, code: r.code,
      category: r.taxonomy_status === 'known' ? r.classification : null,
      name: taxonomyName(r), display_name: taxonomyName(r),
      taxonomy_source: r.taxonomy_status === 'known' ? 'nucc' : 'nppes_code_only', sub_specialty: r.taxonomy_status === 'known' ? r.specialization : null })) });
  });
  return app;
}
