import { providerRoutes } from './providers.js';
import { drugRoutes } from './drugs.js';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../db/database.js';
import { zipToCounties } from '../ingest/geo/repository.js';
import { countyPlans, countyState, findPlan, planView, resolveLocation, variantExists } from './repository.js';
import { estimatePremium } from './premiums.js';
import { benchmark, householdSubsidy, withSubsidy } from './subsidies.js';
import * as v from './validation.js';

export interface ApiOptions {
  /** Required for personalized requests (spec §14). Never logged. */
  premiumToken?: string;
}
function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(header ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function nativeRoutes(db: SqlSession, options: ApiOptions) {
  const app = new Hono();
  app.onError((error, c) => error instanceof v.InputError
    ? c.json({ error: { code: error.code, field: error.field } }, 400)
    : c.json({ error: { code: 'INTERNAL_ERROR' } }, 500));

  app.route('/', drugRoutes(db));
  app.route('/', providerRoutes(db));

  app.get('/zip-counties', async c => c.json(await zipToCounties(db, v.zip(c.req.query('zip')))));

  app.get('/plans', async c => {
    const year = v.year(c.req.query('year')), market = v.market(c.req.query('market'));
    const csrVariant = v.csrVariant(c.req.query('csr_variant'));
    const metal = v.metal(c.req.query('metal')), page = v.page(c.req.query('page'));
    const location = await resolveLocation(db, v.location(c.req.query()));
    if (location.status !== 'available' || !location.county) {
      return c.json({ status: location.status, year, market: market.toLowerCase(), location, plans: [], page, page_size: 50, total: 0, next_page: null });
    }
    const plans = (await countyPlans(db, location.county, year, location.zip)).filter(p => metal === undefined || p.metal.toLowerCase() === metal);
    const active = await db.query(`SELECT 1 FROM puf_active_catalog WHERE plan_year=$1 AND state=$2
      UNION ALL SELECT 1 FROM state_rate_active a JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE'
      WHERE a.plan_year=$1 AND a.state=$2`, [year, countyState(location.county)]);
    const start = (page - 1) * 50;
    return c.json({ status: active.rows.length ? 'available' : 'unknown', year, market: market.toLowerCase(), location,
      plans: await Promise.all(plans.slice(start, start + 50).map(async plan => ({ ...await planView(db, plan, { csrVariant }),
        availability: { zip_restricted: plan.zip_restricted, zip_codes: plan.zip_codes } }))),
      page, page_size: 50, total: plans.length, next_page: start + 50 < plans.length ? page + 1 : null });
  });

  app.get('/plans/:id', async c => {
    const id = v.planId(c.req.param('id')), year = v.year(c.req.query('year'));
    const plan = await findPlan(db, id.base, year);
    if (!plan || (id.variant !== null && !await variantExists(db, plan, id.full))) return c.json({ error: { code: 'PLAN_NOT_FOUND', plan_id: id.full, year } }, 404);
    const csrVariant = v.csrVariant(c.req.query('csr_variant'));
    v.checkVariant(id.base, csrVariant, id.variant);
    const view = await planView(db, plan, { csrVariant, requestedVariant: id.variant, allBenefits: true });
    return c.json({ ...view, requested_variant_id: id.variant === null ? null : id.full,
      variant_cost_sharing_resolved: view.cost_sharing.status === 'available' && view.cost_sharing.benefits_status === 'available',
      benefits_status: view.cost_sharing.benefits_status, benefits: view.cost_sharing.benefits });
  });

  for (const path of ['/premium-estimates', '/benchmark']) app.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.premiumToken) return c.json({ error: { code: 'AUTH_NOT_CONFIGURED' } }, 503);
    if (!authorized(c.req.header('authorization'), options.premiumToken)) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    await next();
  });
  app.get('/benchmark', async c => {
    const request = v.benchmarkRequest(c.req.query());
    return c.json(await benchmark(db, request, await resolveLocation(db, request.location)));
  });
  app.post('/premium-estimates', bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE', field: 'body' } }, 400) }), async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: 'INVALID_JSON', field: 'body' } }, 400); }
    const request = v.premiumRequest(body), plans = [];
    for (const id of request.ids) {
      const plan = await findPlan(db, id.base, request.year);
      if (!plan || (id.variant !== null && !await variantExists(db, plan, id.full))) return c.json({ error: { code: 'PLAN_NOT_FOUND', plan_id: id.full, year: request.year } }, 404);
      plans.push({ id, plan });
    }
    const location = await resolveLocation(db, request.location);
    const subsidy = await householdSubsidy(db, request, location);
    const estimates = [];
    for (const { id, plan } of plans) estimates.push(withSubsidy(await estimatePremium(db, plan, id.full, request, location), subsidy, plan));
    return c.json({ estimates });
  });

  for (const kind of ['carriers', 'networks'] as const) {
    app.get(`/${kind}`, async c => {
      const state = v.state(c.req.query('state')), year = c.req.query('year') === undefined ? null : v.year(c.req.query('year'));
      const fileKind = kind === 'carriers' ? 'plan-attributes' : 'network';
      const columns = kind === 'carriers' ? 'r.issuer_id,r.marketing_names,r.state,r.plan_year,r.snapshot_id,r.source_row'
        : 'r.network_id,r.issuer_id,r.network_name,r.network_url,r.state,r.plan_year,r.market,r.dental_only,r.snapshot_id,r.source_row';
      const { rows } = await db.query(`SELECT ${columns} FROM puf_active_catalog a
        JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind=$1
        JOIN ${kind === 'carriers' ? 'issuer' : 'network'} r ON r.snapshot_id=f.snapshot_id
        WHERE a.state=$2 AND ($3::integer IS NULL OR a.plan_year=$3) ORDER BY r.plan_year,r.issuer_id,r.source_row`, [fileKind, state, year]);
      return c.json({ status: rows.length ? 'available' : 'unknown', [kind]: rows });
    });
  }
  return app;
}
