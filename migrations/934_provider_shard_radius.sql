-- A shard and its radius must narrow the same index scan.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    EXECUTE 'CREATE INDEX address_point_provider_radius ON address_point USING gist(source_snapshot_id,point)
      WHERE source_table=''qhp_provider_address''';
  END IF;
END $$;
