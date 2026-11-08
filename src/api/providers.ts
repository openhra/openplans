import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../db/database.js';
import { providerParticipation } from '../domain/providers/repository.js';
import { providerAvailability } from '../domain/providers/availability.js';
import { zipCentroid } from '../domain/geo/index.js';
import { searchProviders,providerDetail,taxonomyLoaded } from './provider-repository.js';
import type { ProviderSearch } from './provider-repository.js';
import { findPlan,variantExists } from './repository.js';
import * as v from './validation.js';

function npi(value: unknown): string {
  if (typeof value !== 'string' || !/^[12][0-9]{9}$/.test(value)) return v.fail('npi');
  return value;
}
function providerYear(value: unknown): number {
  const result = v.year(value);
  return result <= 2100 ? result : v.fail('year');
}
function number(value: string | undefined, field: string, min: number, max: number) {
  if (value === undefined || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return v.fail(field);
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max ? result : v.fail(field);
}
export function providerRoutes(db: SqlSession) {
  const app = new Hono();
  app.get('/providers',async c => {
    const params = c.req.query(), q: ProviderSearch = { page: v.page(params.page) };
    if (q.page > Math.floor(Number.MAX_SAFE_INTEGER/50)) return v.fail('page');
    if (params.plan_id !== undefined) {
      const id = v.planId(params.plan_id); q.plan = id.base; q.year = providerYear(params.year);
      const plan = await findPlan(db,id.base,q.year);
      if (!plan || (id.variant && !await variantExists(db,plan,id.full))) return c.json({ error: { code: 'PLAN_NOT_FOUND' } },404);
    } else if (params.year !== undefined) providerYear(params.year);
    if (params.taxonomy !== undefined && params.specialty !== undefined) return v.fail('taxonomy','TAXONOMY_OR_SPECIALTY_REQUIRED');
    for (const field of ['taxonomy','specialty','name'] as const) {
      if (params[field] !== undefined) {
        if (!params[field]!.trim() || params[field]!.length > 200) return v.fail(field);
        q[field] = params[field]!.trim();
      }
    }
    if (q.taxonomy && !/^[A-Z0-9]{10}$/.test(q.taxonomy)) return v.fail('taxonomy');
    if (q.specialty && /^[A-Z0-9]{10}$/.test(q.specialty)) { q.taxonomy = q.specialty; delete q.specialty; }
    if (q.specialty && !await taxonomyLoaded(db)) return c.json({ error: {
      code: 'unsupported_without_taxonomy', field: 'specialty',
      message: 'Specialty name search requires the optional NUCC taxonomy import; search by taxonomy code instead.',
    } },422);
    if (params.type !== undefined) {
      const type = params.type.toUpperCase();
      if (!['INDIVIDUAL','FACILITY','GROUP'].includes(type)) return v.fail('type');
      q.type = type as ProviderSearch['type'];
    }
    if (params.zip !== undefined && (params.lat !== undefined || params.lon !== undefined)) return v.fail('location');
    if (params.zip !== undefined) {
      const zip = v.zip(params.zip), centroid = await zipCentroid(db,zip);
      if (!centroid) return c.json({ status: 'unknown',reason: 'zip_centroid_unavailable',providers: [],total: 0,
        page: q.page,page_size: 50,next_page: null,meta: { unlocated: null,origin: null } });
      q.origin = { latitude: centroid.latitude,longitude: centroid.longitude,method: centroid.method,snapshot_id: centroid.snapshot_id };
    } else if (params.lat !== undefined || params.lon !== undefined) {
      q.origin = { latitude: number(params.lat,'lat',-90,90),longitude: number(params.lon,'lon',-180,180),method: 'supplied_coordinates' };
    }
    if (params.radius_miles !== undefined) {
      q.radius = number(params.radius_miles,'radius_miles',0,500);
      if (!q.origin) return v.fail('location','LOCATION_REQUIRED');
    }
    const coverage = q.plan ? (await providerAvailability(db,{ issuer: q.plan.slice(0,5),state: q.plan.slice(5,7),year: q.year! }))[0] ?? null : null;
    if (coverage?.status === 'access_denied') return c.json({ status: 'unknown',reason: 'source_access_denied',
      provider_coverage: coverage,providers: [],total: 0,page: q.page,page_size: 50,next_page: null,
      meta: { unlocated: null,origin: q.origin ?? null } });
    return c.json({ warnings: q.plan && coverage?.status !== 'complete' ? ['SOURCE_INCOMPLETE'] : [],status: q.plan ? coverage?.status === 'complete' ? 'available' : 'unknown' : 'available',
      requested_plan_id: params.plan_id ?? null,base_hios_id: q.plan ?? null,plan_year: q.year ?? null,
      participation: q.plan ? undefined : 'not_evaluated',provider_coverage: coverage,...await searchProviders(db,q) });
  });
  app.get('/providers/:npi',async c => {
    const result = await providerDetail(db,npi(c.req.param('npi')),c.req.query('year') === undefined ? undefined : providerYear(c.req.query('year')));
    return result ? c.json(result) : c.json({ error: { code: 'PROVIDER_NOT_FOUND' } },404);
  });
  app.get('/plans/:id/providers/:npi',async c => c.json(await providerParticipation(db,
    v.planId(c.req.param('id')).full,npi(c.req.param('npi')),providerYear(c.req.query('year')))));
  app.post('/provider-participation',bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE',field: 'body' } },400) }),async c => {
    let value: unknown;
    try { value = await c.req.json(); } catch { return v.fail('body','INVALID_JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return v.fail('body');
    const body = value as Record<string,unknown>;
    if (!Array.isArray(body.plan_ids) || body.plan_ids.length < 1 || body.plan_ids.length > 50) return v.fail('plan_ids');
    if (!Array.isArray(body.npis) || body.npis.length < 1 || body.npis.length > 100) return v.fail('npis');
    if (body.plan_ids.length*body.npis.length > 1000) return v.fail('body','TOO_MANY_PAIRS');
    const plans = body.plan_ids.map(id => v.planId(id).full), npis = body.npis.map(npi);
    if (new Set(plans).size !== plans.length) return v.fail('plan_ids','DUPLICATE_PLAN_ID');
    if (new Set(npis).size !== npis.length) return v.fail('npis','DUPLICATE_NPI');
    if (typeof body.year !== 'number' || !Number.isInteger(body.year)) return v.fail('year');
    const year = providerYear(String(body.year)), results = [];
    for (const plan of plans) for (const code of npis) results.push(await providerParticipation(db,plan,code,year));
    return c.json({ results });
  });
  return app;
}
