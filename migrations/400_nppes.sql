-- NPPES identity/location enrichment only. No plan or network membership is inferred.
CREATE TABLE npi_import_run (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  kind text NOT NULL CHECK (kind IN ('full','weekly','deactivation')),
  state_filter text NOT NULL CHECK (state_filter ~ '^[A-Z]{2}$'),
  data_date date NOT NULL,
  report jsonb NOT NULL
);
CREATE TABLE npi_provider (
  npi text PRIMARY KEY CHECK (npi ~ '^[12][0-9]{9}$'),
  entity_type text CHECK (entity_type IN ('1','2')),
  first_name text, middle_name text, last_name text, name_prefix text, name_suffix text,
  credential text, organization_name text,
  enumeration_date date, last_update_date date,
  deactivation_date date, reactivation_date date,
  deactivated boolean NOT NULL DEFAULT false,
  sole_proprietor boolean,
  in_scope boolean NOT NULL,
  state_filter text NOT NULL,
  data_date date NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  status_snapshot_id text REFERENCES snapshot(snapshot_id)
);
CREATE TABLE npi_taxonomy (
  npi text NOT NULL REFERENCES npi_provider(npi),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 15),
  code text NOT NULL,
  is_primary boolean,
  license_state text,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  PRIMARY KEY (npi,ordinal)
);
CREATE INDEX npi_taxonomy_code ON npi_taxonomy(code,npi);
CREATE TABLE npi_address (
  npi text NOT NULL REFERENCES npi_provider(npi),
  kind text NOT NULL CHECK (kind IN ('mailing','practice')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  line_1 text, line_2 text, city text, state text, postal_code text, country text,
  zip5 text CHECK (zip5 ~ '^[0-9]{5}$'),
  zip4 text CHECK (zip4 ~ '^[0-9]{4}$'),
  phone text, phone_extension text,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  PRIMARY KEY (npi,kind,ordinal)
);
CREATE INDEX npi_address_zip ON npi_address(zip5,npi) WHERE kind='practice';
CREATE TABLE npi_deactivation (
  npi text PRIMARY KEY,
  deactivation_date date NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);
