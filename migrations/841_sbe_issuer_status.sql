CREATE TABLE sbe_issuer_status (
  import_id text NOT NULL REFERENCES sbe_catalog(import_id),
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  drug_status text NOT NULL DEFAULT 'unknown' CHECK (drug_status = 'unknown'),
  provider_status text NOT NULL DEFAULT 'unknown' CHECK (provider_status = 'unknown'),
  reason text NOT NULL DEFAULT 'sbe_no_index_registry' CHECK (reason = 'sbe_no_index_registry'),
  PRIMARY KEY (import_id, issuer_id)
);
