-- One row of local state for the opt-in usage report: the install id, the version seen at the
-- previous start, and the last send. Nothing is written here while the report is off.
CREATE TABLE usage_report_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  install_id uuid,
  version text NOT NULL,
  previous_version text,
  last_sent_day date,
  last_status integer
);
INSERT INTO row_provenance_rule (table_name, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('usage_report_state', 'openplans', 'app:usage_report_state', 'application usage report state', 'app_state');
