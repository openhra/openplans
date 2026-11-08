-- Immutable fallback records retain the published county code and physical source row.
CREATE TABLE zip_county_fallback (
  source text NOT NULL CHECK (source IN ('cms_marketplace','geonames')),
  zip text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  county_name text NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  PRIMARY KEY (snapshot_id,zip,county_fips)
);
CREATE INDEX zip_county_fallback_zip ON zip_county_fallback(source,zip,snapshot_id);
CREATE TABLE geonames_import (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- Cache only exact ZIPs requested by a caller. Empty/error results have a bounded retry time.
CREATE TABLE cms_zip_lookup (
  zip text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 9999),
  snapshot_id text REFERENCES snapshot(snapshot_id),
  outcome text NOT NULL CHECK (outcome IN ('available','empty','failed')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  failure_code text,
  requested_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (zip,plan_year)
);
-- Append-only attempt evidence survives subsequent cache refreshes; error bodies are never retained.
CREATE TABLE cms_zip_attempt (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL DEFAULT 'cms_marketplace' CHECK (source='cms_marketplace'),
  zip text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 9999),
  snapshot_id text REFERENCES snapshot(snapshot_id),
  outcome text NOT NULL CHECK (outcome IN ('available','empty','failed')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  failure_code text,
  requested_url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
-- One persistent reservation/circuit breaker across API replicas using this database.
-- Operators may lower these conservative defaults to the allowance issued with their key.
CREATE TABLE cms_zip_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_request_at timestamptz NOT NULL DEFAULT 'epoch',
  day_start date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  daily_requests integer NOT NULL DEFAULT 0 CHECK (daily_requests >= 0),
  min_interval_ms integer NOT NULL DEFAULT 60000 CHECK (min_interval_ms >= 1000),
  max_daily_requests integer NOT NULL DEFAULT 100 CHECK (max_daily_requests BETWEEN 1 AND 100),
  blocked_until timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO cms_zip_budget(singleton) VALUES(true);
