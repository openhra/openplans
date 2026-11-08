-- File snapshots are immutable; a complete catalog is published through one atomic pointer.
CREATE TABLE puf_import (
  import_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  plan_year integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE puf_import_file (
  import_id text NOT NULL REFERENCES puf_import(import_id),
  kind text NOT NULL,
  snapshot_id text NOT NULL UNIQUE REFERENCES snapshot(snapshot_id),
  input_rows integer NOT NULL DEFAULT 0,
  stored_rows integer NOT NULL DEFAULT 0,
  PRIMARY KEY (import_id, kind)
);
CREATE TABLE puf_active_catalog (
  state text NOT NULL,
  plan_year integer NOT NULL,
  import_id text NOT NULL REFERENCES puf_import(import_id),
  PRIMARY KEY (state, plan_year)
);
CREATE TABLE issuer (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  state text NOT NULL,
  plan_year integer NOT NULL,
  marketing_names jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, issuer_id)
);
-- Preserve each source row independently of deduplicated base/variant identities.
CREATE TABLE plan_attribute (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  base_plan_id text NOT NULL CHECK (base_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  published_plan_id text NOT NULL,
  market text NOT NULL,
  metal text NOT NULL,
  dental_only boolean NOT NULL,
  network_id text NOT NULL,
  service_area_id text NOT NULL,
  plan_name text NOT NULL,
  exchange_status text NOT NULL,
  on_exchange boolean NOT NULL,
  off_exchange boolean NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE TABLE plan (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  base_plan_id text NOT NULL CHECK (base_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  market text NOT NULL,
  metal text NOT NULL,
  dental_only boolean NOT NULL,
  network_id text NOT NULL,
  service_area_id text NOT NULL,
  plan_name text NOT NULL,
  exchange_status text NOT NULL,
  on_exchange boolean NOT NULL,
  off_exchange boolean NOT NULL,
  PRIMARY KEY (snapshot_id, base_plan_id)
);
CREATE TABLE plan_variant (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  variant_plan_id text NOT NULL CHECK (variant_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}-[0-9]{2}$'),
  base_plan_id text NOT NULL,
  csr_suffix text NOT NULL,
  csr_variation_type text,
  variant_name text,
  exchange_status text NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, variant_plan_id)
);
CREATE TABLE service_area (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  service_area_id text NOT NULL,
  market text NOT NULL,
  dental_only boolean NOT NULL,
  service_area_name text NOT NULL,
  cover_entire_state boolean NOT NULL,
  PRIMARY KEY (snapshot_id, issuer_id, service_area_id, market, dental_only)
);
CREATE TABLE service_area_county (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  service_area_id text NOT NULL,
  market text NOT NULL,
  dental_only boolean NOT NULL,
  service_area_name text NOT NULL,
  county_fips text CHECK (county_fips ~ '^[0-9]{5}$'),
  cover_entire_state boolean NOT NULL,
  partial_county boolean,
  zip_codes text NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX service_area_county_lookup ON service_area_county(snapshot_id, issuer_id, service_area_id, market, dental_only, county_fips);
CREATE TABLE network (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  network_id text NOT NULL,
  network_name text NOT NULL,
  network_url text NOT NULL,
  market text NOT NULL,
  dental_only boolean NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE TABLE rate (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  base_plan_id text NOT NULL CHECK (base_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  rating_area_id text NOT NULL,
  effective_date date NOT NULL,
  expiration_date date NOT NULL,
  tobacco text NOT NULL,
  age_band text NOT NULL,
  rating_method text NOT NULL,
  individual_rate_cents bigint,
  individual_tobacco_rate_cents bigint,
  couple_cents bigint,
  primary_subscriber_and_one_dependent_cents bigint,
  primary_subscriber_and_two_dependents_cents bigint,
  primary_subscriber_and_three_or_more_dependents_cents bigint,
  couple_and_one_dependent_cents bigint,
  couple_and_two_dependents_cents bigint,
  couple_and_three_or_more_dependents_cents bigint,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row),
  CHECK (effective_date <= expiration_date)
);
CREATE INDEX rate_plan_lookup ON rate(snapshot_id, base_plan_id, rating_area_id);
CREATE TABLE plan_benefit (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  base_plan_id text NOT NULL,
  published_plan_id text NOT NULL,
  benefit_name text NOT NULL,
  cost_sharing_raw jsonb NOT NULL,
  cost_sharing_parsed jsonb NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE INDEX plan_benefit_lookup ON plan_benefit(snapshot_id, published_plan_id);
CREATE TABLE business_rule (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  issuer_id text NOT NULL,
  product_id text,
  base_plan_id text,
  market text NOT NULL,
  dental_only boolean NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, source_row)
);
CREATE TABLE state_rating_rule (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL,
  state text NOT NULL,
  plan_year integer NOT NULL,
  market text NOT NULL,
  method text NOT NULL CHECK (method IN ('unsupported', 'per_member', 'family_tier', 'composite')),
  citation text,
  PRIMARY KEY (snapshot_id, state, plan_year, market),
  CHECK (method = 'unsupported' OR citation IS NOT NULL)
);
