CREATE TABLE data_availability (
  data_availability_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 9999),
  market text NOT NULL,
  issuer_id text,
  catalog_status text NOT NULL DEFAULT 'not_yet_verified',
  premium_status text NOT NULL DEFAULT 'not_yet_verified',
  provider_status text NOT NULL DEFAULT 'not_yet_verified',
  formulary_status text NOT NULL DEFAULT 'not_yet_verified',
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  UNIQUE NULLS NOT DISTINCT (state, plan_year, market, issuer_id),
  CHECK (catalog_status IN ('not_yet_verified', 'available', 'partial', 'unknown', 'unavailable', 'unsupported', 'stale', 'conflicted')),
  CHECK (premium_status IN ('not_yet_verified', 'available', 'partial', 'unknown', 'unavailable', 'unsupported', 'stale', 'conflicted')),
  CHECK (provider_status IN ('not_yet_verified', 'available', 'partial', 'unknown', 'unavailable', 'unsupported', 'stale', 'conflicted')),
  CHECK (formulary_status IN ('not_yet_verified', 'available', 'partial', 'unknown', 'unavailable', 'unsupported', 'stale', 'conflicted'))
);
