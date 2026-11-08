-- A dependency-free GIN prefilter for literal substrings. Exact ILIKE remains the
-- authority; trigrams only discard records that cannot contain the requested word.
CREATE FUNCTION provider_search_trigrams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT ARRAY(SELECT substring(lowered FROM i FOR 3)
   FROM (SELECT lower(value) AS lowered) normalized,generate_series(1,length(lowered)-2) i)
$$;
CREATE INDEX provider_record_name_search ON qhp_provider_record USING gin
 (provider_search_trigrams(coalesce(name::text,'')||' '||coalesce(facility_name,'')||' '||coalesce(group_name,'')));
