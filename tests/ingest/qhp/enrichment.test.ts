import { PGlite } from '@electric-sql/pglite';
import { describe,expect,it } from 'vitest';
import { coreMigrations,testDatabase } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { seedLegacyNppesScopes } from '../../../src/ingest/qhp/postgres-enrichment.js';

describe('legacy NPPES enrichment membership',() => {
  it('adds the archive state when a shared identity was first imported in FL; retains newer state observations',async () => {
    const db=testDatabase(new PGlite()),core=await coreMigrations();
    try {
      await migrate(db,core.directory);
      await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-scope','synthetic fixture','fixture');
        INSERT INTO snapshot(snapshot_id,source_id) VALUES('fl','synthetic-scope'),('tx','synthetic-scope'),('tx-new','synthetic-scope');
        INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id)
          VALUES('1215930367',true,'FL','2026-11-02','fl');
        INSERT INTO npi_state_scope VALUES('1215930367','FL',true,'2026-11-02','fl')`);
      const before=(await db.query('SELECT * FROM npi_provider')).rows;
      await seedLegacyNppesScopes(db,[{ npi: '1215930367',state_filter: 'TX',in_scope: true,data_date: '2026-11-02',snapshot_id: 'tx' }]);
      expect((await db.query('SELECT * FROM npi_provider')).rows).toEqual(before);
      expect((await db.query('SELECT state_filter,snapshot_id FROM npi_state_scope ORDER BY state_filter')).rows)
        .toEqual([{ state_filter: 'FL',snapshot_id: 'fl' },{ state_filter: 'TX',snapshot_id: 'tx' }]);
      await db.exec("UPDATE npi_state_scope SET data_date='2026-11-09',snapshot_id='tx-new' WHERE state_filter='TX'");
      await seedLegacyNppesScopes(db,[{ npi: '1215930367',state_filter: 'TX',in_scope: false,data_date: '2026-11-02',snapshot_id: 'tx' }]);
      expect((await db.query("SELECT in_scope,snapshot_id FROM npi_state_scope WHERE state_filter='TX'")).rows)
        .toEqual([{ in_scope: true,snapshot_id: 'tx-new' }]);
    } finally { await db.close();await core.cleanup(); }
  });
  it('derives the compatibility scope flag from all observations after a legacy archive adds a state',async () => {
    const db=testDatabase(new PGlite()),core=await coreMigrations();
    try {
      await migrate(db,core.directory);
      await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-scope','synthetic fixture','fixture');
        INSERT INTO snapshot(snapshot_id,source_id) VALUES('fl','synthetic-scope'),('tx','synthetic-scope');
        INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id)
          VALUES('1215930367',false,'FL','2026-11-02','fl');
        INSERT INTO npi_state_scope VALUES('1215930367','FL',false,'2026-11-02','fl')`);
      await seedLegacyNppesScopes(db,[{ npi: '1215930367',state_filter: 'TX',in_scope: true,data_date: '2026-11-02',snapshot_id: 'tx' }]);
      expect((await db.query('SELECT in_scope,state_filter,snapshot_id FROM npi_provider')).rows)
        .toEqual([{ in_scope: true,state_filter: 'FL',snapshot_id: 'fl' }]);
    } finally { await db.close();await core.cleanup(); }
  });
});
