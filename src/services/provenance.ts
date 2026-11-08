import type { SqlSession } from '../db/database.js';
import { snapshotMetadata } from '../api/repository.js';
import { dataGeneration } from '../api/cache/generation.js';
import { dataAvailability } from './availability.js';
import * as v from '../api/validation.js';

export async function getSnapshot(db: SqlSession, id: unknown) {
  if (typeof id !== 'string' || !id.length || id.length > 1024 || /[\u0000-\u001f]/.test(id)) return v.fail('snapshot_id');
  return snapshotMetadata(db, id);
}
/** Generation lookup failures propagate; callers must bypass caching rather than invent a generation. */
export async function getDataStatus(db: SqlSession, params: { state?: string; year?: string; issuer_id?: string } = {}) {
  const state = params.state === undefined ? undefined : v.state(params.state);
  const year = params.year === undefined ? undefined : v.year(params.year);
  const generation = await dataGeneration(db);
  const entries = (await dataAvailability(db)).filter(row => (state === undefined || row.state === state)
    && (year === undefined || row.plan_year === year) && (params.issuer_id === undefined || row.issuer_id === params.issuer_id));
  return { data_generation: generation, entries };
}
