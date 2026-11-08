import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coreMigrations, testDatabase } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { defaultRulesFile, ingestRatingRules, ratingRule } from '../../../src/ingest/rating-rules/index.js';
import { runWorker } from '../../../src/worker/commands.js';

const db = testDatabase(new PGlite());
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-rules-'));
  core = await coreMigrations(); await migrate(db, core.directory);
});
afterAll(async () => { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); });

it('loads a cited TX rule as its own immutable source/snapshot, idempotently', async () => {
  const first = await ingestRatingRules(db), second = await ingestRatingRules(db);
  expect(second).toEqual(first);
  expect(await ratingRule(db, 'TX', 2026, 'Individual')).toMatchObject({ method: 'per_member', citation: expect.stringContaining('45 CFR 147.102'), snapshot_id: first.snapshot_id });
  expect(await ratingRule(db, 'NY', 2026, 'individual')).toBeNull();
  expect(await ratingRule(db, 'VT', 2026, 'individual')).toBeNull();
  expect(await ratingRule(db, 'TX', 2027, 'individual')).toBeNull();
  expect(await ratingRule(db, 'TX', 2026, 'SHOP (Small Group)')).toBeNull();
  expect((await db.query('SELECT validation_state,sha256 FROM snapshot')).rows).toEqual([{ validation_state: 'ACTIVE', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect((await db.query('SELECT raw_text FROM rating_rule_document WHERE snapshot_id=$1', [first.snapshot_id])).rows[0]!.raw_text)
    .toBe(await readFile(defaultRulesFile, 'utf8'));
});

it('negative control: removing TX publishes an empty set and revokes prior TX support', async () => {
  const document = JSON.parse(await readFile(defaultRulesFile, 'utf8'));
  document.rules = [];
  const path = join(directory, 'synthetic-no-tx.json'); await writeFile(path, JSON.stringify(document));
  await ingestRatingRules(db, path);
  expect(await ratingRule(db, 'TX', 2026, 'individual')).toBeNull();
  expect((await db.query("SELECT count(*)::int AS count FROM state_rating_rule WHERE state='TX'")).rows[0]!.count).toBe(1);
  await ingestRatingRules(db);
});

it('negative controls: rejects NY/VT per-member, uncited, duplicate and incompatible child rules atomically', async () => {
  for (const mutate of [
    (r: Record<string, unknown>) => { r.state = 'NY'; },
    (r: Record<string, unknown>) => { r.state = 'VT'; },
    (r: Record<string, unknown>) => { r.citation = ''; },
    (r: Record<string, unknown>) => { r.child_rule = 'all_children'; },
  ]) {
    const document = JSON.parse(await readFile(defaultRulesFile, 'utf8'));
    mutate(document.rules[0]);
    const path = join(directory, 'synthetic-invalid.json'); await writeFile(path, JSON.stringify(document));
    await expect(ingestRatingRules(db, path)).rejects.toThrow();
  }
  const document = JSON.parse(await readFile(defaultRulesFile, 'utf8'));
  document.rules.push(document.rules[0]);
  const path = join(directory, 'synthetic-duplicate.json'); await writeFile(path, JSON.stringify(document));
  await expect(ingestRatingRules(db, path)).rejects.toThrow('Duplicate');
  expect(await ratingRule(db, 'TX', 2026, 'individual')).toMatchObject({ method: 'per_member' });
});

it('dispatches worker ingest rating-rules and rejects bad flags before connecting', async () => {
  const messages: string[] = [];
  expect(await runWorker(['ingest', 'rating-rules'], () => ({ ...db, close: async () => {} }),
    { out: m => messages.push(m), error: m => messages.push(m) }, core.directory)).toBe(0);
  expect(JSON.parse(messages[0]!)).toMatchObject({ plan_year: 2026, rules: 1, status: 'ACTIVE' });
  const errors: string[] = [];
  expect(await runWorker(['ingest', 'rating-rules', '--year'], () => { throw new Error('must not open'); },
    { out: () => {}, error: m => errors.push(m) })).toBe(1);
  expect(errors).toEqual(['Usage: worker ingest rating-rules [--file path]']);
});
