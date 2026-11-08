-- Resolve a batch of matching NPPES identities inside each current issuer shard.
-- Snapshot first keeps national name matches from walking unrelated source keys;
-- INCLUDE retains index-only record-key lookup without widening upper tree levels.
CREATE INDEX provider_record_shard_identity_keys
  ON qhp_provider_record(snapshot_id,npi) INCLUDE (record_id);
