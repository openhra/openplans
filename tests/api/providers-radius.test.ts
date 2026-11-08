import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/api/app.js';
import { setup } from '../ingest/qhp/provider-helpers.js';
import { saveResult } from '../../src/ingest/geocode/repository.js';
import type { Address } from '../../src/ingest/geocode/address.js';

// Synthetic identities and coordinates, never publisher evidence or real patients.
// P3I_POSTGIS_URL must name a separate empty disposable database.
describe('statewide identity radius: source keys, exact counts and pagination',() => {
  let h: Awaited<ReturnType<typeof setup>>,app: ReturnType<typeof createApp>;
  const lat = 29.7105,lon = -95.3973;
  const npi = (i: number) => String(1000010000+i);
  const path = `/v1/providers?lat=${lat}&lon=${lon}&radius_miles=5`;
  const get = async (url: string,target = app) => {
    const response = await target.request(url);
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  beforeAll(async () => {
    h = await setup(process.env.P3I_POSTGIS_URL ? createDatabase(process.env.P3I_POSTGIS_URL) : undefined);
    app = createApp(h.db,{});
    const postgis = (await h.db.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='address_point' AND column_name='point'`)).rows.length > 0;
    expect(postgis).toBe(Boolean(process.env.P3I_POSTGIS_URL));
    const indexes = (await h.db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname=current_schema() AND indexname IN ('npi_practice_source_key','address_point_npi_geography')`)).rows.map(r => r.indexname);
    expect(indexes).toContain('npi_practice_source_key');
    if (postgis) expect(indexes).toContain('address_point_npi_geography');
    // 55 far identities sort before all 60 near identities. Five more have no
    // current point: two missing and three geocoded against an obsolete snapshot.
    for (let i=0;i<121;i++) {
      await h.db.query(`INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
        VALUES ($1,$2,'Synthetic',$3,true,'TX','2026-11-07','catalog')`,
      [npi(i),i === 119 ? '2' : '1',i < 55 ? 'RadiusFar' : i < 115 ? 'RadiusNear' : 'RadiusMissing']);
      await h.db.query(`INSERT INTO npi_taxonomy VALUES ($1,1,'207Q00000X',true,'TX','catalog')`,[npi(i)]);
      if (i === 120) continue; // An address-less identity is not an unlocated address.
      await h.db.query(`INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
        VALUES ($1,'practice',0,'Synthetic radius address','HOUSTON','TX','77030','catalog')`,[npi(i)]);
      const address: Address = { npi: npi(i),kind: 'practice',ordinal: 0,line_1: 'Synthetic radius address',line_2: null,
        city: 'HOUSTON',state: 'TX',zip5: '77030',snapshot_id: i >= 117 ? 'registry' : 'catalog',
        source_table: 'npi_address',source_row: `${npi(i)}:practice:0` };
      if (i !== 115 && i !== 116) await saveResult(h.db,address,{ id: String(i),status: 'Match',quality: 'Exact',
        latitude: i < 55 ? lat+8/69.093 : lat+Math.max(0,i-55)/100000,longitude: lon },'catalog');
      if (i === 55 || i === 56) {
        await h.db.query(`INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
          VALUES ($1,'practice',1,'Synthetic second address','HOUSTON','TX','77030','catalog')`,[npi(i)]);
        await saveResult(h.db,{ ...address,ordinal: 1,line_1: 'Synthetic second address',source_row: `${npi(i)}:practice:1` },
          { id: 'second',status: 'Match',quality: 'Exact',latitude: i === 55 ? lat+8/69.093 : lat+.000005,longitude: lon },'catalog');
      }
    }
    // A mailing location and an out-of-scope identity cannot enter the result.
    await h.db.query(`UPDATE npi_address SET kind='mailing' WHERE npi=$1`,[npi(54)]);
    await h.db.query(`UPDATE npi_provider SET in_scope=false WHERE npi=$1`,[npi(53)]);
    await h.db.query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
      VALUES ('207Q00000X','Family Medicine Physician','Family Medicine','26.1','catalog')`);
  });
  afterAll(async () => { await h?.close(); });
  const contract = (body: any) => {
    expect(body.total).toBe(60);
    expect(body.providers).toHaveLength(50);
    expect(body.providers[0].npi).toBe(npi(55));
    expect(body.providers.every((p: any) => Number(p.npi) >= Number(npi(55)) && Number(p.npi) < Number(npi(115)))).toBe(true);
  };
  it('filters radius before paging, counts identities once and preserves current address provenance',async () => {
    const first = await get(path),second = await get(path+'&page=2'),empty = await get(path+'&page=3');
    contract(first);
    expect(first.meta).toMatchObject({ unlocated: 5,unlocated_scope: 'candidate_addresses' });
    expect(first.next_page).toBe(2);
    expect(second).toMatchObject({ total: 60,next_page: null });
    expect(second.providers).toHaveLength(10);
    expect(empty).toMatchObject({ total: 60,next_page: null,providers: [],meta: { unlocated: 5 } });
    const rows = [...first.providers,...second.providers];
    expect(new Set(rows.map(p => p.npi)).size).toBe(60);
    const distances = rows.map(p => p.distance_miles);
    expect(distances).toEqual([...distances].sort((a,b) => a-b));
    expect(rows.every(p => p.participation === 'not_evaluated' && p.participation_scope === null
      && p.addresses.every((a: any) => a.source === 'npi_address' && a.snapshot_id === 'catalog'
        && a.distance_miles <= 5 && a.participation === 'not_evaluated'))).toBe(true);
    expect(rows.find(p => p.npi === npi(55)).addresses).toHaveLength(1);
    expect(rows.find(p => p.npi === npi(56)).addresses).toHaveLength(2);
    expect((await get(path+'&name=RadiusNear&taxonomy=207Q00000X&type=individual')).meta.unlocated).toBe(0);
    expect((await get(path+'&name=RadiusMissing')).meta.unlocated).toBe(5);
    expect((await get(path+'&specialty=207Q&type=group'))).toMatchObject({ total: 0,providers: [],meta: { unlocated: 1 } });
    expect((await get(path+'&name=absent'))).toMatchObject({ total: 0,providers: [],meta: { unlocated: 0 } });
    expect((await get(`/v1/providers?lat=${lat}&lon=${lon}`))).toMatchObject({ total: 120,meta: { unlocated: 5 } });
    expect((await get('/v1/providers?page=3'))).toMatchObject({ total: 120,meta: { unlocated: 5 } });
  });
  it('negative control: executed SQL paging before radius loses near providers behind far ones',async () => {
    const mutant = createApp({ ...h.db,query: (sql,args) => {
      if (sql.includes('AS total')) {
        if (sql.includes('radius_points AS MATERIALIZED')) {
          sql = sql.replace('AND ST_DWithin(p.point,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9*1609.344,false)','AND true')
            .replace('distances AS (SELECT * FROM measured )','distances AS (SELECT * FROM measured WHERE distance_miles <= $9)')
            .replace('SELECT a.* FROM radius_locations a ',`SELECT a.* FROM radius_locations a
              JOIN (SELECT DISTINCT record_id FROM radius_locations ORDER BY record_id LIMIT 50) early
                ON early.record_id=a.record_id `);
        } else sql = sql.replace('), locations AS MATERIALIZED (',
          ' ORDER BY record_id,snapshot_id LIMIT 50), locations AS MATERIALIZED (');
      }
      return h.db.query(sql,args);
    } },{});
    contract(await get(path));
    const broken = await get(path,mutant);
    expect(broken.providers).toEqual([]);
    expect(() => contract(broken)).toThrow();
  });
});
