-- Immutable scoped cells. Activation happens only after a complete build is committed.
CREATE TABLE handy_lowest_build (
  build_id text PRIMARY KEY,
  request_key text NOT NULL,
  request_json text NOT NULL,
  input_manifest text NOT NULL,
  algorithm text NOT NULL,
  expected_partitions integer NOT NULL CHECK (expected_partitions=1),
  written_partitions integer NOT NULL CHECK (written_partitions BETWEEN 0 AND 1),
  complete boolean NOT NULL DEFAULT false,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  expires_at timestamptz NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE handy_lowest_active (
  request_key text PRIMARY KEY,
  build_id text NOT NULL REFERENCES handy_lowest_build(build_id)
);
INSERT INTO row_provenance_rule(table_name,fixed_by,fixed_slug,reason,policy_name) VALUES
 ('handy_lowest_build','openplans','derived:lowest-premiums','scoped single-member premium build','app_state'),
 ('handy_lowest_active','openplans','derived:lowest-premiums','active complete premium build','app_state');
-- The migration runner installs provenance and record-policy columns on the new tables.
-- Empty derived tables must not move the generation of an installation that never builds them.
CREATE FUNCTION register_handy_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_TABLE_NAME='handy_lowest_build' AND EXISTS(SELECT 1 FROM handy_lowest_build))
    OR (TG_TABLE_NAME='handy_lowest_active' AND EXISTS(SELECT 1 FROM handy_lowest_active)) THEN
  INSERT INTO api_data_generation(table_name) VALUES (TG_TABLE_NAME) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER aa_handy_generation_registration AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_build
 FOR EACH STATEMENT EXECUTE FUNCTION register_handy_generation();
CREATE TRIGGER aa_handy_generation_registration AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_active
 FOR EACH STATEMENT EXECUTE FUNCTION register_handy_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_build
 FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_active
 FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
