-- A frozen input census, distinct address queue, and atomic batch ledger. No provider membership inference.
CREATE TABLE geocode_tx_run (
  run_id text PRIMARY KEY,
  source_shards text[] NOT NULL,
  npi_cursor text[] NOT NULL DEFAULT '{}',
  issuer_cursor text[] NOT NULL DEFAULT '{}',
  npi_staged boolean NOT NULL DEFAULT false,
  issuer_staged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE geocode_tx_input (
  run_id text NOT NULL REFERENCES geocode_tx_run,
  source_table text NOT NULL CHECK (source_table IN ('npi_address','qhp_provider_address')),
  source_row text NOT NULL,
  source_snapshot_id text NOT NULL,
  address_hash text NOT NULL,
  normalized_address text NOT NULL,
  PRIMARY KEY(run_id,source_table,source_row)
);
CREATE INDEX geocode_tx_input_hash ON geocode_tx_input(run_id,address_hash);
CREATE TABLE geocode_tx_address (
  run_id text NOT NULL REFERENCES geocode_tx_run,
  address_hash text NOT NULL CHECK (address_hash ~ '^[a-f0-9]{64}$'),
  address jsonb NOT NULL,
  selection_county text,
  PRIMARY KEY(run_id,address_hash)
);
CREATE INDEX geocode_tx_address_county ON geocode_tx_address(run_id,selection_county,address_hash);
CREATE TABLE geocode_tx_county (
  county_fips text PRIMARY KEY CHECK (county_fips ~ '^48[0-9]{3}$'),
  name text NOT NULL,
  south double precision NOT NULL, north double precision NOT NULL,
  west double precision NOT NULL, east double precision NOT NULL,
  rings jsonb NOT NULL,
  snapshot_id text NOT NULL,
  CHECK(south > 25 AND north < 37 AND west > -107 AND east < -93),
  CHECK(south < north AND west < east)
);
CREATE TABLE geocode_tx_result (
  address_hash text PRIMARY KEY,
  normalized_address text NOT NULL,
  match_status text NOT NULL CHECK (match_status IN ('Match','Tie','No_Match')),
  match_quality text,
  method text CHECK(method IN ('census_geocoder','zcta_centroid')),
  latitude double precision, longitude double precision,
  county_fips text REFERENCES geocode_tx_county,
  county_basis text NOT NULL CHECK(county_basis IN ('census_response','point_in_county','zip_candidate','unknown')),
  snapshot_id text NOT NULL,
  centroid_snapshot_id text,
  bounds_snapshot_id text,
  geocoded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK ((method IS NULL) = (latitude IS NULL)),
  CHECK (latitude IS NULL OR (latitude > 25 AND latitude < 37 AND longitude > -107 AND longitude < -93)),
  CHECK ((method='zcta_centroid') = (centroid_snapshot_id IS NOT NULL)),
  CHECK (method IS DISTINCT FROM 'census_geocoder' OR match_status='Match'),
  CHECK (method IS DISTINCT FROM 'zcta_centroid' OR (match_status IN ('Tie','No_Match') AND match_quality IS NULL))
);
CREATE TABLE geocode_tx_batch (
  run_id text NOT NULL REFERENCES geocode_tx_run,
  batch_id text NOT NULL,
  address_hashes text[] NOT NULL CHECK(cardinality(address_hashes) BETWEEN 1 AND 10000),
  request_csv text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  snapshot_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(run_id,batch_id),
  CHECK (completed = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX geocode_tx_one_pending ON geocode_tx_batch(run_id) WHERE NOT completed;
