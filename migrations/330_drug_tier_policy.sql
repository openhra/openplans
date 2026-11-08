-- Existing edges predate explicit tier validation state; never infer a mapping for them.
ALTER TABLE formulary_edge ADD COLUMN tier_status text NOT NULL DEFAULT 'unresolved'
  CHECK (tier_status IN ('resolved','unresolved'));
