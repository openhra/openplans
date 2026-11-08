-- Retain the original observation and every deterministic transformation separately.
CREATE TABLE geocode_cleanup_address (
  run_id text NOT NULL REFERENCES geocode_tx_run,
  address_hash text NOT NULL,
  retry_hash text NOT NULL,
  provenance jsonb NOT NULL,
  original_result jsonb NOT NULL,
  changed boolean NOT NULL,
  geocodable boolean NOT NULL,
  PRIMARY KEY(run_id,address_hash)
);
CREATE INDEX geocode_cleanup_retry ON geocode_cleanup_address(run_id,retry_hash);
ALTER TABLE geocode_tx_result ADD COLUMN normalization jsonb;
ALTER TABLE address_point ADD COLUMN normalization jsonb;
