-- Unreadable indexes and absent kinds make no assertion of negative coverage.
ALTER TABLE qhp_coverage_manifest DROP CONSTRAINT qhp_coverage_manifest_status_check;
ALTER TABLE qhp_coverage_manifest ADD CONSTRAINT qhp_coverage_manifest_status_check
  CHECK (status IN ('complete','partial','failed','access_denied','unknown'));
