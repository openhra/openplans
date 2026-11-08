import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlSession } from '../db/database.js';
import { searchDrugs, getDrug, checkDrugCoverage, checkDrugCoverages } from '../services/drugs.js';
import * as v from './validation.js';

export function drugRoutes(db: SqlSession) {
  const app = new Hono();
  app.get('/drugs', async c => c.json(await searchDrugs(db, c.req.query())));
  app.get('/drugs/:rxcui', async c => c.json(await getDrug(db, c.req.param('rxcui'))));
  app.get('/plans/:id/drugs/:rxcui', async c => c.json(await checkDrugCoverage(db,
    c.req.param('id'), c.req.param('rxcui'), c.req.query('year'))));
  app.post('/drug-coverage', bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE', field: 'body' } }, 400) }), async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return v.fail('body', 'INVALID_JSON'); }
    return c.json(await checkDrugCoverages(db, body));
  });
  return app;
}
