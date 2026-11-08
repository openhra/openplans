-- No dependency on npi_address: its migration is numbered 400. Source keys are explicit.
CREATE TABLE geocode_attempt (
  address_hash text NOT NULL CHECK (address_hash ~ '^[a-f0-9]{64}$'),
  source_table text NOT NULL CHECK (source_table = 'npi_address'),
  source_row text NOT NULL,
  normalized_address text NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  match_status text NOT NULL,
  match_quality text,
  outcome text NOT NULL CHECK (outcome IN ('point','no_point','issue')),
  geocoded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address_hash, source_table, source_row)
);
CREATE TABLE address_point (
  address_hash text NOT NULL,
  source_table text NOT NULL,
  source_row text NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  method text NOT NULL CHECK (method IN ('census_geocoder','zcta_centroid')),
  match_status text NOT NULL,
  match_quality text,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  centroid_snapshot_id text REFERENCES snapshot(snapshot_id),
  geocoded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address_hash, source_table, source_row),
  FOREIGN KEY (address_hash,source_table,source_row) REFERENCES geocode_attempt,
  CHECK ((method = 'zcta_centroid') = (centroid_snapshot_id IS NOT NULL))
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
    EXECUTE 'ALTER TABLE address_point ADD COLUMN point geography(Point,4326) GENERATED ALWAYS AS
      (ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography) STORED';
    EXECUTE 'CREATE INDEX address_point_geography ON address_point USING gist(point)';
  END IF;
END $$;
