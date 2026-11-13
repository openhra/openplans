-- Part D plan average unit costs keyed by a small release number. The pricing file has about
-- 54 million rows per quarterly release, so each row carries a two-byte release key instead of
-- the snapshot id. The key row names the snapshot, which holds the file, its SHA-256 and the
-- fetch receipt. A release has a key row only once its pricing rows are in
-- partd_plan_unit_cost. partd_unit_cost from 950 is no longer written or read; a later
-- migration drops it.
CREATE TABLE partd_pricing_release (
  release_key smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id text NOT NULL UNIQUE REFERENCES partd_release(snapshot_id)
);

-- Fixed-width columns come first, so they need no alignment padding. The primary key follows
-- the reader's exact lookup: release, contract, plan, segment, NDC, then days supply.
CREATE TABLE partd_plan_unit_cost (
  release_key smallint NOT NULL REFERENCES partd_pricing_release(release_key),
  days_supply smallint NOT NULL CHECK (days_supply > 0),
  source_row integer NOT NULL CHECK (source_row > 0),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  ndc text NOT NULL CHECK (ndc ~ '^[0-9]{11}$'),
  unit_cost numeric(12, 4) NOT NULL,
  PRIMARY KEY (release_key, contract_id, plan_id, segment_id, ndc, days_supply)
);

-- The installer cannot infer a receipt for rows without a snapshot id. Every row comes from the
-- quarterly Part D file, and the release key leads to its snapshot.
INSERT INTO row_provenance_rule (table_name, reference_columns, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('partd_plan_unit_cost', '{}', 'cms-partd-spuf-quarterly', 'partd_pricing_release', 'receipt named by the release key row', 'source_snapshot');

INSERT INTO api_data_generation(table_name) VALUES ('partd_pricing_release'), ('partd_plan_unit_cost');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_pricing_release
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_plan_unit_cost
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
