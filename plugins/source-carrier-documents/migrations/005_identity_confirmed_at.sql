-- When the identity source (or the ACTIVE RxNorm release) last confirmed a resolved row's RxCUI.
-- A resolved row answers coverage only while this is under 35 days old; the monthly join run
-- confirms rows again before then. Unresolved rows have none. A resolved row from before this
-- column reads as confirmed when it was joined (`coalesce(confirmed_at, joined_at)`).
ALTER TABLE plg_carrierdoc_row_identity ADD COLUMN confirmed_at timestamptz;
ALTER TABLE plg_carrierdoc_row_identity ADD CONSTRAINT plg_carrierdoc_row_identity_confirmed
  CHECK (status = 'resolved' OR confirmed_at IS NULL);
