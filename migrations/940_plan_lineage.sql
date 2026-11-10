-- CMS Plan ID Crosswalk PUF: one row per published crosswalk row (county/ZIP level).
-- plan_year is the publication year (the successor year); prior_year is plan_year - 1.
-- The all-zero placeholder ID ("00000XX0000000") is stored as NULL, never as a plan.
CREATE TABLE plan_lineage (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  dental_only boolean NOT NULL,
  prior_year integer NOT NULL,
  prior_plan_id text NOT NULL CHECK (prior_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  prior_issuer_id text NOT NULL CHECK (prior_issuer_id ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL CHECK (plan_year = prior_year + 1),
  plan_id text CHECK (plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  issuer_id text CHECK (issuer_id ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  zip_code text NOT NULL,
  crosswalk_level text NOT NULL,
  crosswalk_reason text NOT NULL,
  age_off_plan_id text,
  silver_csr_plan_id text,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX plan_lineage_successor ON plan_lineage(snapshot_id, plan_id);
CREATE INDEX plan_lineage_state ON plan_lineage(snapshot_id, state);

-- One served crosswalk publication per successor year; older snapshots stay immutable.
CREATE TABLE plan_lineage_active (
  plan_year integer PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);

-- Same statement trigger as every catalog table (920_api_data_generation.sql).
INSERT INTO api_data_generation(table_name) VALUES ('plan_lineage'), ('plan_lineage_active');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plan_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plan_lineage_active
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
