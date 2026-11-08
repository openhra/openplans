-- Per-table revisions avoid one global lock across independent importer transactions.
CREATE TABLE api_data_generation (
  table_name text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  writer_xid bigint
);
-- Distinguish independent databases sharing a cache, including already-loaded catalogs.
INSERT INTO api_data_generation(table_name) VALUES ('__database__:' || md5(random()::text || clock_timestamp()::text));

CREATE FUNCTION bump_api_data_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE api_data_generation SET revision=revision+1, writer_xid=txid_current()
    WHERE table_name=TG_TABLE_NAME AND writer_xid IS DISTINCT FROM txid_current();
  RETURN NULL;
END;
$$;

-- Covers COPY, bulk INSERT, UPDATE, DELETE and TRUNCATE, including publications and
-- quarantine/status changes. Revision writes roll back with failed imports.
-- New catalog tables must register the same statement trigger in their migration.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('api_data_generation','schema_migrations','spatial_ref_sys')
    ORDER BY tablename
  LOOP
    INSERT INTO api_data_generation(table_name) VALUES (t.tablename);
    EXECUTE format('CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()', t.tablename);
  END LOOP;
END;
$$;
