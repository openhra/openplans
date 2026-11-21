-- Tiers a document's legend leaves out but its own text states (a heading, footnote or
-- tiering-table line naming the tier and its cost), each with the page, line and raw line that
-- states it. `validate` admits a row tier only when the legend defines it or this holds it.
ALTER TABLE plg_carrierdoc_document ADD COLUMN stated_tiers jsonb NOT NULL DEFAULT '{}'::jsonb;
