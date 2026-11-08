-- Issuer source records own addresses and plan edges independently (§9.2).
CREATE TABLE provider_source_set (
 snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
 issuer_id text NOT NULL, plan_year integer NOT NULL, state text NOT NULL,
 discovery_id text, catalog_snapshot_id text REFERENCES snapshot(snapshot_id)
);
CREATE TABLE provider_shard (
 source_set_id text NOT NULL REFERENCES provider_source_set(snapshot_id),
 child_id bigint NOT NULL REFERENCES qhp_child_url(qhp_child_url_id),
 snapshot_id text NOT NULL UNIQUE REFERENCES snapshot(snapshot_id),
 raw_snapshot_id text REFERENCES snapshot(snapshot_id),
 status text NOT NULL CHECK(status IN ('complete','partial','failed')), reason text,
 record_count integer NOT NULL DEFAULT 0, edge_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(source_set_id,child_id)
);
CREATE TABLE qhp_provider_record (
 snapshot_id text NOT NULL REFERENCES provider_shard(snapshot_id),
 record_id text NOT NULL, source_record bigint NOT NULL CHECK(source_record >= 0),
 npi text CHECK(npi ~ '^[12][0-9]{9}$'),
 type text NOT NULL CHECK(type IN ('INDIVIDUAL','FACILITY','GROUP')),
 name jsonb, facility_name text, facility_type jsonb, group_name text,
 speciality jsonb, specialty jsonb, languages jsonb, accepting jsonb,
 source_updated_at text,
 PRIMARY KEY(snapshot_id,record_id), UNIQUE(snapshot_id,source_record)
);
CREATE INDEX qhp_provider_record_npi ON qhp_provider_record(npi,snapshot_id);
CREATE TABLE qhp_provider_address (
 snapshot_id text NOT NULL, record_id text NOT NULL,
 address_index integer NOT NULL CHECK(address_index >= 0),
 address text, address_2 text, city text, state text, zip text, phone text,
 raw jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,record_id,address_index),
 FOREIGN KEY(snapshot_id,record_id) REFERENCES qhp_provider_record(snapshot_id,record_id)
);
CREATE TABLE qhp_provider_plan (
 snapshot_id text NOT NULL, record_id text NOT NULL,
 source_plan_index integer NOT NULL CHECK(source_plan_index >= 0),
 base_hios_id text NOT NULL CHECK(base_hios_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
 plan_year integer NOT NULL, network_tier text NOT NULL,
 tier_status text NOT NULL CHECK(tier_status IN ('resolved','unresolved')),
 participation_scope text NOT NULL DEFAULT 'provider_record' CHECK(participation_scope='provider_record'),
 evidence_status text NOT NULL DEFAULT 'listed_participating'
 CHECK(evidence_status IN ('listed_participating','explicitly_not_participating')),
 PRIMARY KEY(snapshot_id,record_id,source_plan_index),
 FOREIGN KEY(snapshot_id,record_id) REFERENCES qhp_provider_record(snapshot_id,record_id)
);
CREATE INDEX qhp_provider_plan_lookup ON qhp_provider_plan(base_hios_id,plan_year,snapshot_id,record_id);
CREATE TABLE provider_active_set (
 issuer_id text NOT NULL, plan_year integer NOT NULL, state text NOT NULL,
 snapshot_id text NOT NULL REFERENCES provider_source_set(snapshot_id),
 PRIMARY KEY(issuer_id,plan_year,state)
);
