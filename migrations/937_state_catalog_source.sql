-- Georgia Access publishes its own PUF CSVs. A state-exchange catalog records which
-- publisher it came from; CMS SBE bundles keep their existing identity.
ALTER TABLE sbe_catalog DROP CONSTRAINT sbe_catalog_source_check;
ALTER TABLE sbe_catalog ADD CONSTRAINT sbe_catalog_source_check
  CHECK (source IN ('cms_sbe_puf', 'georgia_access_puf'));
