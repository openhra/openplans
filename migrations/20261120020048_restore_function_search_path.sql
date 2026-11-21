-- COPY evaluates CHECK constraints while pg_restore has an empty search_path.
ALTER FUNCTION public.geocode_state_extent(text) SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.geocode_in_state(fips text, s float8, n float8, w float8, e float8)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_catalog AS $$
  SELECT COALESCE((SELECT s >= x.south AND n <= x.north AND w >= x.west AND e <= x.east
    FROM public.geocode_state_extent(substring(fips,1,2)) x WHERE x.south IS NOT NULL), false)
$$;

-- This function is also evaluated during COPY when its expression index is present.
ALTER FUNCTION public.provider_search_trigrams(text) SET search_path = public, pg_catalog;
