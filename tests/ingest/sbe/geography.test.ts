import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabase, coreMigrations } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { ingestSbeGeography } from '../../../src/ingest/sbe/geography.js';
import { activateSbeRules } from '../../../src/ingest/sbe/rules.js';
import { ratingRule } from '../../../src/ingest/rating-rules/index.js';
import { ratingAreaForLocation, zipToCounties } from '../../../src/ingest/geo/repository.js';
import type { GeoFiles } from '../../../src/ingest/geo/sources.js';

const root = fileURLToPath(new URL('../../fixtures/sbe/geography/', import.meta.url));
const db = testDatabase(new PGlite());
let directory: string, migrations: Awaited<ReturnType<typeof coreMigrations>>, california: GeoFiles;
async function files(state: string): Promise<GeoFiles> {
  const meta = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8')).states[state];
  return Object.fromEntries(Object.entries(meta).map(([kind, value]) => {
    const f = value as { file: string; original: GeoFiles['relationship']['metadata']; sha256: string; bytes: number };
    // Synthetic acquisition wrapper for an unmodified factual cut, not publisher download metadata.
    return [kind, { path: join(root, f.file), zipped: false, metadata: { ...f.original, sha256: f.sha256, bytes: f.bytes } }];
  })) as GeoFiles;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-sbe-geography-')); migrations = await coreMigrations(); await migrate(db, migrations.directory);
  california = await files('CA');
  await ingestSbeGeography(db, { state: 'CA', planYear: 2026, files: california });
});
afterAll(async () => { await db.close(); await migrations.cleanup(); await rm(directory, { recursive: true, force: true }); });
it('resolves whole counties and both published LA ZIP3 areas without assigning one LA county-wide price', async () => {
  expect(await ratingAreaForLocation(db, 'CA', 2026, '06037')).toMatchObject({ status: 'unknown' });
  expect(await ratingAreaForLocation(db, 'CA', 2026, '06037', '90001')).toMatchObject({ status: 'available', areas: [{ rating_area_id: 'Rating Area 16' }] });
  expect(await ratingAreaForLocation(db, 'CA', 2026, '06037', '90601')).toMatchObject({ status: 'available', areas: [{ rating_area_id: 'Rating Area 15' }] });
  expect(await ratingAreaForLocation(db, 'CA', 2026, '06059')).toMatchObject({ status: 'available', areas: [{ rating_area_id: 'Rating Area 18' }] });
});
it('negative: a shared LA/Orange ZIP3 never supplies a wrong unambiguous premium', async () => {
  expect(await ratingAreaForLocation(db, 'CA', 2026, '06059', '90620')).toMatchObject({ status: 'ambiguous' });
  expect((await zipToCounties(db, '90620')).counties.some(c => c.county_fips === '06059')).toBe(true);
});
it('negative: a mutated county restriction rolls back the replacement and preserves active geography', async () => {
  const before = JSON.stringify((await db.query("SELECT * FROM geo_import WHERE state='CA'")).rows);
  const text = (await readFile(california.ratingAreas.path, 'utf8')).replace('only within LA County', 'only within Orange County');
  const path = join(directory, 'synthetic-mutant-ca-gra.html'); await writeFile(path, text);
  const broken = { ...california, ratingAreas: { ...california.ratingAreas, path, metadata: { ...california.ratingAreas.metadata,
    sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) } } };
  await expect(ingestSbeGeography(db, { state: 'CA', planYear: 2026, files: broken })).rejects.toThrow();
  expect(JSON.stringify((await db.query("SELECT * FROM geo_import WHERE state='CA'")).rows)).toBe(before);
});
it('MA preserves Census border ZIPs but leaves unpublished rating prefixes unknown; filed rows are authorized', async () => {
  const report = await ingestSbeGeography(db, { state: 'MA', planYear: 2026, files: await files('MA') });
  expect('constraints' in report && report.constraints).toMatchObject({ unlisted_rating_area: 'unknown' });
  await activateSbeRules(db, directory, 2026);
  expect(await ratingRule(db, 'MA', 2026, 'Individual')).toMatchObject({ method: 'per_member', citation: expect.stringContaining('MA: CMS') });
  expect(await ratingRule(db, 'NY', 2026, 'Individual')).toMatchObject({ method: 'unsupported' });
});
