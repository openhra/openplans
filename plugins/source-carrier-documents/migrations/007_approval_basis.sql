-- The approval that admitted each document's host, copied from the fetch receipt: `owner-env:<SLUG>`
-- when the operator approved a terms-restricted host by variable, null for a host whose reviewed
-- terms allow collection. Served evidence carries it, so an answer can be traced to the approval.
ALTER TABLE plg_carrierdoc_document ADD COLUMN approval_basis text;
ALTER TABLE plg_carrierdoc_sbc_document ADD COLUMN approval_basis text;
