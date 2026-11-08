import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Database } from '../../../src/db/database.js';
vi.mock('../../../src/ingest/geo/index.js', () => ({ ingestGeo: vi.fn() }));
vi.mock('../../../src/db/migrate.js', () => ({ migrate: vi.fn(), migrationsDirectory: 'synthetic-migrations' }));
import { ingestGeo } from '../../../src/ingest/geo/index.js';
import { migrate } from '../../../src/db/migrate.js';
import { runWorker } from '../../../src/worker/commands.js';

beforeEach(() => vi.resetAllMocks());
describe('worker ingest geo branch', () => {
  it('migrates, dispatches TX, prints counts and closes the DB', async () => {
    const db = { close: vi.fn() } as unknown as Database;
    const counts = { state: 'TX', planYear: 2026, zctaCountyRows: 2, zctaCentroidRows: 1, ratingAreaRows: 254,
      snapshots: { relationship: 'synthetic', centroids: 'synthetic', ratingAreas: 'synthetic' }, ratingAreaBasis: 'current_cms_table' as const };
    vi.mocked(ingestGeo).mockResolvedValue(counts);
    const output = { out: vi.fn(), error: vi.fn() };
    expect(await runWorker(['ingest', 'geo', '--state', 'TX'], () => db, output)).toBe(0);
    expect(migrate).toHaveBeenCalledWith(db, 'synthetic-migrations');
    expect(ingestGeo).toHaveBeenCalledWith(db, { state: 'TX', planYear: 2026 });
    expect(output.out).toHaveBeenCalledWith(JSON.stringify(counts));
    expect(db.close).toHaveBeenCalledOnce(); expect(output.error).not.toHaveBeenCalled();
  });
  it('defaults to TX and hides raw source/driver errors', async () => {
    const db = { close: vi.fn() } as unknown as Database;
    vi.mocked(ingestGeo).mockRejectedValue(new Error('synthetic private driver details'));
    const output = { out: vi.fn(), error: vi.fn() };
    expect(await runWorker(['ingest', 'geo'], () => db, output)).toBe(1);
    expect(ingestGeo).toHaveBeenCalledWith(db, { state: 'TX', planYear: 2026 });
    expect(output.out).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith('Geography TX PY2026 failed; previous import preserved');
    expect(db.close).toHaveBeenCalledOnce();
  });
});

describe('worker GeoNames branch', () => {
  it('rejects state/year flags before opening the national-source database', async () => {
    for (const extra of [['--state','TX'],['--year','2026'],['--all-states']]) {
      const open = vi.fn(), output = {out:vi.fn(),error:vi.fn()};
      expect(await runWorker(['ingest','geo','--source','geonames',...extra],open,output)).toBe(1);
      expect(open).not.toHaveBeenCalled(); expect(output.error).toHaveBeenCalledWith('Usage: worker ingest geo --source geonames');
    }
  });
});
