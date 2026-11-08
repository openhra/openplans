-- State membership is independent of the shared, last-observed NPI identity.
-- Import snapshots already include the state and can reuse the same immutable archive.
CREATE TABLE npi_state_scope (
  npi text NOT NULL REFERENCES npi_provider(npi),
  state_filter text NOT NULL CHECK (state_filter ~ '^[A-Z]{2}$'),
  in_scope boolean NOT NULL,
  data_date date NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  PRIMARY KEY (npi,state_filter)
);
CREATE INDEX npi_state_scope_state ON npi_state_scope(state_filter,npi) WHERE in_scope;
INSERT INTO npi_state_scope(npi,state_filter,in_scope,data_date,snapshot_id)
  SELECT npi,state_filter,in_scope,data_date,snapshot_id FROM npi_provider;
