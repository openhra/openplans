-- Search keys for NPPES identity radius searches, rebuilt by `worker backfill provider-search`
-- after the provider tables change. One row per located practice point of an identity, with the
-- identity's search fields, ordered by a 0.1-degree grid cell, so a radius search reads one
-- compact area instead of identities and points spread across every loaded state. Practice
-- addresses without a current point are rows with a null cell; they give exact unlocated counts.
-- Two slots: the worker fills the idle one, then points provider_search_build at it.
-- Readers use a slot only while its recorded source revisions equal the current ones.
CREATE TABLE provider_search_key_a (
  cell integer,
  npi text NOT NULL,
  latitude double precision,
  longitude double precision,
  in_scope boolean NOT NULL,
  entity_type text,
  search_name text NOT NULL,
  taxonomy_codes text[] NOT NULL,
  CHECK ((cell IS NULL) = (latitude IS NULL) AND (cell IS NULL) = (longitude IS NULL))
);
CREATE TABLE provider_search_key_b (LIKE provider_search_key_a INCLUDING CONSTRAINTS);

CREATE TABLE provider_search_build (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  slot text NOT NULL CHECK (slot IN ('a','b')),
  source_revisions text NOT NULL,
  located_rows bigint NOT NULL,
  unlocated_rows bigint NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO row_provenance_rule (table_name, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('provider_search_key_a', 'openplans', 'derived:provider-search-key', 'search keys derived from NPPES identities and points', 'app_state'),
  ('provider_search_key_b', 'openplans', 'derived:provider-search-key', 'search keys derived from NPPES identities and points', 'app_state'),
  ('provider_search_build', 'openplans', 'derived:provider-search-key', 'which search key slot is current', 'app_state');

-- No catalog-generation trigger: the keys never change an answer. An answer whose unlocated count
-- is unknown is not stored by the response cache, so a later build is seen at once.
