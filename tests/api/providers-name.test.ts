import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/api/app.js';
import { searchProviders } from '../../src/api/provider-repository.js';
import type { SqlSession } from '../../src/db/database.js';
import { importProviders } from '../../src/ingest/qhp/provider.js';
import { fixture,scope,setup } from '../ingest/qhp/provider-helpers.js';

// Synthetic same-name identities belong to different plans in one active shard.
// P3J_POSTGIS_URL, if set, must be an empty disposable database.
describe('plan-scoped identity name candidates',() => {
  let h: Awaited<ReturnType<typeof setup>>,plan: string,otherRecord: string;
  const name = 'SyntheticNational';
  beforeAll(async () => {
    h = await setup(process.env.P3J_POSTGIS_URL ? createDatabase(process.env.P3J_POSTGIS_URL) : undefined);
    const source = (await fixture('records'))[0];
    const plans = source.plans.filter((p: any) => h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id));
    plan = plans[0].plan_id;
    expect(plans.length).toBeGreaterThan(1);
    await h.replace(Array.from({ length: 71 },(_,i) => ({ ...structuredClone(source),
      npi: String(1000020000+i),name: { first: 'Unrelated',last: 'Issuer' },
      plans: [structuredClone(plans[i === 70 ? 1 : 0])],addresses: [] })));
    await importProviders(h.db,scope);
    await h.db.exec(`INSERT INTO npi_provider(npi,entity_type,organization_name,in_scope,state_filter,data_date,snapshot_id)
      SELECT (1000020000+i)::text,'2','SyntheticNational '||i,true,'TX','2026-11-07','catalog'
      FROM generate_series(0,70) i;
      UPDATE npi_provider SET organization_name='CrossTwo SyntheticNational Ångström BoundaryOne',first_name='BoundaryTwo'
        WHERE npi='1000020000';
      UPDATE qhp_provider_record SET group_name='CrossOne' WHERE source_record=0;
      INSERT INTO provider_plan_group VALUES (repeat('c',64));
      INSERT INTO provider_plan_group_edge(group_id,source_plan_index,base_hios_id,plan_year,network_tier,tier_status)
      SELECT repeat('c',64),source_plan_index,base_hios_id,plan_year,network_tier,tier_status
        FROM qhp_provider_plan_legacy WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=0);
      INSERT INTO provider_record_plan_group SELECT snapshot_id,record_id,repeat('c',64)
        FROM qhp_provider_record WHERE source_record BETWEEN 30 AND 69;
      DELETE FROM qhp_provider_plan_legacy e USING provider_record_plan_group l
        WHERE e.snapshot_id=l.snapshot_id AND e.record_id=l.record_id;`);
    otherRecord = (await h.db.query<{ record_id: string }>(`SELECT record_id FROM qhp_provider_record WHERE source_record=70`)).rows[0]!.record_id;
  });
  afterAll(async () => { await h?.close(); });
  async function all(db: SqlSession) {
    const pages = [];
    for (const page of [1,2,3]) pages.push(await searchProviders(db,{ plan,year: 2026,name,page }));
    for (const [i,p] of pages.entries()) {
      expect(p.total).toBe(70);
      expect(p.next_page).toBe(i === 0 ? 2 : null);
      expect(p.providers).toHaveLength([50,20,0][i]!);
    }
    const rows = pages.flatMap(p => p.providers);
    expect(rows.every(p => p.record_id !== otherRecord && p.participation === 'listed_participating')).toBe(true);
    expect(rows.map(p => p.record_id)).toEqual([...rows.map(p => p.record_id)].sort());
    return pages;
  }
  it('keeps sparse/grouped name matches scoped before paging and preserves HTTP evidence',async () => {
    await all(h.db);
    const response = await createApp(h.db,{}).request(`/v1/providers?plan_id=${plan}&year=2026&name=${name}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'available',total: 70,next_page: 2 });
  });
  it('retains Unicode, case, field-boundary, short-name and wildcard semantics',async () => {
    for (const term of ['Ångström','ångström','BoundaryOne BoundaryTwo','BoundaryOne%BoundaryTwo','BoundaryOne_BoundaryTwo','One']) {
      const result = await searchProviders(h.db,{ plan,year: 2026,name: term,page: 1 });
      expect(result.total,term).toBe(1);
      expect(result.providers[0]!.npi,term).toBe('1000020000');
    }
  });
  it('both identity lookup and membership strategies return identical full ordered pages',async () => {
    const expected = await all(h.db);
    // Exercise the many-shard lookup and broad-name hash path on the same small
    // fixture. These choices affect work performed, never evidence or row limits.
    const forced: SqlSession = { ...h.db,query: (sql,args) => h.db.query(sql
      .replace('(SELECT count(*) FROM active_shards)=1','(SELECT count(*) FROM active_shards)=0')
      .replace('(SELECT count(*) FROM active_shards)>1','(SELECT count(*) FROM active_shards)>0')
      .replace('(SELECT count(*) FROM qualified_names)<=2000','(SELECT count(*) FROM qualified_names)<=0'),args) };
    expect(await all(forced)).toEqual(expected);
  });
  it.each(['CrossOne CrossTwo','CrossOne CrossTwo SyntheticNational'])(
    'another-word refinement preserves %s across issuer and identity fields',async name => {
    const q = { plan,year: 2026,name,page: 1 };
    const expected = await searchProviders(h.db,q);
    expect(expected.total).toBe(1);
    const forced: SqlSession = { ...h.db,query: (sql,args) => h.db.query(sql
      .replace('(SELECT count(*) FROM coarse_names)>2000','(SELECT count(*) FROM coarse_names)>0'),args) };
    expect(await searchProviders(forced,q)).toEqual(expected);
  });
  it('negative control: removing plan scope from the prefilter admits another plan\'s provider',async () => {
    let sql = '',args: unknown[] | undefined;
    await searchProviders({ ...h.db,query: async (query,parameters) => {
      sql = query; args = parameters;
      return h.db.query(query,parameters);
    } },{ plan,year: 2026,name,page: 1 });
    // Execute the production candidate CTEs before record filtering and paging.
    const prefix = sql.slice(0,sql.indexOf('selected AS MATERIALIZED')).replace(/,\s*$/,'');
    const candidates = `${prefix} SELECT record_id FROM name_candidates
      WHERE $3::text IS NULL AND $4::text IS NULL AND $6::text IS NULL ORDER BY record_id`;
    const contract = (rows: { record_id: string }[]) => {
      expect(rows).toHaveLength(70);
      expect(rows.some(p => p.record_id === otherRecord)).toBe(false);
    };
    contract((await h.db.query<{ record_id: string }>(candidates,args)).rows);
    const mutant = candidates.replace('AND e.base_hios_id=$1 AND e.plan_year=$2','');
    expect(mutant).not.toBe(candidates);
    const broken = (await h.db.query<{ record_id: string }>(mutant,args)).rows;
    expect(broken.some(p => p.record_id === otherRecord)).toBe(true);
    expect(() => contract(broken)).toThrow();
  });
  it('without migrations 740/741 the unindexed path returns identical complete ordered pages',async () => {
    const indexed = await all(h.db),rollback = new Error('rollback unindexed control');
    await expect(h.db.transaction(async tx => {
      await tx.exec(`DROP INDEX provider_identity_name_search;
        DROP INDEX provider_record_shard_identity_keys;
        DELETE FROM schema_migrations WHERE name IN ('740_provider_identity_names.sql','741_provider_shard_identity_keys.sql')`);
      expect((await tx.query(`SELECT 1 FROM pg_indexes WHERE indexname IN ('provider_identity_name_search','provider_record_shard_identity_keys')`)).rows).toHaveLength(0);
      expect(await all(tx)).toEqual(indexed);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await h.db.query(`SELECT 1 FROM pg_indexes WHERE indexname IN ('provider_identity_name_search','provider_record_shard_identity_keys')`)).rows).toHaveLength(2);
  });
});
