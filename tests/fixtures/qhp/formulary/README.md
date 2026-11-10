# Synthetic formulary fixtures

Everything here is synthetic. `../generate-issuer.mjs` writes these files; they describe no
real issuer, plan or drug listing.

- Issuer `00010` and the other issuers (`00011` to `00014`) are invented. No HIOS issuer ID
  starts with `000`.
- RxCUIs are in the `9900001xx` to `9900004xx` range, far above any assigned concept. Drug and
  concept names start with "synthetic".
- `catalog.json` is a synthetic plan catalog in the shape the PUF importer stores.

The data keeps the edge cases the tests rely on: each TX association appears twice, some
associations point at plans in other states, four defined plans are missing from the
catalog, six catalog plans have no listing, and three plans declare `GENERIC` twice and no
`PREFERRED-GENERIC`.

Regenerate with `node tests/fixtures/qhp/generate-issuer.mjs`. Don't edit these files by hand.
