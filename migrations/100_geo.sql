-- Census 2020 area measurements are square metres, preserved as published integers.
CREATE TABLE zcta_county (
  zcta text NOT NULL CHECK (zcta ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  county_name text NOT NULL,
  arealand_zcta bigint NOT NULL CHECK (arealand_zcta >= 0),
  areawater_zcta bigint NOT NULL CHECK (areawater_zcta >= 0),
  arealand_county bigint NOT NULL CHECK (arealand_county >= 0),
  areawater_county bigint NOT NULL CHECK (areawater_county >= 0),
  arealand_part bigint NOT NULL CHECK (arealand_part >= 0 AND arealand_part <= arealand_zcta AND arealand_part <= arealand_county),
  areawater_part bigint NOT NULL CHECK (areawater_part >= 0 AND areawater_part <= areawater_zcta AND areawater_part <= areawater_county),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, zcta, county_fips)
);
CREATE INDEX zcta_county_zip ON zcta_county(zcta);
CREATE TABLE zcta_centroid (
  zcta text NOT NULL CHECK (zcta ~ '^[0-9]{5}$'),
  -- Gazetteer internal points, not geometric centroids or postal delivery coordinates.
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL CHECK (source_row > 1),
  PRIMARY KEY (snapshot_id, zcta)
);
CREATE TABLE rating_area (
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  rating_area_id text NOT NULL CHECK (rating_area_id ~ '^Rating Area [1-9][0-9]*$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 9999),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  PRIMARY KEY (snapshot_id, state, county_fips, plan_year)
);
-- A successfully committed import selects a consistent trio of immutable source snapshots.
CREATE TABLE geo_import (
  state text NOT NULL,
  plan_year integer NOT NULL,
  relationship_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  centroid_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  rating_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state, plan_year)
);
