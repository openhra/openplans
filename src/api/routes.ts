import { lookupZip, searchPlans, getPlan, benchmarkSilver, estimatePremiums, listCarriersNetworks } from '../services/catalog.js';
import { ReadError } from '../services/errors.js';
import { providerRoutes } from './providers.js';
import { drugRoutes } from './drugs.js';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../db/database.js';
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
    : error instanceof ReadError ? c.json({ error: error.error }, error.error.code === 'unsupported_without_taxonomy' ? 422 : 404)
    : c.json({ error: { code: 'INTERNAL_ERROR' } }, 500));

  app.route('/', drugRoutes(db));
  app.route('/', providerRoutes(db));

  app.get('/zip-counties', async c => c.json(await lookupZip(db, c.req.query('zip'))));

  app.get('/plans', async c => c.json(await searchPlans(db, c.req.query())));

  app.get('/plans/:id', async c => c.json(await getPlan(db, v.planId(c.req.param('id')).full, c.req.query())));

  for (const path of ['/premium-estimates', '/benchmark']) app.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.premiumToken) return c.json({ error: { code: 'AUTH_NOT_CONFIGURED' } }, 503);
    if (!authorized(c.req.header('authorization'), options.premiumToken)) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    await next();
  });
  app.get('/benchmark', async c => c.json(await benchmarkSilver(db, c.req.query())));
  app.post('/premium-estimates', bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE', field: 'body' } }, 400) }), async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: { code: 'INVALID_JSON', field: 'body' } }, 400); }
    return c.json(await estimatePremiums(db, body));
  });

  for (const kind of ['carriers', 'networks'] as const) {
    app.get(`/${kind}`, async c => {
      return c.json(await listCarriersNetworks(db, kind, c.req.query()));
    });
  }
  return app;
}
