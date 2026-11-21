-- Matched attempts are build evidence. Served points retain their snapshot foreign keys.
-- Catalog changes only, so every lock here is held for milliseconds. The checks are added
-- NOT VALID: they bind new writes at once, and `worker backfill geocode-archive` validates them
-- after it moves the existing matches in small transactions that never block readers.
ALTER TABLE address_point DROP CONSTRAINT address_point_address_hash_source_table_source_row_fkey;
ALTER TABLE address_point ADD CONSTRAINT address_point_source_identity CHECK (
  address_hash ~ '^[a-f0-9]{64}$' AND source_table IN ('npi_address','qhp_provider_address')
) NOT VALID;

-- A serving artifact omits this table. A later build recreates it before importing.
CREATE FUNCTION prepare_geocode_match_archive() RETURNS void LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
BEGIN
  IF to_regclass('public.geocode_match_archive') IS NULL THEN
    CREATE TABLE geocode_match_archive (
      LIKE geocode_attempt INCLUDING DEFAULTS,
      PRIMARY KEY (address_hash,source_table,source_row),
      CHECK (address_hash ~ '^[a-f0-9]{64}$'),
      CHECK (source_table IN ('npi_address','qhp_provider_address')),
      CHECK (match_status='Match' AND outcome='point'),
      FOREIGN KEY (source_snapshot_id) REFERENCES snapshot(snapshot_id),
      FOREIGN KEY (snapshot_id) REFERENCES snapshot(snapshot_id)
    );
    INSERT INTO row_provenance_rule(table_name,reference_columns,reason,policy_name)
    VALUES ('geocode_match_archive','{snapshot_id}','resolved geocoder response retained during builds','source_snapshot') ON CONFLICT (table_name) DO NOTHING;
    PERFORM install_row_provenance_all();
    PERFORM install_record_policy_all();
  END IF;
END $$;
SELECT prepare_geocode_match_archive();
-- Refuses new matched writes now; existing matches stay until the backfill moves them.
ALTER TABLE geocode_attempt ADD CONSTRAINT geocode_attempt_unresolved CHECK (match_status<>'Match') NOT VALID;
-- With no attempts and no points there is nothing to move; validate now, which is instant.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM geocode_attempt) AND NOT EXISTS (SELECT 1 FROM address_point) THEN
    ALTER TABLE geocode_attempt VALIDATE CONSTRAINT geocode_attempt_unresolved;
    ALTER TABLE address_point VALIDATE CONSTRAINT address_point_source_identity;
  END IF;
END $$;
