import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GEO_SOURCES } from '../../../src/ingest/geo/sources.js';
import type { GeoFiles, GeoKind } from '../../../src/ingest/geo/sources.js';

export const fixtureDirectory = fileURLToPath(new URL('../../fixtures/geo/', import.meta.url));
export async function fixtureFiles(overrides: Partial<Record<GeoKind, string>> = {}): Promise<GeoFiles> {
  const manifest = JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8'));
  const files = {} as GeoFiles;
  for (const kind of Object.keys(GEO_SOURCES) as GeoKind[]) {
    const original = manifest.sources[kind];
    const path = overrides[kind] ?? join(fixtureDirectory, original.filename);
    const body = await readFile(path);
    const hash = createHash('sha256').update(body).digest('hex');
    if (!overrides[kind] && hash !== original.fixture_sha256) throw new Error('Fixture differs from regenerable source cut');
    files[kind] = { path, metadata: { ...original.original_snapshot,
      snapshot_id: hash, sha256: hash, bytes: body.length,
    } };
  }
  return files;
}
