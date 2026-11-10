-- Part D formulary, pharmacy network and pricing public use files (data.cms.gov). Serving is off
-- unless the operator enables it; rows keep their snapshot and source row.
CREATE TABLE partd_release (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  kind text NOT NULL CHECK (kind IN ('quarterly', 'monthly')),
  contract_year integer NOT NULL CHECK (contract_year BETWEEN 2019 AND 2100),
  as_of date NOT NULL,
  as_of_label text NOT NULL,
  tables text[] NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}',
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, contract_year, as_of_label)
);

CREATE TABLE partd_plan (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  contract_id text NOT NULL CHECK (contract_id ~ '^[EHRS][0-9]{4}$'),
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9]{3}$'),
  segment_id text NOT NULL CHECK (segment_id ~ '^[0-9]{1,3}$'),
  formulary_id text NOT NULL,
  suppressed boolean NOT NULL,
  cells jsonb NOT NULL,
  source_row integer NOT NULL,
  -- Local MA plans repeat once per service-area county (STATE, COUNTY_CODE in cells).
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX partd_plan_key ON partd_plan(snapshot_id, contract_id, plan_id, segment_id);

-- One formulary serves many plans: rows are stored once per FORMULARY_ID.
CREATE TABLE partd_formulary_drug (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  formulary_id text NOT NULL,
  rxcui text NOT NULL CHECK (rxcui ~ '^[0-9]+$'),
  ndc text NOT NULL CHECK (ndc ~ '^[0-9]{11}$'),
  tier integer,
  cells jsonb NOT NULL,
  source_row integer NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX partd_formulary_drug_rxcui ON partd_formulary_drug(snapshot_id, formulary_id, rxcui);

-- Excluded-drug, indication-based, beneficiary-cost and insulin-cost rows, keyed by plan.
CREATE TABLE partd_plan_row (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  table_name text NOT NULL CHECK (table_name IN ('excluded_drug', 'indication_coverage', 'beneficiary_cost', 'insulin_cost')),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text,
  rxcui text,
  tier integer,
  cells jsonb NOT NULL,
  source_row integer NOT NULL,
  PRIMARY KEY (snapshot_id, table_name, source_row)
);
CREATE INDEX partd_plan_row_plan ON partd_plan_row(snapshot_id, table_name, contract_id, plan_id);

CREATE TABLE partd_county (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  ssa_county_code text NOT NULL CHECK (ssa_county_code ~ '^[0-9]{5}$'),
  cells jsonb NOT NULL,
  source_row integer NOT NULL,
  PRIMARY KEY (snapshot_id, ssa_county_code)
);

-- Pharmacy networks repeat across a contract's plans: each distinct network is stored once.
CREATE TABLE partd_network (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  network_id text NOT NULL CHECK (network_id ~ '^[a-f0-9]{64}$'),
  pharmacies integer NOT NULL,
  PRIMARY KEY (snapshot_id, network_id)
);
CREATE TABLE partd_network_pharmacy (
  snapshot_id text NOT NULL,
  network_id text NOT NULL,
  npi text NOT NULL CHECK (npi ~ '^[12][0-9]{9}$'),
  zip text NOT NULL,
  cells jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, network_id, npi),
  FOREIGN KEY (snapshot_id, network_id) REFERENCES partd_network(snapshot_id, network_id)
);
CREATE INDEX partd_network_pharmacy_zip ON partd_network_pharmacy(snapshot_id, network_id, zip);
CREATE TABLE partd_plan_network (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  network_id text NOT NULL,
  first_source_row integer NOT NULL,
  PRIMARY KEY (snapshot_id, contract_id, plan_id, segment_id),
  FOREIGN KEY (snapshot_id, network_id) REFERENCES partd_network(snapshot_id, network_id)
);

-- Average unit cost per proxy NDC and days supply at in-area retail pharmacies (quarterly only).
CREATE TABLE partd_unit_cost (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  ndc text NOT NULL CHECK (ndc ~ '^[0-9]{11}$'),
  days_supply integer NOT NULL,
  unit_cost numeric(12, 4) NOT NULL,
  source_row bigint NOT NULL,
  PRIMARY KEY (snapshot_id, contract_id, plan_id, segment_id, ndc, days_supply)
);

-- Same statement trigger as every catalog table (920_api_data_generation.sql).
INSERT INTO api_data_generation(table_name) VALUES ('partd_release'), ('partd_plan'), ('partd_formulary_drug'), ('partd_plan_row'), ('partd_county'), ('partd_network'), ('partd_network_pharmacy'), ('partd_plan_network'), ('partd_unit_cost');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_release
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_plan
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_formulary_drug
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_plan_row
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_county
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_network
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_network_pharmacy
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_plan_network
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_unit_cost
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
