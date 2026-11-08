import { afterAll, beforeAll, expect, it } from 'vitest';
import { drugAvailability } from '../../../src/domain/drugs/availability.js';
import { normalizeNdc } from '../../../src/domain/drugs/concepts.js';
import { drugCoverage } from '../../../src/domain/drugs/repository.js';
import { importFormulary } from '../../../src/ingest/qhp/formulary.js';
import { fixture, scope, setup } from '../../ingest/qhp/formulary-helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h?.close(); });
it('normalizes only disambiguated NDC layouts, retaining every leading zero', () => {
  for (const value of ['00071-0155-23', '0071-0155-23', '00071015523']) expect(normalizeNdc(value)).toBe('00071015523');
  expect(normalizeNdc('00071-155-23')).toBe('00071015523');
  expect(normalizeNdc('00071-0155-3')).toBe('00071015503');
  for (const value of ['71015523', '0071015523', '000710155230', ' 00071015523']) expect(normalizeNdc(value)).toBeNull();
});
it('requires validation after a new discovery before permitting not_listed', async () => {
  const drugs = await fixture('drugs'), plan = h.catalog.plans[0].base_plan_id;
  await h.replace(drugs); await importFormulary(h.db, scope);
  expect((await drugAvailability(h.db, scope))[0]?.status).toBe('complete');
  expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('not_listed');
  await h.replace(drugs);
  expect((await drugAvailability(h.db, scope))[0]?.status).toBe('unknown');
  expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('unknown');
  expect((await drugCoverage(h.db, plan, drugs[0].rxnorm_id, 2026)).status).toBe('listed_covered');
});
it('exposes partial and failed manifests, preserving actual validated shard counts', async () => {
  const drugs = await fixture('drugs'); await h.replace(drugs); await h.child(null, 'formulary_urls', '[{"synthetic":');
  expect((await importFormulary(h.db, scope)).status).toBe('QUARANTINED');
  expect((await drugAvailability(h.db, scope))[0]).toMatchObject({ status: 'partial', expected_children: 2, complete_children: 1 });
  await h.db.query(`UPDATE qhp_index SET status='connect_timeout' WHERE qhp_index_id=(SELECT qhp_index_id FROM qhp_index ORDER BY discovered_at DESC LIMIT 1)`);
  await h.db.query(`UPDATE qhp_child_url SET status='connect_timeout' WHERE qhp_index_id=(SELECT qhp_index_id FROM qhp_index ORDER BY discovered_at DESC LIMIT 1)`);
  expect((await drugAvailability(h.db, scope))[0]?.status).toBe('failed');
  // Restore the cached plan child's synthetic acquisition status for the next discovery.
  await h.db.query(`UPDATE qhp_child_url SET status='downloaded' WHERE kind='plan_urls'`);
});
it('a denial on a provider-only child never changes drug availability', async () => {
  const drugs = await fixture('drugs'); await h.replace(drugs); const child = await h.child([], 'provider_urls');
  await h.db.query(`UPDATE qhp_child_url SET status='access_denied',http_status=403 WHERE snapshot_id=$1`, [child]);
  await importFormulary(h.db, scope);
  expect((await drugAvailability(h.db, scope))[0]?.status).toBe('complete');
});
