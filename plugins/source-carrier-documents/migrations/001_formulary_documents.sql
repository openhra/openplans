-- Formulary (drug list) PDFs that issuers publish, read by the carrier-document feed source.
-- One row per document per run snapshot; the core adds row provenance and the change trigger.
CREATE TABLE plg_carrierdoc_document (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  url text NOT NULL,
  url_year integer NOT NULL,
  plan_year integer,
  states text[] NOT NULL,
  pages integer NOT NULL CHECK (pages >= 0),
  legend_tiers jsonb NOT NULL,
  legend_flags jsonb NOT NULL,
  tier_histogram jsonb NOT NULL,
  confidence_counts jsonb NOT NULL,
  ql_flag_rows integer NOT NULL,
  ql_text_rows integer NOT NULL,
  cover_plan_names jsonb NOT NULL
);

-- Drug rows exactly as the extractor read them. Only `high` rows are ever served.
CREATE TABLE plg_carrierdoc_formulary_row (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  page integer NOT NULL CHECK (page >= 1),
  line integer NOT NULL CHECK (line >= 1),
  category text,
  drug_name text NOT NULL,
  name_key text NOT NULL,
  tier integer NOT NULL,
  tier_label text,
  flags jsonb NOT NULL,
  ql_text text NOT NULL,
  raw_text text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  reasons jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, page, line)
);
CREATE INDEX plg_carrierdoc_formulary_row_name ON plg_carrierdoc_formulary_row (name_key);

-- Each plan name printed on a cover, matched to the catalog of one issuer and plan year.
-- `attached` needs exactly one catalog plan with that marketing name; otherwise base_plan_id is null.
CREATE TABLE plg_carrierdoc_plan_link (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL,
  cover_name text NOT NULL,
  base_plan_id text CHECK (base_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  status text NOT NULL CHECK (status IN ('attached', 'plan_mapping_ambiguous', 'plan_not_in_catalog')),
  candidates integer NOT NULL CHECK (candidates >= 0),
  PRIMARY KEY (snapshot_id, issuer_id, cover_name),
  CHECK ((status = 'attached') = (base_plan_id IS NOT NULL))
);
CREATE INDEX plg_carrierdoc_plan_link_plan ON plg_carrierdoc_plan_link (base_plan_id, plan_year);
