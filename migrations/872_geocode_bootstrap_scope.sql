-- A completed bootstrap can reuse its input census while immutable source pointers are current.
ALTER TABLE geocode_tx_run ADD COLUMN scope_signature text
  CHECK (scope_signature IS NULL OR scope_signature ~ '^[a-f0-9]{64}$');
