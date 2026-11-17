CREATE TABLE plg_msot_source (
  source_id text PRIMARY KEY,
  active_version integer,
  activation_sequence integer NOT NULL DEFAULT 0
);
CREATE TABLE plg_msot_draft (
  draft_id text PRIMARY KEY,
  source_id text NOT NULL,
  version integer NOT NULL,
  version_hash text NOT NULL,
  document jsonb NOT NULL,
  artifacts jsonb NOT NULL,
  row_refs jsonb NOT NULL,
  actor text NOT NULL,
  asserted_at text NOT NULL
);
CREATE TABLE plg_msot_version (
  source_id text NOT NULL REFERENCES plg_msot_source(source_id),
  version integer NOT NULL CHECK (version > 0),
  version_hash text NOT NULL,
  metadata jsonb NOT NULL,
  artifacts jsonb NOT NULL,
  evaluator_version integer NOT NULL DEFAULT 1 CHECK (evaluator_version = 1),
  dimension_schema_version integer NOT NULL DEFAULT 1 CHECK (dimension_schema_version = 1),
  actor text NOT NULL,
  asserted_at text NOT NULL,
  PRIMARY KEY (source_id, version)
);
CREATE TABLE plg_msot_field_definition (
  source_id text NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (source_id, version, name),
  FOREIGN KEY (source_id, version) REFERENCES plg_msot_version(source_id, version)
);
CREATE TABLE plg_msot_rule (
  source_id text NOT NULL,
  version integer NOT NULL,
  rule_id text NOT NULL,
  field text NOT NULL,
  rule jsonb NOT NULL,
  PRIMARY KEY (source_id, version, rule_id),
  FOREIGN KEY (source_id, version, field) REFERENCES plg_msot_field_definition(source_id, version, name)
);
CREATE TABLE plg_msot_provenance (
  source_id text NOT NULL,
  version integer NOT NULL,
  entity_ref text NOT NULL,
  input_hash text NOT NULL,
  row_ref text NOT NULL,
  actor text NOT NULL,
  asserted_at text NOT NULL,
  credential_class text NOT NULL CHECK (credential_class = 'shell_asserted'),
  PRIMARY KEY (source_id, version, entity_ref),
  FOREIGN KEY (source_id, version) REFERENCES plg_msot_version(source_id, version)
);
CREATE TABLE plg_msot_preview (
  preview_id text PRIMARY KEY,
  source_id text NOT NULL,
  version_hash text NOT NULL,
  draft_id text NOT NULL REFERENCES plg_msot_draft(draft_id),
  catalog_generation text NOT NULL,
  expected_activation integer NOT NULL,
  input jsonb NOT NULL
);
CREATE TABLE plg_msot_activation (
  activation_id text PRIMARY KEY,
  source_id text NOT NULL,
  version integer,
  previous_version integer,
  sequence integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('activate','rollback','retire')),
  actor text NOT NULL,
  asserted_at text NOT NULL,
  UNIQUE (source_id, sequence)
);
CREATE TABLE plg_msot_audit (
  audit_id text PRIMARY KEY,
  source_id text NOT NULL,
  operation text NOT NULL,
  actor text NOT NULL,
  credential_class text NOT NULL CHECK (credential_class = 'shell_asserted'),
  asserted_at text NOT NULL,
  reason_code text NOT NULL,
  previous_hash text,
  new_hash text,
  attempt_key text NOT NULL,
  idempotency_key text NOT NULL UNIQUE
);
CREATE TABLE plg_msot_retirement (
  source_id text NOT NULL,
  version integer NOT NULL,
  actor text NOT NULL,
  asserted_at text NOT NULL,
  PRIMARY KEY (source_id, version),
  FOREIGN KEY (source_id, version) REFERENCES plg_msot_version(source_id, version)
);
