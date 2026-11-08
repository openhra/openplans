import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/api/app.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { coreMigrations, testDatabase } from './pglite.js';

describe('API', () => {
  const pg = new PGlite();
  const db = testDatabase(pg);
  const app = createApp(db);
  beforeAll(async () => {
    const core = await coreMigrations();
    try { await migrate(db, core.directory); } finally { await core.cleanup(); }
  });
  afterAll(() => db.close());

  it('checks the database and returns an empty manifest before ingestion', async () => {
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', db: 'ok' });
    const availability = await app.request('/v1/data-availability');
    expect(availability.status).toBe(200);
    expect(await availability.json()).toEqual([]);
  });

  it('returns imported manifest values without turning missing evidence into coverage', async () => {
    // Synthetic manifest fixture; these rows do not represent an actual plan or issuer.
    await pg.exec(`
      INSERT INTO source (source_id, publisher, source_kind) VALUES ('synthetic', 'Synthetic publisher', 'synthetic');
      INSERT INTO snapshot (snapshot_id, source_id, validation_state) VALUES ('synthetic-partial', 'synthetic', 'QUARANTINED');
      INSERT INTO data_availability (state, plan_year, market, snapshot_id, catalog_status, provider_status)
      VALUES ('TX', 2026, 'individual_medical', 'synthetic-partial', 'partial', 'unknown');
    `);
    const response = await app.request('/v1/data-availability');
    expect(await response.json()).toEqual([{
      state: 'TX', plan_year: 2026, market: 'individual_medical', issuer_id: null,
      catalog_status: 'partial', premium_status: 'unknown',
      provider_status: 'unknown', formulary_status: 'unknown', snapshot_id: 'synthetic-partial',
      drug_status: 'unknown', drug_coverage: { status: 'unknown', reason: 'source_set_not_available' },
    }]);
  });

  it('reports db down for an unreachable DATABASE_URL without network access or a crash', async () => {
    // A nonexistent Unix socket exercises pg connection failure without any TCP traffic.
    const socket = join(tmpdir(), `openplans-missing-socket-${process.pid}`);
    const url = `postgresql://localhost/synthetic?host=${encodeURIComponent(socket)}`;
    const unreachable = createDatabase(url);
    try {
      const unavailableApp = createApp(unreachable);
      const response = await unavailableApp.request('/healthz');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'ok', db: 'down' });
      const availability = await unavailableApp.request('/v1/data-availability');
      expect(availability.status).toBe(503);
      const body = await availability.text();
      expect(JSON.parse(body)).toEqual({ error: 'data_availability_unavailable' });
      expect(body).not.toContain(socket);
    } finally { await unreachable.close(); }
  });
});
