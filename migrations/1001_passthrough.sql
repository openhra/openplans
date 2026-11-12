-- Pass-through sources (plugin system core). Answers fetched at request time for questions the
-- loaded files cannot answer, for sources that bring no tables of their own. Loaded files are
-- always read first, so these rows never override them.

-- One shared allowance per source for every replica on this database.
CREATE TABLE passthrough_budget (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  next_request_at timestamptz NOT NULL DEFAULT 'epoch',
  day_start date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  daily_requests integer NOT NULL DEFAULT 0 CHECK (daily_requests >= 0),
  min_interval_ms integer NOT NULL DEFAULT 1000 CHECK (min_interval_ms >= 0),
  max_daily_requests integer NOT NULL CHECK (max_daily_requests BETWEEN 1 AND 20000),
  blocked_until timestamptz NOT NULL DEFAULT 'epoch',
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  failure_window_start timestamptz NOT NULL DEFAULT 'epoch',
  half_open boolean NOT NULL DEFAULT false
);

-- Append-only audit. Counts only: no plan ids, codes or other identifiers. `receipt_id` is the
-- snapshot id at the stored level, or the body hash at levels that keep no receipt.
CREATE TABLE passthrough_attempt (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  kind text NOT NULL,
  level text NOT NULL CHECK (level IN ('none','request','memory','stored')),
  plan_year integer,
  pairs integer NOT NULL CHECK (pairs >= 0),
  receipt_id text,
  outcome text NOT NULL CHECK (outcome IN ('absorbed','answered','empty','failed','refused')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  failure_code text,
  refusal_reason text,
  latency_ms integer CHECK (latency_ms >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Stored answers. The provenance trigger fills sourced_by, sourced_at and sourced_slug from
-- the receipt, and the foreign key ties all three to it.
CREATE TABLE passthrough_answer (
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  plan_id text NOT NULL DEFAULT '',
  identity text NOT NULL,
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 2100),
  outcome text NOT NULL CHECK (outcome IN ('answer','no_data','negative_unconfirmed')),
  negative boolean NOT NULL DEFAULT false,
  answer jsonb,
  statement text NOT NULL,
  policy_name text NOT NULL REFERENCES record_policy(name),
  snapshot_id text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  sourced_by text NOT NULL DEFAULT 'unknown' CHECK (sourced_by = source_id),
  sourced_at timestamptz,
  sourced_slug text NOT NULL DEFAULT 'unknown' CHECK (sourced_slug = snapshot_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, kind, plan_id, identity, plan_year),
  FOREIGN KEY (snapshot_id, sourced_by, sourced_at)
    REFERENCES snapshot(snapshot_id, source_id, retrieved_at)
);

-- Shadow table: a stored answer next to the answer from loaded files for the same question.
-- Neither side is changed; this only records whether they agree.
CREATE TABLE passthrough_conflict (
  source_id text NOT NULL,
  kind text NOT NULL,
  plan_id text NOT NULL,
  identity text NOT NULL,
  plan_year integer NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  source_outcome text NOT NULL,
  local_status text NOT NULL,
  agrees boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, kind, plan_id, identity, plan_year, source_snapshot_id)
);

INSERT INTO row_provenance_rule (table_name, reference_columns, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('passthrough_budget', '{}', 'openplans', 'app:passthrough-budget', 'request budget state', 'app_state'),
  ('passthrough_attempt', '{}', 'openplans', 'app:passthrough-attempt', 'pass-through call log', 'app_state'),
  ('passthrough_answer', '{snapshot_id}', NULL, NULL, 'pass-through answer receipt', 'unknown'),
  ('passthrough_conflict', '{source_snapshot_id}', NULL, NULL, 'stored answer checked against loaded files', 'app_state');

-- The record-policy trigger gives new rows the table's policy. A stored answer keeps the policy
-- its source names (a plugin migration adds that policy), so this trigger runs after it (names sort after zz_record_policy) and
-- restarts validity under that policy. Later updates already carry the source's policy.
CREATE FUNCTION passthrough_answer_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ttl interval;
BEGIN
  IF NEW.record_policy IS DISTINCT FROM NEW.policy_name THEN
    SELECT default_ttl INTO ttl FROM record_policy WHERE name = NEW.policy_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown record policy: %', NEW.policy_name; END IF;
    NEW.record_policy := NEW.policy_name;
    NEW.record_ttl := ttl;
    NEW.expired_at := coalesce(NEW.sourced_at, NEW.created_at) + ttl;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzz_passthrough_answer_policy BEFORE INSERT OR UPDATE ON passthrough_answer
  FOR EACH ROW EXECUTE FUNCTION passthrough_answer_policy();

-- Stored answers feed responses, so they bump the catalog generation like every catalog table.
-- Budget, attempt and conflict rows never change a response. The pass-through core adds the
-- generation row with its first stored answer, so installations that never store one keep
-- their current generation.
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON passthrough_answer
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
