-- Medicare plan data (MA, MA-PD, PDP, SNP, Cost) from CMS public files. Every row keeps its
-- snapshot and source row. Availability lives here, beside the individual-market table.
CREATE TABLE medicare_release (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  family text NOT NULL CHECK (family IN ('landscape', 'pbp', 'stars', 'crosswalk', 'service_area')),
  contract_year integer NOT NULL CHECK (contract_year BETWEEN 2006 AND 2100),
  as_of date NOT NULL,
  as_of_label text NOT NULL,
  member_name text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}',
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, contract_year, as_of_label)
);

-- Landscape: one row per plan segment; county-varying cells live in medicare_plan_county.
CREATE TABLE medicare_plan (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  contract_year integer NOT NULL,
  contract_id text NOT NULL CHECK (contract_id ~ '^[EHRS][0-9]{4}$'),
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9]{3}$'),
  segment_id text NOT NULL CHECK (segment_id ~ '^[0-9]{1,3}$'),
  contract_category text NOT NULL,
  plan_type text NOT NULL,
  plan_name text NOT NULL,
  snp_type text,
  part_d_coverage boolean,
  -- Published cells, keyed by the Landscape column name (as filed, trimmed).
  cells jsonb NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, contract_id, plan_id, segment_id)
);
CREATE INDEX medicare_plan_type ON medicare_plan(snapshot_id, contract_category, plan_type);

CREATE TABLE medicare_plan_county (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  county_name text NOT NULL,
  -- PDP rows list "All Counties" for a state.
  all_counties boolean NOT NULL,
  county_fips text CHECK (county_fips ~ '^[0-9]{5}$'),
  lips_amount text,
  ma_region_code text,
  pdp_region_code text,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, source_row),
  CHECK (NOT all_counties OR county_fips IS NULL)
);
CREATE INDEX medicare_plan_county_fips ON medicare_plan_county(snapshot_id, county_fips);
CREATE INDEX medicare_plan_county_state ON medicare_plan_county(snapshot_id, state) WHERE all_counties;
CREATE INDEX medicare_plan_county_plan ON medicare_plan_county(snapshot_id, contract_id, plan_id, segment_id);

-- SSA county code to Census FIPS, from the CMS contract service-area files (many-to-many).
CREATE TABLE medicare_county_code (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  ssa_county_code text NOT NULL CHECK (ssa_county_code ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  state text NOT NULL,
  county_name text NOT NULL,
  first_source_row integer NOT NULL,
  PRIMARY KEY (snapshot_id, ssa_county_code, county_fips)
);
CREATE INDEX medicare_county_code_fips ON medicare_county_code(snapshot_id, county_fips);

-- PBP PlanArea (local plans, per SSA county) and PlanRegionArea (regional MA and PDP).
-- Employer group (EGHP) rows are not loaded.
CREATE TABLE medicare_plan_area (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('plan_area', 'plan_region_area')),
  ssa_county_code text CHECK (ssa_county_code ~ '^[0-9]{5}$'),
  county_name text,
  state text,
  region_type text,
  region_code text,
  region_name text,
  partial_county boolean NOT NULL,
  pending boolean NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, source, source_row),
  CHECK ((source = 'plan_area') = (ssa_county_code IS NOT NULL))
);
CREATE INDEX medicare_plan_area_plan ON medicare_plan_area(snapshot_id, contract_id, plan_id, segment_id);
CREATE INDEX medicare_plan_area_ssa ON medicare_plan_area(snapshot_id, ssa_county_code);

-- PBP tables as filed: non-empty cells only, typed by the release dictionary.
CREATE TABLE medicare_pbp_row (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  table_name text NOT NULL,
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  fields jsonb NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, table_name, source_row)
);
CREATE INDEX medicare_pbp_row_plan ON medicare_pbp_row(snapshot_id, contract_id, plan_id, segment_id);

CREATE TABLE medicare_pbp_field (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  table_name text NOT NULL,
  field text NOT NULL,
  data_type text,
  title text,
  codes jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, table_name, field)
);

-- PBP Section A and D summary per plan segment (contacts, websites, deductible, MOOP).
CREATE TABLE medicare_pbp_plan (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  plan_type_code text,
  summary jsonb NOT NULL,
  source_rows jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, contract_id, plan_id, segment_id)
);

CREATE TABLE medicare_star_rating (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  rating_year integer NOT NULL,
  contract_id text NOT NULL CHECK (contract_id ~ '^[EHRS0-9][0-9A-Z]{4}$'),
  measure text NOT NULL CHECK (measure IN ('part_c_summary', 'part_d_summary', 'overall')),
  status text NOT NULL CHECK (status IN ('rated', 'too_new', 'not_enough_data', 'not_applicable', 'unknown')),
  stars numeric(2, 1) CHECK (stars BETWEEN 1 AND 5),
  published text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, contract_id, measure),
  CHECK ((status = 'rated') = (stars IS NOT NULL))
);

CREATE TABLE medicare_plan_crosswalk (
  snapshot_id text NOT NULL REFERENCES medicare_release(snapshot_id),
  contract_year integer NOT NULL,
  previous_contract_id text,
  previous_plan_id text,
  previous_plan_name text,
  current_contract_id text,
  current_plan_id text,
  current_plan_name text,
  status text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX medicare_crosswalk_current ON medicare_plan_crosswalk(snapshot_id, current_contract_id, current_plan_id);
CREATE INDEX medicare_crosswalk_previous ON medicare_plan_crosswalk(snapshot_id, previous_contract_id, previous_plan_id);

-- Same statement trigger as every catalog table (920_api_data_generation.sql).
INSERT INTO api_data_generation(table_name) VALUES ('medicare_release'), ('medicare_plan'), ('medicare_plan_county'), ('medicare_county_code'), ('medicare_plan_area'), ('medicare_pbp_row'), ('medicare_pbp_field'), ('medicare_pbp_plan'), ('medicare_star_rating'), ('medicare_plan_crosswalk');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_release
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_plan
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_plan_county
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_county_code
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_plan_area
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_pbp_row
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_pbp_field
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_pbp_plan
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_star_rating
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON medicare_plan_crosswalk
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
