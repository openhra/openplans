-- The RxCUI a formulary row's printed name was joined to, one row per document row. `resolved`
-- needs exactly one RxNorm candidate with the row's ingredients (or brand), strengths and dose
-- form, confirmed by the identity source; anything else is `unresolved` with a reason. Written by
-- the ingest-time join (`worker ingest carrier-formulary-identity`), never while answering a
-- request. A row with no entry has not been joined yet. Entries outlive a re-staged document so a
-- later run can reuse them by printed name.
CREATE TABLE plg_carrierdoc_row_identity (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  page integer NOT NULL CHECK (page >= 1),
  line integer NOT NULL CHECK (line >= 1),
  name_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('resolved', 'unresolved')),
  reason text,
  query text,
  matched integer NOT NULL CHECK (matched >= 0),
  rxcui text CHECK (rxcui ~ '^[0-9]{1,10}$'),
  concept_name text,
  identity_source text,
  evidence jsonb NOT NULL,
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_id, page, line),
  CHECK ((status = 'resolved') = (rxcui IS NOT NULL AND reason IS NULL AND identity_source IS NOT NULL))
);
CREATE INDEX plg_carrierdoc_row_identity_rxcui ON plg_carrierdoc_row_identity (rxcui);
CREATE INDEX plg_carrierdoc_row_identity_name ON plg_carrierdoc_row_identity (name_key, joined_at);
