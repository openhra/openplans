-- Literal name candidates only; the full ILIKE and plan participation predicates
-- remain authoritative. The same SQL is correct without this optional index.
CREATE INDEX provider_identity_name_search ON npi_provider USING gin
  (provider_search_trigrams(coalesce(organization_name,'')||' '||coalesce(first_name,'')||' '||coalesce(last_name,'')));
