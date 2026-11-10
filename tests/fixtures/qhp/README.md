# QHP fixtures

`provenance.json` in each directory lists every data file with its SHA-256 and says whether
it is synthetic. `scripts/check-fixture-lineage.mjs` and `tests/fixture-lineage.test.ts`
fail when a file is missing from that list, its hash changed, or it is neither synthetic nor
a copy from a public CMS download.

- `synthetic.xlsx.hex` and `dishonest-size.zip.hex` are synthetic, written by `generate.mjs`.
- `tx-2026-registry.xlsx.hex` is a column cut of the CMS machine-readable URL PUF; see
  `tx-2026-registry.provenance.json`.
- `formulary/` and `provider/` are synthetic, written by `generate-issuer.mjs`.
