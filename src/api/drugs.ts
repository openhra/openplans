import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../db/database.js';
import { createRxnormRepository } from '../ingest/rxnorm/repository.js';
import { drugCoverage } from '../domain/drugs/repository.js';
import { drugConcept, normalizeNdc } from '../domain/drugs/concepts.js';
import * as v from './validation.js';

function rxcui(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return v.fail('rxcui');
  return value;
}
function drugYear(value: unknown): number {
  const parsed = v.year(value);
  if (parsed > 2100) return v.fail('year');
  return parsed;
}
function coverageRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return v.fail('body');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.plan_ids) || body.plan_ids.length < 1 || body.plan_ids.length > 50) return v.fail('plan_ids');
  if (!Array.isArray(body.rxcuis) || body.rxcuis.length < 1 || body.rxcuis.length > 100) return v.fail('rxcuis');
  if (body.plan_ids.length * body.rxcuis.length > 1000) return v.fail('body', 'TOO_MANY_PAIRS');
  const plans = body.plan_ids.map(id => v.planId(id).full), codes = body.rxcuis.map(rxcui);
  if (new Set(plans).size !== plans.length) return v.fail('plan_ids', 'DUPLICATE_PLAN_ID');
  if (new Set(codes).size !== codes.length) return v.fail('rxcuis', 'DUPLICATE_RXCUI');
  if (typeof body.year !== 'number' || !Number.isInteger(body.year)) return v.fail('year');
  return { plans, codes, year: drugYear(String(body.year)) };
}

export function drugRoutes(db: SqlSession) {
  const app = new Hono(), rx = createRxnormRepository(db);
  app.get('/drugs', async c => {
    const q = c.req.query('q'), ndc = c.req.query('ndc');
    if ((q === undefined) === (ndc === undefined)) return v.fail('q', 'QUERY_OR_NDC_REQUIRED');
    if (ndc !== undefined) {
      const normalized = normalizeNdc(ndc);
      if (!normalized) return v.fail('ndc', 'INVALID_NDC');
      return c.json({ ndc: normalized, rxcuis: await rx.rxcuisForNdc(normalized), exact_concept_required: true });
    }
    if (!q?.trim() || q.length > 200) return v.fail('q');
    const limit = c.req.query('limit') ?? '50';
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) return v.fail('limit');
    return c.json({ candidates: await rx.searchDrugs(q, { limit: Number(limit) }), exact_concept_required: true });
  });
  app.get('/drugs/:rxcui', async c => {
    const concept = await drugConcept(db, rxcui(c.req.param('rxcui')));
    return concept ? c.json(concept) : c.json({ error: { code: 'DRUG_NOT_FOUND' } }, 404);
  });
  app.get('/plans/:id/drugs/:rxcui', async c => c.json(await drugCoverage(db,
    v.planId(c.req.param('id')).full, rxcui(c.req.param('rxcui')), drugYear(c.req.query('year')))));
  app.post('/drug-coverage', bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE', field: 'body' } }, 400) }), async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return v.fail('body', 'INVALID_JSON'); }
    const request = coverageRequest(body), results = [];
    for (const plan of request.plans) for (const code of request.codes) results.push(await drugCoverage(db, plan, code, request.year));
    return c.json({ results });
  });
  return app;
}
