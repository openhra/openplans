-- Keep common name terms within the current source shards at the GIN lookup.
-- Snapshot tokens cannot collide with the three-character name tokens.
DROP INDEX provider_record_name_search;
CREATE INDEX provider_record_name_search ON qhp_provider_record USING gin
 ((ARRAY['snapshot:'||snapshot_id] || provider_search_trigrams(
   coalesce(name::text,'')||' '||coalesce(facility_name,'')||' '||coalesce(group_name,''))));
-- Resolve NPPES-name matches to record keys without fetching issuer record payloads.
CREATE INDEX provider_record_identity_keys ON qhp_provider_record(npi,snapshot_id,record_id);
