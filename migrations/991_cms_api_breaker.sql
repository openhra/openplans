-- Failure counter for the CMS Marketplace API fallback. Three server-side failures within five
-- minutes pause calls for fifteen. Then a single trial call decides whether they resume.
ALTER TABLE cms_api_budget
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  ADD COLUMN failure_window_start timestamptz NOT NULL DEFAULT 'epoch',
  ADD COLUMN half_open boolean NOT NULL DEFAULT false;
