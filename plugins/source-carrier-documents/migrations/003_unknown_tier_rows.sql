-- A row whose tier the document never defines (not in its legend, not stated by its text) is kept
-- with its page and raw text but marked here; it is never served as a tier answer.
ALTER TABLE plg_carrierdoc_formulary_row ADD COLUMN unknown_reason text;
