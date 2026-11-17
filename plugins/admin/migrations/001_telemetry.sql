CREATE TABLE plg_admin_telemetry (
  boot_id uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  granularity text NOT NULL CHECK (granularity IN ('5m','1h')),
  transport text NOT NULL CHECK (transport IN ('http','mcp')),
  operation varchar(120) NOT NULL CHECK (operation ~ '^[a-zA-Z0-9_.:-]{1,120}$'),
  owner varchar(120) NOT NULL CHECK (owner ~ '^(core|@[a-z0-9._-]+/[a-z0-9._-]+)$'),
  outcome text NOT NULL CHECK (outcome IN ('completed','cancelled','timeout')),
  status_class text NOT NULL CHECK (status_class IN ('2xx','3xx','4xx','429','5xx')),
  sample_count bigint NOT NULL CHECK (sample_count BETWEEN 0 AND 9007199254740991),
  duration_buckets bigint[] NOT NULL CHECK (
    cardinality(duration_buckets)=12 AND array_ndims(duration_buckets)=1
    AND array_lower(duration_buckets,1)=1 AND array_position(duration_buckets,NULL) IS NULL
    AND 0 <= ALL(duration_buckets)
    AND sample_count = duration_buckets[1]+duration_buckets[2]+duration_buckets[3]+duration_buckets[4]+duration_buckets[5]+duration_buckets[6]+duration_buckets[7]+duration_buckets[8]+duration_buckets[9]+duration_buckets[10]+duration_buckets[11]+duration_buckets[12]
  ),
  last_flush_at timestamptz NOT NULL,
  drops bigint NOT NULL CHECK (drops BETWEEN 0 AND 9007199254740991),
  flush_gap boolean NOT NULL,
  PRIMARY KEY (boot_id,bucket_start,granularity,transport,operation,owner,outcome,status_class)
);
CREATE INDEX plg_admin_telemetry_time ON plg_admin_telemetry(bucket_start);
