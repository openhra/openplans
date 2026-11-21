-- Summary of Benefits and Coverage (SBC) PDFs that issuers publish, read by the `sbc-pdf` feed.
-- One row per admitted document per run snapshot; the core adds row provenance and the change trigger.
CREATE TABLE plg_carrierdoc_sbc_document (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  url text NOT NULL,
  url_year integer NOT NULL,
  -- The year of the coverage period printed in the document; it must equal url_year.
  plan_year integer NOT NULL,
  coverage_start date NOT NULL,
  coverage_end date NOT NULL,
  printed_plan_name text,
  file_hios_ids jsonb NOT NULL,
  states text[] NOT NULL,
  pages integer NOT NULL CHECK (pages >= 0),
  confidence_counts jsonb NOT NULL,
  missing_services jsonb NOT NULL
);

-- Chart rows and Important Questions answers exactly as the extractor read them.
-- `item` is the template label (with the carrier's sub-row label) or the question.
CREATE TABLE plg_carrierdoc_sbc_row (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  section text NOT NULL CHECK (section IN ('question', 'chart')),
  item text NOT NULL,
  label text,
  sub_label text,
  label_match text,
  label_text text NOT NULL,
  page integer NOT NULL CHECK (page >= 1),
  event text,
  network text NOT NULL,
  out_of_network text,
  limitations text,
  raw_text text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  reasons jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
);

-- Each document matched to the plan variants of one issuer's active catalog for its coverage year.
-- `attached` rows name one variant each; other statuses keep variant_plan_id null.
CREATE TABLE plg_carrierdoc_sbc_link (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL,
  method text NOT NULL CHECK (method IN ('hios_file_name', 'marketing_name', 'none')),
  status text NOT NULL CHECK (status IN ('attached', 'plan_mapping_ambiguous', 'plan_not_in_catalog')),
  variant_plan_id text CHECK (variant_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}-[0-9]{2}$'),
  candidates integer NOT NULL CHECK (candidates >= 0),
  CHECK ((status = 'attached') = (variant_plan_id IS NOT NULL))
);
CREATE UNIQUE INDEX plg_carrierdoc_sbc_link_key
  ON plg_carrierdoc_sbc_link (snapshot_id, issuer_id, coalesce(variant_plan_id, ''));
CREATE INDEX plg_carrierdoc_sbc_link_plan ON plg_carrierdoc_sbc_link (variant_plan_id, plan_year);

-- The cross-check of each attached document row against the federal cost-sharing tables at stage
-- time: agrees, conflicting, puf_absent, not_compared or no_puf_counterpart. Kept for review; the
-- answer itself compares against the tables as they are when asked.
CREATE TABLE plg_carrierdoc_sbc_check (
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  variant_plan_id text NOT NULL CHECK (variant_plan_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}-[0-9]{2}$'),
  ordinal integer NOT NULL,
  item text NOT NULL,
  status text NOT NULL CHECK (status IN ('agrees', 'conflicting', 'puf_absent', 'not_compared', 'no_puf_counterpart')),
  puf_benefit text,
  puf_value text,
  sbc_value text NOT NULL,
  PRIMARY KEY (snapshot_id, variant_plan_id, ordinal)
);
