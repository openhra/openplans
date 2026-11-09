-- Keep open-data results separate from Census evidence and private operator points.
CREATE TABLE geocode_open_run (
  run_id text PRIMARY KEY,
  cleanup_run_id text NOT NULL REFERENCES geocode_tx_run(run_id),
  source_run_id text NOT NULL REFERENCES geocode_tx_run(run_id),
  state text NOT NULL CHECK (state IN ('TX','FL','NC')),
  dataset_sha256 text NOT NULL CHECK (dataset_sha256 ~ '^[a-f0-9]{64}$'),
  index_sha256 text NOT NULL CHECK (index_sha256 ~ '^[a-f0-9]{64}$'),
  import_profile text NOT NULL CHECK (import_profile='nominatim-address-v1'),
  data_date date NOT NULL,
  source text NOT NULL DEFAULT 'open_geocoder' CHECK (source='open_geocoder'),
  licence text NOT NULL DEFAULT 'ODbL-1.0' CHECK (licence='ODbL-1.0'),
  attribution text NOT NULL DEFAULT '© OpenStreetMap contributors' CHECK (attribution='© OpenStreetMap contributors'),
  sample_limit integer NOT NULL CHECK (sample_limit >= 0),
  census_matches_before integer NOT NULL,
  source_addresses integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE geocode_open_result (
  run_id text NOT NULL REFERENCES geocode_open_run,
  address_hash text NOT NULL CHECK (address_hash ~ '^[a-f0-9]{64}$'),
  request_address jsonb NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  point jsonb,
  observed_at timestamptz,
  PRIMARY KEY (run_id,address_hash),
  CHECK (point IS NULL OR COALESCE((
    point->>'source' = 'open_geocoder' AND point->>'licence' = 'ODbL-1.0'
    AND point->>'attribution' = '© OpenStreetMap contributors'
    AND point ?& ARRAY['source','licence','attribution','latitude','longitude','county_fips','data_date','sha256','index_sha256','import_profile','bounds_snapshot_id']
  ),false)),
  CHECK (point IS NULL OR completed)
);
