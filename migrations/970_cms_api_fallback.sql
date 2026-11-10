-- Coverage answers from the CMS Marketplace API, kept apart from issuer and PUF data.
-- Readers consult these tables only when the answer from loaded files is unknown, so loaded
-- files always take precedence. Used only with OPENPLANS_CMS_FALLBACK=on.
INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
VALUES('cms-marketplace-api','Centers for Medicare & Medicaid Services','cms_marketplace_api',
  '["https://developer.cms.gov/marketplace-api/"]','https://developer.cms.gov/marketplace-api/')
ON CONFLICT DO NOTHING;

-- Lets a row name its receipt by (snapshot_id, source_id, retrieved_at) in one foreign key, so
-- sourced_by and sourced_at cannot disagree with the receipt.
ALTER TABLE snapshot ADD CONSTRAINT snapshot_receipt_key UNIQUE (snapshot_id, source_id, retrieved_at);

CREATE TABLE cms_api_drug_coverage (
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  rxcui text NOT NULL CHECK (rxcui ~ '^[0-9]{1,20}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 2100),
  coverage text NOT NULL CHECK (coverage IN ('Covered','NotCovered','GenericCovered','DataNotProvided')),
  generic_rxcui text CHECK (generic_rxcui ~ '^[0-9]{1,20}$'),
  snapshot_id text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  expires_at timestamptz NOT NULL,
  sourced_by text NOT NULL CHECK (sourced_by = 'cms-marketplace-api'),
  sourced_at timestamptz NOT NULL,
  sourced_slug text NOT NULL CHECK (sourced_slug = snapshot_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, rxcui, plan_year),
  FOREIGN KEY (snapshot_id, sourced_by, sourced_at)
    REFERENCES snapshot(snapshot_id, source_id, retrieved_at)
);
CREATE TABLE cms_api_provider_coverage (
  plan_id text NOT NULL CHECK (plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  npi text NOT NULL CHECK (npi ~ '^[0-9]{10}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 2100),
  coverage text NOT NULL CHECK (coverage IN ('Covered','NotCovered','DataNotProvided')),
  accepting text,
  addresses jsonb NOT NULL DEFAULT '[]',
  snapshot_id text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  expires_at timestamptz NOT NULL,
  sourced_by text NOT NULL CHECK (sourced_by = 'cms-marketplace-api'),
  sourced_at timestamptz NOT NULL,
  sourced_slug text NOT NULL CHECK (sourced_slug = snapshot_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, npi, plan_year),
  FOREIGN KEY (snapshot_id, sourced_by, sourced_at)
    REFERENCES snapshot(snapshot_id, source_id, retrieved_at)
);
-- Append-only audit. Counts only: no plan ids, drug codes or NPIs.
CREATE TABLE cms_api_attempt (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint text NOT NULL CHECK (endpoint IN ('drugs/covered','providers/covered')),
  plan_year integer,
  pairs integer NOT NULL CHECK (pairs >= 0),
  snapshot_id text REFERENCES snapshot(snapshot_id),
  outcome text NOT NULL CHECK (outcome IN ('absorbed','empty','failed','refused')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  failure_code text,
  refusal_reason text,
  latency_ms integer CHECK (latency_ms >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
-- One shared allowance for every replica on this database: 1 call per second, 500 per UTC day.
CREATE TABLE cms_api_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_request_at timestamptz NOT NULL DEFAULT 'epoch',
  day_start date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  daily_requests integer NOT NULL DEFAULT 0 CHECK (daily_requests >= 0),
  min_interval_ms integer NOT NULL DEFAULT 1000 CHECK (min_interval_ms >= 1000),
  max_daily_requests integer NOT NULL DEFAULT 500 CHECK (max_daily_requests BETWEEN 1 AND 20000),
  blocked_until timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO cms_api_budget(singleton) VALUES(true);
-- Shadow table: an API answer next to the answer from loaded files for the same question.
-- Neither side is changed; this only records whether they agree.
CREATE TABLE cms_api_conflict (
  kind text NOT NULL CHECK (kind IN ('drug','provider')),
  plan_id text NOT NULL,
  identity text NOT NULL,
  plan_year integer NOT NULL,
  cms_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  cms_coverage text NOT NULL,
  authoritative_status text NOT NULL,
  authoritative_snapshot_id text,
  agrees boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, plan_id, identity, plan_year, cms_snapshot_id)
);

-- Same statement trigger as every catalog table (920_api_data_generation.sql).
INSERT INTO api_data_generation(table_name) VALUES ('cms_api_drug_coverage'), ('cms_api_provider_coverage'), ('cms_api_attempt'), ('cms_api_budget'), ('cms_api_conflict');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cms_api_drug_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cms_api_provider_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cms_api_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cms_api_budget
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cms_api_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
