-- Rate rows per base plan for one rate file. The import counts them in the transaction that
-- stores the file's rows, and nothing changes rate rows after that, so the counts stay exact.
-- Data availability reads these counts instead of counting millions of rate rows on every
-- read. For a rate file without a row here, availability counts `rate` as before.
CREATE TABLE rate_plan_count (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  plan_rows jsonb NOT NULL CHECK (jsonb_typeof(plan_rows) = 'object'),
  rate_rows bigint NOT NULL CHECK (rate_rows >= 0)
);
