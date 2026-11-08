-- Plan the generated, parameterized search with JIT disabled only inside this call.
-- STABLE uses the caller's read snapshot; invoker rights add no database privileges.
CREATE FUNCTION provider_search_query(search_sql text,search_plan text,search_year integer,
  search_taxonomy text,search_specialty text,search_name text,search_type text,
  search_latitude double precision,search_longitude double precision,search_radius numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET jit=off AS $$
DECLARE result jsonb;
BEGIN
  EXECUTE 'SELECT to_jsonb(provider_result) FROM ('||search_sql||') provider_result'
    INTO result USING search_plan,search_year,search_taxonomy,search_specialty,search_name,search_type,
      search_latitude,search_longitude,search_radius;
  RETURN result;
END $$;
