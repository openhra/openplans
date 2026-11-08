CREATE TABLE source (
  source_id text PRIMARY KEY,
  publisher text NOT NULL,
  issuer_scope jsonb NOT NULL DEFAULT '[]',
  source_kind text NOT NULL,
  registry_evidence jsonb NOT NULL DEFAULT '[]',
  authorization_class text NOT NULL DEFAULT 'public',
  terms_review_reference text,
  approved_destinations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE snapshot (
  snapshot_id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES source(source_id),
  requested_url text,
  final_url text,
  redirect_chain jsonb NOT NULL DEFAULT '[]',
  authorization_class text NOT NULL DEFAULT 'public',
  retrieved_at timestamptz,
  publisher_updated_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  etag text,
  last_modified text,
  content_type text,
  compressed_bytes bigint CHECK (compressed_bytes >= 0),
  uncompressed_bytes bigint CHECK (uncompressed_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw_path text,
  schema_version text,
  parser_version text,
  terms_review_reference text,
  expected_children integer CHECK (expected_children >= 0),
  fetched_children integer NOT NULL DEFAULT 0 CHECK (fetched_children >= 0),
  validation_state text NOT NULL DEFAULT 'DISCOVERED' CHECK (validation_state IN (
    'DISCOVERED', 'FETCHING', 'PARSED', 'VALIDATED', 'RECONCILED', 'ACTIVE', 'QUARANTINED'
  )),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expected_children IS NULL OR fetched_children <= expected_children),
  CHECK (validation_state <> 'ACTIVE' OR (
    expected_children IS NOT NULL AND expected_children = fetched_children
    AND sha256 IS NOT NULL AND retrieved_at IS NOT NULL AND activated_at IS NOT NULL
  ))
);
CREATE INDEX snapshot_source_state ON snapshot(source_id, validation_state);

CREATE TABLE quality_issue (
  quality_issue_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text REFERENCES source(source_id),
  snapshot_id text REFERENCES snapshot(snapshot_id),
  source_record text,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  issue_code text NOT NULL,
  explanation text NOT NULL,
  resolution_status text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (source_id IS NOT NULL OR snapshot_id IS NOT NULL)
);
CREATE INDEX quality_issue_snapshot_severity_code ON quality_issue(snapshot_id, severity, issue_code);
