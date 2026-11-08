import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { fetchToCache } from '../../../src/fetch/index.js';
import { ingestProviders } from '../../../src/ingest/qhp/provider-acquire.js';
import { readFile, writeFile } from 'node:fs/promises';
import { importProviders } from '../../../src/ingest/qhp/provider.js';
import { acquireProviders } from '../../../src/ingest/qhp/provider-acquire.js';
import { providerParticipation, providerIdentity, providerSpecialties } from '../../../src/domain/providers/index.js';
import { runWorker } from '../../../src/worker/commands.js';
import { fixture, scope, setup } from './provider-helpers.js';

describe('Cigna providers — real cuts, labelled synthetic mutants', () => {
  let h: Awaited<ReturnType<typeof setup>>, providers: any[], plan: string, npi: string;
  beforeAll(async () => {
    h = await setup(); providers = await fixture('records');
    plan = providers[0].plans.find((p: any) => h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id)).plan_id;
    npi = providers[0].npi;
  });
  afterAll(async () => { await h?.close(); });
  const edgesFor = (r: any) => r.plans.filter((p: any) => p.years.includes(2026)
    && h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id));
  it('keeps full source address lists, original spelling, scoped catalog associations and provenance', async () => {
    await h.replace(providers); const r = await importProviders(h.db,scope);
    expect(r.status).toBe('ACTIVE'); expect(r.records).toBe(providers.length);
    expect(r.addresses).toBe(providers.reduce((sum,p) => sum+p.addresses.length,0));
    expect(r.edges).toBe(providers.reduce((sum,p) => sum+edgesFor(p).length,0));
    expect((await h.db.query('SELECT DISTINCT substring(base_hios_id,6,2) AS state FROM qhp_provider_plan')).rows).toEqual([{ state: 'TX' }]);
    const records = (await h.db.query(`SELECT r.* FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY r.source_record`,[r.snapshot_id])).rows;
    for (const [i,row] of records.entries()) {
      expect(row.name).toEqual(providers[i].name ?? null);
      expect(row.facility_name).toEqual(providers[i].facility_name ?? null);
      expect(row.group_name).toEqual(providers[i].group_name ?? null);
      expect(row.facility_type).toEqual(providers[i].facility_type ?? null); expect(row.speciality).toEqual(providers[i].speciality ?? null);
      expect(row.specialty).toEqual(providers[i].specialty ?? null); expect(row.accepting).toEqual(providers[i].accepting ?? null);
      expect(providerSpecialties(row)).toEqual(providers[i].speciality ?? providers[i].specialty ?? []);
    }
    const addresses = (await h.db.query(`SELECT a.raw FROM qhp_provider_address a
      JOIN qhp_provider_record r USING(snapshot_id,record_id) JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY r.source_record,a.address_index`,[r.snapshot_id])).rows;
    expect(addresses.map(a => a.raw)).toEqual(providers.flatMap(p => p.addresses));
    const lookup = await providerParticipation(h.db,plan,npi,2026);
    // Cigna publishes PREFERRED while its plan definitions declare TEXASCONNECTNETWORK.
    const declared = (await fixture('plans')).find((p: any) => p.plan_id === plan).network.map((n: any) => n.network_tier);
    const resolved = providers[0].plans.filter((p: any) => p.plan_id === plan).some((p: any) => declared.includes(p.network_tier));
    expect(lookup.status).toBe('listed_participating');
    expect(lookup.evidence[0]?.tier_status).toBe(resolved ? 'resolved' : 'unresolved');
    expect(lookup.evidence[0]).toMatchObject({ participation_scope: 'provider_record',npi,source_record: 0,
      raw_snapshot_id: expect.stringMatching(/^child-/),source_updated_at: providers[0].last_updated_on });
    expect((await providerParticipation(h.db,plan,'unlisted-source-record',2026)).status).toBe('not_listed');
  });
  it('negative D7: three addresses and two plans produce 3 + 2 rows, never 6 plan rows', async () => {
    const mutant = structuredClone(providers[0]); // Synthetic cardinality mutant of a public record.
    mutant.addresses = Array.from({ length: 3 },(_,i) => structuredClone(providers[0].addresses[i % providers[0].addresses.length]));
    mutant.plans = edgesFor(mutant).slice(0,2); expect(mutant.plans).toHaveLength(2);
    await h.replace([mutant]); const r = await importProviders(h.db,scope);
    expect(r).toMatchObject({ status: 'ACTIVE',records: 1,addresses: 3,edges: 2 });
    const cardinality = (addresses: number,edges: number) => { expect(addresses).toBe(3); expect(edges).toBe(2); };
    cardinality(r.addresses,r.edges); expect(() => cardinality(3,3*2)).toThrow();
  });
  it('negative: truncated temporary child discards every row and keeps prior ACTIVE evidence', async () => {
    const mutant = structuredClone(providers[0]); mutant.plans = [edgesFor(mutant)[0]];
    await h.replace([mutant]); const prior = await importProviders(h.db,scope);
    // Synthetic truncation of a real cut, written only into the harness temporary directory.
    await h.replace(null,JSON.stringify(Array.from({ length: 1100 },() => ({ ...mutant,addresses: mutant.addresses.slice(0,1) }))).slice(0,-1));
    const failed = await importProviders(h.db,scope);
    expect(failed).toMatchObject({ status: 'QUARANTINED',completeness: 'partial',records: 0,addresses: 0,edges: 0,
      issues: { truncated: 1 } });
    expect((await h.db.query(`SELECT count(*)::int AS records FROM qhp_provider_record r
      JOIN provider_shard s USING(snapshot_id) WHERE s.source_set_id=$1`,[failed.snapshot_id])).rows[0])
      .toEqual({ records: 0 });
    expect(await providerParticipation(h.db,plan,npi,2026))
      .toMatchObject({ status: 'listed_participating',snapshot_id: prior.snapshot_id });
    expect((await providerParticipation(h.db,plan,'absent',2026)).status).toBe('unknown');
  });
  it('negative: a different issuer plan is omitted with a scoped issue', async () => {
    const mutant = structuredClone(providers[0]);
    mutant.plans = [{ ...edgesFor(mutant)[0],plan_id: '12846'+plan.slice(5) }];
    await h.replace([mutant]); const result = await importProviders(h.db,scope);
    expect(result).toMatchObject({ edges: 0,issues: { plan_outside_issuer_scope: 1 } });
    const issue = (await h.db.query(`SELECT explanation FROM quality_issue WHERE issue_code='plan_outside_issuer_scope'
      AND snapshot_id IN (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`,[result.snapshot_id])).rows[0]!;
    expect(JSON.parse(String(issue.explanation))).toMatchObject({ requested_scope: scope,first_plan_id: mutant.plans[0].plan_id });
    expect((await h.db.query(`SELECT count(*)::int AS edges FROM qhp_provider_plan p
      JOIN provider_shard s USING(snapshot_id) WHERE s.source_set_id=$1`,[result.snapshot_id])).rows[0])
      .toEqual({ edges: 0 });
  });
  it.each([['FL','TX'],['GA','FL'],['NC','FL']])(
    'negative: a %s source record naming a %s plan creates zero edges and a state-scoped issue', async (state, otherState) => {
    const requested = { ...scope,state };
    const mutant = structuredClone(providers[0]);
    mutant.plans = [{ ...edgesFor(mutant)[0],plan_id: scope.issuer+otherState+plan.slice(7) }];
    await h.replace([mutant]);
    // State selections and the cross-state association are labelled synthetic mutants.
    const index = (await h.db.query(`SELECT qhp_index_id FROM qhp_index ORDER BY discovered_at DESC LIMIT 1`)).rows[0]!;
    await h.db.query('UPDATE qhp_index SET state=$1 WHERE qhp_index_id=$2',[state,index.qhp_index_id]);
    try {
      const result = await importProviders(h.db,requested);
      expect(result).toMatchObject({ edges: 0,issues: { plan_outside_state_scope: 1 } });
      const issue = (await h.db.query(`SELECT explanation FROM quality_issue WHERE issue_code='plan_outside_state_scope'
        AND snapshot_id IN (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`,[result.snapshot_id])).rows[0]!;
      expect(JSON.parse(String(issue.explanation))).toMatchObject({ requested_scope: requested,first_plan_id: mutant.plans[0].plan_id });
      expect((await h.db.query(`SELECT count(*)::int n FROM qhp_provider_plan_all p JOIN provider_shard s USING(snapshot_id)
        WHERE s.source_set_id=$1`,[result.snapshot_id])).rows).toEqual([{ n: 0 }]);
    } finally { await h.db.query('UPDATE qhp_index SET state=$1 WHERE qhp_index_id=$2',['TX',index.qhp_index_id]); }
  });
  it('retains validated evidence when advisory statistics encounter a synthetic concurrent lock', async () => {
    const record = structuredClone(providers[0]); await h.replace([record]);
    const before = (await h.db.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
      current_setting('plan_cache_mode') AS plan_cache_mode`)).rows[0];
    let injected = 0;
    const contender: typeof h.db = { ...h.db,transaction: run => h.db.transaction(tx => run({ ...tx,
      exec: async sql => {
        if (sql.startsWith('ANALYZE qhp_provider_record;')) {
          injected++;
          // A real PostgreSQL error aborts this savepoint, just like lock_timeout.
          await tx.exec("DO $$ BEGIN RAISE EXCEPTION 'synthetic concurrent ANALYZE lock' USING ERRCODE='55P03'; END $$");
        } else await tx.exec(sql);
      },
    })) };
    const result = await importProviders(contender,scope);
    expect(injected).toBe(1);
    expect(result).toMatchObject({ status: 'ACTIVE',records: 1,edges: edgesFor(record).length });
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('listed_participating');
    expect((await h.db.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
      current_setting('plan_cache_mode') AS plan_cache_mode`)).rows[0]).toEqual(before);
  });
  it.each([8,27,34,63])('factors a %i-association list once and retains every duplicate source ordinal', async count => {
    const record = structuredClone(providers[0]); record.addresses = record.addresses.slice(0,1);
    record.plans = Array.from({ length: count },() => structuredClone(edgesFor(providers[0])[0]));
    await h.replace([record,record]); const report = await importProviders(h.db,scope);
    expect(report).toMatchObject({ status: 'ACTIVE',records: 2,edges: 2*count });
    const links = (await h.db.query(`SELECT l.* FROM provider_record_plan_group l JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY record_id`,[report.snapshot_id])).rows;
    expect(links).toHaveLength(2); expect(links[0]!.group_id).toBe(links[1]!.group_id);
    expect((await h.db.query(`SELECT count(*)::int n FROM provider_plan_group_edge WHERE group_id=$1`,[links[0]!.group_id])).rows)
      .toEqual([{ n: count }]);
    expect((await h.db.query(`SELECT count(*)::int n FROM qhp_provider_plan_legacy e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[report.snapshot_id])).rows).toEqual([{ n: 0 }]);
    const rows = (await h.db.query(`SELECT e.record_id,e.source_plan_index FROM qhp_provider_plan e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY record_id,source_plan_index`,[report.snapshot_id])).rows;
    expect(rows).toHaveLength(2*count);
    expect(rows.map(r => r.source_plan_index)).toEqual([...Array(count).keys(),...Array(count).keys()]);
  });
  it('stores identical dense lists once, preserving ordinals and isolating per-record overrides', async () => {
    const record = structuredClone(providers[0]);
    record.addresses = record.addresses.slice(0,1);
    record.plans = Array.from({ length: 100 },() => structuredClone(edgesFor(providers[0])[0]));
    await h.replace([record,record]); const report = await importProviders(h.db,scope);
    expect(report).toMatchObject({ status: 'ACTIVE',records: 2,addresses: 2,edges: 200 });
    const links = (await h.db.query(`SELECT l.* FROM provider_record_plan_group l JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY l.record_id`,[report.snapshot_id])).rows;
    expect(links).toHaveLength(2); expect(new Set(links.map(l => l.group_id)).size).toBe(1);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM provider_plan_group_edge WHERE group_id=$1`,[links[0]!.group_id])).rows)
      .toEqual([{ n: 100 }]);
    const rows = (await h.db.query(`SELECT e.* FROM qhp_provider_plan e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 ORDER BY e.record_id,e.source_plan_index`,[report.snapshot_id])).rows;
    expect(rows).toHaveLength(200);
    for (const [i,row] of rows.entries()) expect(row).toMatchObject({ source_plan_index: i%100,
      base_hios_id: record.plans[i%100].plan_id,participation_scope: 'provider_record',evidence_status: 'listed_participating' });
    await h.db.query(`UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
      WHERE snapshot_id=$1 AND record_id=$2 AND source_plan_index=0`,[links[0]!.snapshot_id,links[0]!.record_id]);
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('conflicting');
    expect((await h.db.query('SELECT count(*)::int AS n FROM provider_plan_override WHERE snapshot_id=$1',[links[0]!.snapshot_id])).rows).toEqual([{ n: 1 }]);
    expect((await h.db.query(`SELECT evidence_status FROM qhp_provider_plan WHERE snapshot_id=$1
      AND record_id=$2 AND source_plan_index=0`,[links[1]!.snapshot_id,links[1]!.record_id])).rows)
      .toEqual([{ evidence_status: 'listed_participating' }]);
    await h.db.query(`DELETE FROM qhp_provider_plan WHERE snapshot_id=$1 AND record_id=$2 AND source_plan_index=0`,
      [links[0]!.snapshot_id,links[0]!.record_id]);
    expect((await h.db.query('SELECT count(*)::int AS n FROM provider_plan_override WHERE snapshot_id=$1',[links[0]!.snapshot_id])).rows).toEqual([{ n: 0 }]);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM qhp_provider_plan e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[report.snapshot_id])).rows).toEqual([{ n: 199 }]);
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('listed_participating');
    // Synthetic dense-list truncation after more than one flushed record batch.
    await h.replace(null,JSON.stringify(Array.from({ length: 1100 },() => record)).slice(0,-1));
    const failed = await importProviders(h.db,scope);
    expect(failed).toMatchObject({ completeness: 'partial',records: 0,edges: 0,issues: { truncated: 1 } });
    expect((await h.db.query(`SELECT count(*)::int AS n FROM provider_record_plan_group l JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[failed.snapshot_id])).rows).toEqual([{ n: 0 }]);
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('listed_participating');
  });
  it('refreshes a parse-failed cached body instead of reusing the same truncated hash forever', async () => {
    const record = structuredClone(providers[0]); record.plans = [edgesFor(record)[0]];
    const healthy = JSON.stringify([record]), broken = healthy.slice(0,-1);
    const rawId = await h.replace(null,broken);
    const child = (await h.db.query(`SELECT c.*,s.raw_path FROM qhp_child_url c JOIN snapshot s ON s.snapshot_id=c.snapshot_id
      WHERE c.snapshot_id=$1`,[rawId])).rows[0]!;
    await h.db.query(`UPDATE qhp_index SET child_hosts='["www.cigna.com"]' WHERE issuer_id='76589'`);
    const lookup = async () => [{ address: '8.8.8.8',family: 4 as const }];
    const cached = await fetchToCache(String(child.url),{ dataDir: h.directory,
      source: 'qhp-child-provider_urls-'+child.url_sha256,allowHosts: ['www.cigna.com'],expectedContent: 'json',lookup,
      transport: async () => ({ status: 200,headers: { 'content-type': 'application/json' },body: Readable.from([broken]) }) });
    if (cached.outcome === 'not_modified') throw new Error('unexpected conditional response');
    await h.db.query(`UPDATE snapshot SET raw_path=$2,sha256=$3,compressed_bytes=$4 WHERE snapshot_id=$1`,
      [rawId,cached.path,cached.metadata.sha256,cached.metadata.bytes]);
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'QUARANTINED',records: 0,issues: { truncated: 1 } });
    let requests = 0;
    const transport = async () => { requests++; return { status: 200,headers: { 'content-type': 'application/json' },body: Readable.from([healthy]) }; };
    // Synthetic old-hash pin reproduces the prior cache-reuse trap and must stay quarantined.
    expect(await ingestProviders(h.db,scope,{ fetchOptions: { dataDir: h.directory,lookup,transport,
      expectedSha256: cached.metadata.sha256 } })).toMatchObject({ status: 'QUARANTINED',records: 0,issues: { truncated: 1 } });
    expect(requests).toBe(0);
    expect(await ingestProviders(h.db,scope,{ fetchOptions: { dataDir: h.directory,lookup,transport } }))
      .toMatchObject({ status: 'ACTIVE',records: 1,edges: 1 });
    expect(requests).toBe(1);
    expect(await readFile(cached.path,'utf8')).toBe(broken); // immutable failed acquisition retained
  });
  it('negative: absent years quarantine the association and create no edge', async () => {
    const mutant = structuredClone(providers[0]); mutant.plans = [edgesFor(mutant)[0]]; delete mutant.plans[0].years;
    await h.replace([mutant]); const r = await importProviders(h.db,scope);
    expect(r).toMatchObject({ status: 'QUARANTINED',edges: 0,issues: { missing_or_invalid_years: 1 } });
    expect((await providerParticipation(h.db,plan,'absent',2026)).status).toBe('unknown');
  });
  it('negative: unknown tier is retained unresolved as a warning; structural failures still quarantine', async () => {
    const mutant = structuredClone(providers[0]); mutant.plans = [{ ...edgesFor(mutant)[0],network_tier: 'SYNTHETIC-UNDECLARED' }];
    await h.replace([mutant]); const r = await importProviders(h.db,scope);
    expect(r).toMatchObject({ status: 'ACTIVE',edges: 1,issues: { unresolved_network_tier: 1 } });
    const lookup = await providerParticipation(h.db,plan,npi,2026);
    expect(lookup).toMatchObject({ status: 'listed_participating',reason: null });
    expect(lookup.evidence[0]).toMatchObject({ network_tier: 'SYNTHETIC-UNDECLARED',tier_status: 'unresolved' });
    const warnings = (await h.db.query(`SELECT explanation FROM quality_issue WHERE issue_code='unresolved_network_tier'
      AND snapshot_id IN (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`,[r.snapshot_id])).rows;
    expect(warnings.map(w => JSON.parse(String(w.explanation)))).toEqual([
      expect.objectContaining({ base_hios_id: plan,network_tier: 'SYNTHETIC-UNDECLARED',count: 1 })]);
    mutant.plans[0].plan_id_type = 'SYNTHETIC-BAD'; await h.replace([mutant]);
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'QUARANTINED',edges: 0,issues: { unsupported_plan_id_type: 1 } });
  });
  it('negative: no NPI retains a source-scoped record with a null NPI', async () => {
    const mutant = structuredClone(providers[0]); delete mutant.npi;
    mutant.plans = [edgesFor(mutant)[0]];
    await h.replace([mutant]); const r = await importProviders(h.db,scope);
    const row = (await h.db.query(`SELECT r.* FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[r.snapshot_id])).rows[0]!;
    expect(row.npi).toBeNull(); expect(row.record_id).toMatch(/^[a-f0-9]{64}:0$/);
    const lookup = await providerParticipation(h.db,plan,String(row.record_id),2026);
    expect(lookup.evidence[0]?.npi).toBeNull(); expect(lookup.evidence[0]?.record_id).toBe(row.record_id);
  });
  it('NPPES identity/taxonomy join counts absent/deactivated findings without implying membership', async () => {
    await h.db.query(`INSERT INTO npi_provider(npi,deactivated,in_scope,state_filter,data_date,snapshot_id)
      VALUES ($1,true,true,'TX','2026-10-01','catalog') ON CONFLICT(npi) DO UPDATE SET deactivated=true`,[npi]);
    await h.db.query(`INSERT INTO npi_taxonomy(npi,ordinal,code,is_primary,snapshot_id)
      VALUES ($1,1,'SYNTHETIC-TAXONOMY',true,'catalog') ON CONFLICT DO NOTHING`,[npi]);
    await h.replace(providers); const r = await importProviders(h.db,scope);
    expect(r.nppes_matches).toBe(1); expect(r.issues.npi_deactivated_still_listed).toBeGreaterThan(0);
    expect(r.issues.npi_absent_from_nppes).toBeGreaterThan(0);
    const row = (await h.db.query(`SELECT r.* FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 AND r.npi=$2`,[r.snapshot_id,npi])).rows[0]!;
    expect(await providerIdentity(h.db,String(row.record_id),String(row.snapshot_id)))
      .toMatchObject({ nppes_npi: npi,deactivated: true,taxonomy: [{ code: 'SYNTHETIC-TAXONOMY',is_primary: true,snapshot_id: 'catalog' }] });
  });
  it('all advertised shards must complete; missing shard preserves prior ACTIVE and blocks not_listed', async () => {
    const mutant = structuredClone(providers[0]); mutant.plans = [edgesFor(mutant)[0]];
    const definitions = await fixture('plans'); mutant.plans[0].network_tier = definitions.find((p: any) => p.plan_id === plan).network[0].network_tier;
    await h.replace([mutant]); const baseline = await importProviders(h.db,scope);
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('listed_participating');
    await h.replace([mutant]); const child = await h.child([]);
    await h.db.query('UPDATE snapshot SET raw_path=NULL WHERE snapshot_id=$1',[child]);
    const r = await importProviders(h.db,scope);
    expect(r).toMatchObject({ status: 'QUARANTINED',expected_children: 2,complete_children: 1 });
    expect((await h.db.query(`SELECT count(*)::int AS n FROM qhp_provider_plan_all e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[r.snapshot_id])).rows).toEqual([{ n: 1 }]);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM qhp_provider_plan e JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`,[r.snapshot_id])).rows).toEqual([{ n: 0 }]);
    expect(await providerParticipation(h.db,plan,npi,2026)).toMatchObject({ status: 'listed_participating',snapshot_id: baseline.snapshot_id });
    expect((await providerParticipation(h.db,plan,'absent',2026)).status).toBe('unknown');
  });
  it('resolved edges support NPI/record/variant lookup, explicit exclusions and conflicts without shard precedence', async () => {
    const mutant = structuredClone(providers[0]); mutant.plans = [edgesFor(mutant)[0]];
    const definitions = await fixture('plans'); mutant.plans[0].network_tier = definitions.find((p: any) => p.plan_id === plan).network[0].network_tier;
    await h.replace([mutant]); await h.child([mutant]);
    const report = await importProviders(h.db,scope);
    expect(report).toMatchObject({ status: 'ACTIVE',expected_children: 2,complete_children: 2 });
    let lookup = await providerParticipation(h.db,plan,npi,2026);
    expect(lookup.status).toBe('listed_participating'); expect(lookup.evidence).toHaveLength(2);
    const recordId = lookup.evidence[0]!.record_id;
    expect((await providerParticipation(h.db,plan,recordId,2026)).status).toBe('listed_participating');
    const variant = h.catalog.variants.find((v: any) => v.base_plan_id === plan).variant_plan_id;
    expect((await providerParticipation(h.db,variant,npi,2026)).status).toBe('listed_participating');
    expect((await providerParticipation(h.db,plan+'-99',npi,2026)).reason).toBe('variant_not_in_catalog');
    // Synthetic authoritative exclusion stored in one shard; absence and accepting status never produce it.
    await h.db.query(`UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
      WHERE snapshot_id=$1`,[lookup.evidence[0]!.snapshot_id]);
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('conflicting');
    await h.db.query(`UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
      WHERE snapshot_id IN (SELECT snapshot_id FROM provider_shard WHERE source_set_id=$1)`,[report.snapshot_id]);
    lookup = await providerParticipation(h.db,plan,npi,2026);
    expect(lookup.status).toBe('explicitly_not_participating');
  });
  it('D1: real Sanford tail yields truncated, quarantines and never manufactures not_listed', async () => {
    const tail = await readFile(new URL('../../fixtures/qhp/provider/sanford-tail.json',import.meta.url),'utf8');
    await h.replace(null,tail); const r = await importProviders(h.db,scope);
    expect(r).toMatchObject({ status: 'QUARANTINED',issues: { truncated: 1 } });
    expect((await providerParticipation(h.db,plan,'absent',2026)).status).toBe('unknown');
    await h.db.query('DELETE FROM provider_active_set');
    expect((await providerParticipation(h.db,plan,npi,2026)).status).toBe('unknown');
    const contract = async (status: string) => expect(status).toBe('unknown');
    await contract((await providerParticipation(h.db,plan,'absent',2026)).status);
    await expect(contract('not_listed')).rejects.toThrow();
  });
  it('validates EOF hash and all plan definitions; missing catalog cannot publish empty coverage', async () => {
    const raw = await h.replace(providers);
    const path = String((await h.db.query('SELECT raw_path FROM snapshot WHERE snapshot_id=$1',[raw])).rows[0]!.raw_path);
    await writeFile(path,(await readFile(path,'utf8'))+' ');
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'QUARANTINED',issues: { cache_hash_mismatch: 1 } });
    expect(await importProviders(h.db,{ ...scope,year: 2027 })).toMatchObject({ status: 'QUARANTINED',
      issues: { index_not_complete: 1,no_provider_children: 1,catalog_not_available: 1,plan_definitions_incomplete: 1 } });
    expect((await providerParticipation(h.db,'bad',npi,2026)).reason).toBe('invalid_plan_id');
    expect((await providerParticipation(h.db,plan,npi,2027)).reason).toBe('plan_not_in_catalog');
  });
  it('structurally invalid plan definitions and empty association years quarantine rather than becoming tier warnings', async () => {
    await h.replace(providers);
    const active = await importProviders(h.db,scope);
    const badDefinition = await h.child([{ plan_id_type: 'HIOS-PLAN-ID',plan_id: plan,years: [] }],'plan_urls');
    let acquired = 0;
    const failed = await importProviders(h.db,scope,{ prepareChild: async child => { acquired++; return child; } });
    expect(failed).toMatchObject({ status: 'QUARANTINED',records: 0,edges: 0,complete_children: 0,distinct_npis: 0,nppes_matches: 0,nppes_match_rate: null,
      issues: { plan_definitions_incomplete: 1 } });
    expect(acquired).toBe(0);
    expect((await h.db.query('SELECT snapshot_id FROM provider_active_set')).rows).toEqual([{ snapshot_id: active.snapshot_id }]);
    expect((await h.db.query('SELECT status,reason,record_count FROM provider_shard WHERE source_set_id=$1',[failed.snapshot_id])).rows)
      .toEqual([expect.objectContaining({ status: 'failed',reason: 'plan_definitions_incomplete',record_count: 0 })]);
    await h.db.query('DELETE FROM qhp_child_url WHERE snapshot_id=$1',[badDefinition]);
    const mutant = structuredClone(providers[0]); mutant.plans = [{ ...edgesFor(mutant)[0],years: [] }];
    await h.replace([mutant]);
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'QUARANTINED',edges: 0,issues: { missing_or_invalid_years: 1 } });
  });
  it('worker validates flags, emits a report and closes the DB; cached imports require no network', async () => {
    await h.replace(providers); let closed = false; const out: string[] = [],errors: string[] = [];
    const output = { out: (s: string) => out.push(s),error: (s: string) => errors.push(s) };
    expect(await runWorker(['ingest','qhp','providers','--year','2026','--state','TX','--issuer','76589'],
      () => ({ ...h.db,close: async () => { closed = true; } }),output,h.core.directory)).toBe(0);
    expect(closed).toBe(true); expect(JSON.parse(out[0]!).status).toBe('ACTIVE'); expect(errors).toEqual([]);
    expect(await runWorker(['ingest','qhp','providers','--year','2026'],() => { throw new Error('must not connect'); },output)).toBe(1);
    expect(errors[0]).toContain('Usage:');
  });
  it('acquires every missing advertised provider child through the safe fetcher and persists provenance', async () => {
    const previous = await h.replace(providers);
    const raw = (await h.db.query('SELECT * FROM snapshot WHERE snapshot_id=$1',[previous])).rows[0]!;
    await h.db.query(`UPDATE qhp_child_url SET status='not_fetched' WHERE snapshot_id=$1`,[previous]);
    let calls = 0;
    await acquireProviders(h.db,scope,{ fetcher: async (url,options) => {
      calls++; expect(url).toMatch(/^https:/); expect(options.maxBytes).toBe(4*1024**3);
      // The fixture harness's index has no real host approvals; fake transport makes no request.
      expect(options.expectedContent).toBe('json');
      return { outcome: 'reused',snapshotId: String(raw.sha256),path: String(raw.raw_path),metadataPath: 'synthetic-unused',
        metadata: { snapshot_id: String(raw.sha256),source: options.source,url: String(url),final_url: String(url),redirect_chain: [],
          fetched_at: '2026-11-07T00:00:00Z',status: 200,content_type: 'application/json',etag: null,last_modified: null,
          bytes: Buffer.byteLength(await readFile(String(raw.raw_path))),sha256: String(raw.sha256) } };
    } });
    expect(calls).toBe(1);
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'ACTIVE',records: providers.length });
  });
  it('acquisition failures persist a quarantinable attempt rather than fabricating an empty success', async () => {
    await h.replace(providers);
    await h.db.query(`UPDATE qhp_child_url SET status='not_fetched' WHERE kind='provider_urls'`);
    let calls = 0;
    await acquireProviders(h.db,scope,{ fetcher: async () => { calls++; throw new Error('synthetic fetch failure'); } });
    expect(calls).toBe(1);
    expect(await importProviders(h.db,scope)).toMatchObject({ status: 'QUARANTINED',issues: { child_not_cached: 1 } });
  });
  it('negative: an evergreen index with only next-year definitions cannot establish current-year absence', async () => {
    const nextYear = structuredClone(providers);
    for (const provider of nextYear) for (const association of provider.plans) association.years = [2027];
    await h.replace(nextYear);
    await h.db.query("DELETE FROM qhp_child_url WHERE kind='plan_urls'");
    const definitions = await fixture('plans');
    for (const definition of definitions) definition.years = [2027];
    await h.child(definitions,'plan_urls');
    const report = await importProviders(h.db,scope);
    expect(report).toMatchObject({ status: 'QUARANTINED',completeness: 'partial',edges: 0,
      issues: { catalog_plan_year_not_in_definitions: 1 } });
    expect((await providerParticipation(h.db,plan,'synthetic-absent',2026)).status).toBe('unknown');
  });

  it('a valid positive association survives a definition-year gap, while absence remains unknown', async () => {
    await h.replace(providers); // The preceding mutant left only 2027 definitions, retained by replace.
    const report = await importProviders(h.db,scope);
    expect(report).toMatchObject({ status: 'ACTIVE',completeness: 'partial',reason: 'catalog_plan_year_not_in_definitions' });
    expect((await providerParticipation(h.db,plan,npi,2026))).toMatchObject({ status: 'listed_participating',
      warnings: expect.arrayContaining(['UNRESOLVED_NETWORK_TIER','SOURCE_INCOMPLETE']) });
    expect((await providerParticipation(h.db,plan,'synthetic-absent',2026)).status).toBe('unknown');
  });

});
