-- Radius searches start at source points, then validate the current address key/snapshot.
-- Cover the practice key for both spatial lookups and exact missing-point counts.
CREATE INDEX npi_practice_source_key ON npi_address
  ((npi||':'||kind||':'||ordinal::text),snapshot_id) INCLUDE (npi,kind,ordinal)
  WHERE kind='practice';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
    -- Issuer addresses greatly outnumber identities; avoid reading their radius hits
    -- for an NPPES-only search. The existing full GiST still serves issuer searches.
    EXECUTE 'CREATE INDEX address_point_npi_geography ON address_point USING gist(point)
      WHERE source_table=''npi_address''';
  END IF;
END $$;
