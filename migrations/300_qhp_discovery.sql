-- Discovery records never imply complete or active drug/provider coverage.
CREATE TABLE qhp_index (
  qhp_index_id text PRIMARY KEY,
  discovery_id text NOT NULL,
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2014 AND 2100),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  registry_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  registry_row integer NOT NULL CHECK (registry_row > 0),
  url text,
  snapshot_id text REFERENCES snapshot(snapshot_id),
  status text NOT NULL,
  http_status integer,
  puf_hosts jsonb NOT NULL DEFAULT '[]',
  child_hosts jsonb NOT NULL DEFAULT '[]',
  publisher_metadata jsonb NOT NULL DEFAULT '{}',
  discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qhp_index_issuer_year ON qhp_index(issuer_id,plan_year,state,discovered_at);
CREATE INDEX qhp_index_discovery ON qhp_index(discovery_id);

CREATE TABLE qhp_child_url (
  qhp_child_url_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qhp_index_id text NOT NULL REFERENCES qhp_index(qhp_index_id),
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]{5}$'),
  plan_year integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('plan_urls','provider_urls','formulary_urls')),
  url text NOT NULL,
  published_url text NOT NULL,
  url_sha256 text NOT NULL CHECK (url_sha256 ~ '^[a-f0-9]{64}$'),
  host text,
  host_evidence text NOT NULL CHECK (host_evidence = 'index_child'),
  index_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  snapshot_id text REFERENCES snapshot(snapshot_id),
  status text NOT NULL,
  http_status integer,
  publisher_metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(qhp_index_id,kind,url_sha256)
);
CREATE INDEX qhp_child_url_issuer_kind ON qhp_child_url(issuer_id,plan_year,kind);
