import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { importFormulary, nullableRestriction } from '../../../src/ingest/qhp/formulary.js';
import { drugCoverage } from '../../../src/domain/drugs/index.js';
import { runWorker } from '../../../src/worker/commands.js';
import { fixture, scope, setup } from './formulary-helpers.js';

describe('Cigna formulary — real cuts and labelled synthetic mutants', () => {
  let h: Awaited<ReturnType<typeof setup>>, drugs: any[], plan: string, rxcui: string;
  beforeAll(async () => {
    h = await setup(); drugs = await fixture('drugs'); plan = h.catalog.plans[0].base_plan_id; rxcui = drugs[0].rxnorm_id;
  });
  afterAll(async () => { await h?.close(); });
  it('streams real associations, keeps only the active TX PUF catalog and publishes provenance', async () => {
    await h.replace(drugs);
    const report = await importFormulary(h.db, scope);
    expect(report.status).toBe('ACTIVE');
    expect(report.edges).toBe(drugs.reduce((sum, d) => sum + d.plans.filter((p: any) =>
      h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id) && p.years.includes(2026)).length, 0));
    expect(report.issues.plan_not_in_catalog).toBeGreaterThan(0);
    expect((await h.db.query('SELECT DISTINCT substring(base_hios_id,6,2) AS state FROM formulary_edge')).rows).toEqual([{ state: 'TX' }]);
    const result = await drugCoverage(h.db, plan, rxcui, 2026);
    expect(result).toMatchObject({ status: 'listed_covered', patient_price: null, drug_tier: drugs[0].plans.find((p: any) => p.plan_id === plan).drug_tier });
    expect(result.evidence[0]).toMatchObject({ source_record: 0, source_plan_index: expect.any(Number),
      raw_snapshot_id: expect.stringMatching(/^child-/), source_id: 'synthetic-harness', source_url: expect.stringContaining('cigna.com') });
    const variant = h.catalog.variants.find((v: any) => v.base_plan_id === plan).variant_plan_id;
    expect((await drugCoverage(h.db, variant, rxcui, 2026)).status).toBe('listed_covered');
    expect((await drugCoverage(h.db, plan, '99999999999999', 2026)).reason).toBe('rxcui_not_in_rxnorm');
    expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('not_listed');
  });
  it('negative control D5: missing PA remains NULL; a false-coercing mutant fails the contract', async () => {
    const mutant = structuredClone(drugs);
    for (const edge of mutant[0].plans) delete edge.prior_authorization;
    await h.replace(mutant);
    expect((await importFormulary(h.db, scope)).status).toBe('ACTIVE');
    expect((await drugCoverage(h.db, plan, rxcui, 2026)).prior_authorization).toBeNull();
    const contract = (fn: (v: unknown) => unknown) => expect(fn(undefined)).toBeNull();
    contract(nullableRestriction);
    expect(() => contract(v => v ?? false)).toThrow();
  });
  it('negative control: string quantity_limit is an issue, never false or publishable negative evidence', async () => {
    const mutant = structuredClone(drugs);
    for (const edge of mutant[0].plans) edge.quantity_limit = 'false';
    await h.replace(mutant);
    const report = await importFormulary(h.db, scope);
    expect(report.status).toBe('QUARANTINED');
    expect(report.issues.invalid_restriction_boolean).toBe(mutant[0].plans.filter((p: any) => h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id)).length);
    const bad = await h.db.query(`SELECT count(*)::int AS count FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 AND rxcui=$2`, [report.snapshot_id, rxcui]);
    expect(bad.rows).toEqual([{ count: 0 }]);
    expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('unknown');
    expect((await drugCoverage(h.db, plan, rxcui, 2026)).status).toBe('listed_covered');
  });
  it('negative control D2: a missing second shard preserves prior ACTIVE rows and blocks not_listed', async () => {
    await h.replace(drugs); const baseline = await importFormulary(h.db, scope);
    await h.replace(drugs); const missing = await h.child([]);
    await h.db.query('UPDATE snapshot SET raw_path=NULL WHERE snapshot_id=$1', [missing]);
    const report = await importFormulary(h.db, scope);
    expect(report).toMatchObject({ status: 'QUARANTINED', expected_children: 2, complete_children: 1, completeness: 'partial' });
    expect((await drugCoverage(h.db, plan, rxcui, 2026))).toMatchObject({ status: 'listed_covered', snapshot_id: baseline.snapshot_id });
    expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('unknown');
    expect((await h.db.query(`SELECT validation_state FROM snapshot WHERE snapshot_id=$1`, [baseline.snapshot_id])).rows[0]!.validation_state).toBe('ACTIVE');
  });
  it('negative control: truncated }, EOF quarantines all shards; no prior ACTIVE means unknown', async () => {
    await h.replace(drugs); const baseline = await importFormulary(h.db, scope);
    await h.replace(null, `[${JSON.stringify(drugs[0])},`);
    const report = await importFormulary(h.db, scope);
    expect(report).toMatchObject({ status: 'QUARANTINED', completeness: 'partial', issues: { truncated: 1 } });
    expect((await h.db.query('SELECT validation_state FROM snapshot WHERE snapshot_id=$1', [report.snapshot_id])).rows).toEqual([{ validation_state: 'QUARANTINED' }]);
    expect((await drugCoverage(h.db, plan, rxcui, 2026))).toMatchObject({ status: 'listed_covered', snapshot_id: baseline.snapshot_id });
    expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('unknown');
    await h.db.query('DELETE FROM formulary_active_set');
    expect((await drugCoverage(h.db, plan, rxcui, 2026)).status).toBe('unknown');
    expect((await drugCoverage(h.db, plan, '6809', 2026)).status).toBe('unknown');
  });
  it('negative control: unknown target plan produces counted issues and no edge', async () => {
    const mutant = structuredClone(drugs);
    mutant[0].plans.push({ ...mutant[0].plans.find((p: any) => p.plan_id === plan), plan_id: '76589TX9999999' });
    await h.replace(mutant); const report = await importFormulary(h.db, scope);
    expect(report.issues.plan_not_in_catalog).toBeGreaterThan(0);
    expect((await h.db.query(`SELECT * FROM formulary_edge WHERE base_hios_id='76589TX9999999'`)).rows).toEqual([]);
    const issues = (await h.db.query(`SELECT explanation FROM quality_issue q JOIN formulary_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 AND q.issue_code='plan_not_in_catalog'`, [report.snapshot_id])).rows;
    expect(JSON.parse(String(issues[0]!.explanation)).count).toBe(report.issues.plan_not_in_catalog);
  });
  it('serves unresolved tier labels verbatim with one warning per label × plan and activates', async () => {
    const mutant = structuredClone(drugs);
    for (const edge of mutant[0].plans) edge.drug_tier = 'SYNTHETIC-UNDEFINED-TIER';
    await h.replace(mutant); const report = await importFormulary(h.db, scope);
    expect(report.status).toBe('ACTIVE');
    const pairs = mutant[0].plans.filter((p: any) => h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id));
    expect(report.issues.unresolved_drug_tier).toBe(new Set(pairs.map((p: any) => p.plan_id)).size);
    expect(await drugCoverage(h.db, plan, rxcui, 2026)).toMatchObject({ status: 'listed_covered',
      drug_tier: 'SYNTHETIC-UNDEFINED-TIER', tier_status: 'unresolved', cost_sharing: null, patient_price: null });
    const warnings = (await h.db.query(`SELECT severity,explanation FROM quality_issue WHERE snapshot_id=$1
      AND issue_code='unresolved_drug_tier'`, [report.snapshot_id])).rows;
    expect(warnings).toHaveLength(report.issues.unresolved_drug_tier!);
    expect(warnings.every(w => w.severity === 'warning' && JSON.parse(String(w.explanation)).drug_tier === 'SYNTHETIC-UNDEFINED-TIER')).toBe(true);
    expect((await h.db.query(`SELECT DISTINCT drug_tier FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 AND rxcui=$2`, [report.snapshot_id, rxcui])).rows)
      .toEqual([{ drug_tier: 'SYNTHETIC-UNDEFINED-TIER' }]);
  });
  it('combines all required shards and exposes contradictory evidence without shard precedence', async () => {
    await h.replace(drugs);
    const alternate = structuredClone(drugs);
    for (const edge of alternate[0].plans) edge.prior_authorization = true;
    await h.child(alternate);
    // Distinct query shards can have identical redacted public URLs. Identity is the URL hash.
    await h.db.query(`UPDATE qhp_child_url SET url='https://www.cigna.com/synthetic?shard=REDACTED'
      WHERE kind='formulary_urls' AND qhp_index_id=(SELECT qhp_index_id FROM qhp_index ORDER BY discovered_at DESC LIMIT 1)`);
    const report = await importFormulary(h.db, scope);
    expect(report).toMatchObject({ status: 'ACTIVE', expected_children: 2, complete_children: 2 });
    expect((await drugCoverage(h.db, plan, rxcui, 2026))).toMatchObject({ status: 'conflicting', patient_price: null });
    // Synthetic explicit publisher exclusion: repository must preserve it rather than infer from absence.
    await h.db.query(`UPDATE formulary_edge SET evidence_status='explicitly_not_covered' WHERE snapshot_id IN
      (SELECT snapshot_id FROM formulary_shard WHERE source_set_id=$1) AND rxcui=$2`, [report.snapshot_id, rxcui]);
    await h.db.query(`UPDATE formulary_edge SET prior_authorization=NULL WHERE snapshot_id IN
      (SELECT snapshot_id FROM formulary_shard WHERE source_set_id=$1) AND rxcui=$2`, [report.snapshot_id, rxcui]);
    expect((await drugCoverage(h.db, plan, rxcui, 2026)).status).toBe('explicitly_not_covered');
  });
  it('validates hash after reading to EOF and fails safe when cached bytes change', async () => {
    await h.replace(drugs);
    const children = (await h.db.query(`SELECT s.raw_path FROM snapshot s JOIN qhp_child_url c USING(snapshot_id)
      JOIN qhp_index i USING(qhp_index_id) WHERE i.qhp_index_id=(SELECT qhp_index_id FROM qhp_index ORDER BY discovered_at DESC LIMIT 1)
      AND c.kind='formulary_urls'`)).rows;
    const path = String(children[0]!.raw_path);
    await writeFile(path, (await readFile(path, 'utf8')) + ' ');
    const report = await importFormulary(h.db, scope);
    expect(report).toMatchObject({ status: 'QUARANTINED', issues: { cache_hash_mismatch: 1 } });
  });
  it('never treats a missing discovery or catalog as a complete empty formulary', async () => {
    const report = await importFormulary(h.db, { ...scope, year: 2027 });
    expect(report).toMatchObject({ status: 'QUARANTINED', completeness: 'unknown', expected_children: 0,
      issues: { index_not_complete: 1, no_formulary_children: 1, catalog_not_available: 1 } });
    expect((await h.db.query(`SELECT status,reason FROM qhp_coverage_manifest WHERE issuer_id='76589' AND plan_year=2027`)).rows[0])
      .toMatchObject({ status: 'unknown', reason: expect.stringContaining('no_formulary_children') });
    expect((await drugCoverage(h.db, 'bad', rxcui, 2026)).reason).toBe('invalid_plan_id');
    expect((await drugCoverage(h.db, plan + '-99', rxcui, 2026)).reason).toBe('variant_not_in_catalog');
    expect((await drugCoverage(h.db, plan, rxcui, 2027)).reason).toBe('plan_not_in_catalog');
  });
  it('negative control: an unknown association year still quarantines rather than activating on warnings', async () => {
    const mutant = structuredClone(drugs);
    for (const edge of mutant[0].plans) edge.years = [];
    await h.replace(mutant);
    expect(await importFormulary(h.db, scope)).toMatchObject({ status: 'QUARANTINED',
      issues: { missing_or_invalid_years: expect.any(Number) } });
  });
  it('negative control: an unparseable plan definition is structural, even though missing tier mappings are warnings', async () => {
    await h.replace(drugs);
    const bad = await h.child(['synthetic-unparseable-record'], 'plan_urls');
    expect(await importFormulary(h.db, scope)).toMatchObject({ status: 'QUARANTINED',
      issues: { plan_definitions_incomplete: 1 } });
    // Keep the shared harness's next discovery free of this synthetic plan child.
    await h.db.query(`DELETE FROM qhp_child_url WHERE snapshot_id=$1`, [bad]);
  });
  it('dispatches worker import, emits report and closes; rejects malformed args before opening DB', async () => {
    await h.replace(drugs);
    const stdout: string[] = [], stderr: string[] = []; let closed = false;
    const output = { out: (s: string) => stdout.push(s), error: (s: string) => stderr.push(s) };
    expect(await runWorker(['ingest', 'qhp', 'formulary', '--year', '2026', '--state', 'TX', '--issuer', '76589'],
      () => ({ ...h.db, close: async () => { closed = true; } }), output, h.core.directory)).toBe(0);
    expect(JSON.parse(stdout[0]!).status).toBe('ACTIVE'); expect(closed).toBe(true); expect(stderr).toEqual([]);
    expect(await runWorker(['ingest', 'qhp', 'formulary', '--year', '2026'], () => { throw new Error('must not open'); }, output)).toBe(1);
    expect(stderr[0]).toContain('Usage:');
  });
  it('negative: next-year-only definitions cannot turn a current-year missing drug into not_listed', async () => {
    const nextYear = structuredClone(drugs);
    for (const drug of nextYear) for (const association of drug.plans) association.years = [2027];
    await h.replace(nextYear);
    await h.db.query("DELETE FROM qhp_child_url WHERE kind='plan_urls'");
    const definitions = await fixture('plans');
    for (const definition of definitions) definition.years = [2027];
    await h.child(definitions,'plan_urls');
    expect(await importFormulary(h.db,scope)).toMatchObject({ status: 'QUARANTINED',completeness: 'partial',edges: 0,
      issues: { catalog_plan_year_not_in_definitions: 1 } });
    expect((await drugCoverage(h.db,plan,'6809',2026)).status).toBe('unknown');
  });

  it('a definition-year gap retains valid positive drugs unresolved but cannot establish absent coverage', async () => {
    await h.replace(drugs); // Retains the preceding synthetic 2027-only plan definitions.
    expect(await importFormulary(h.db,scope)).toMatchObject({ status: 'ACTIVE',completeness: 'partial',
      reason: 'catalog_plan_year_not_in_definitions' });
    expect(await drugCoverage(h.db,plan,rxcui,2026)).toMatchObject({ status: 'listed_covered',tier_status: 'unresolved' });
    expect((await drugCoverage(h.db,plan,'6809',2026)).status).toBe('unknown');
  });

});
