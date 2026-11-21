-- Issuer formulary documents (PDF) read by the carrier-document feed source. Additive: a new
-- status column with a default, so existing readers and rows are unchanged.
ALTER TABLE data_availability ADD COLUMN formulary_document_status text NOT NULL DEFAULT 'not_yet_verified'
  CHECK (formulary_document_status IN ('not_yet_verified', 'available', 'partial', 'unknown', 'unavailable', 'unsupported', 'stale', 'conflicted'));
