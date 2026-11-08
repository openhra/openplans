-- SBE archives use the same immutable catalog tables but retain their own bundle
-- identity. Supplemental NY/VT and SHOP-only sets never move the serving pointer.
CREATE TABLE sbe_catalog (
  import_id text PRIMARY KEY REFERENCES puf_import(import_id),
  source text NOT NULL DEFAULT 'cms_sbe_puf' CHECK (source = 'cms_sbe_puf'),
  bundle_url text NOT NULL,
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  serving boolean NOT NULL
);
