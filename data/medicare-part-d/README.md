# Medicare Part D rule documents and annual parameters

This folder pins the CMS documents behind the Part D drug-cost rules and records the defined
standard benefit figures for contract years 2026 and 2027. The documents stay out of the
repository. The fetcher in `src/fetch` downloads them under a reviewed admission into the data
directory (`raw/cms-partd-rules/<sha256>/payload`).

## Files

- `documents.json` pins each document by URL, SHA-256, size and retrieval date (2026-11-11).
  Document ids C1 to C12 are the keys that citations use.
- `parameters.json` holds the five defined standard figures for 2026 and 2027. Each one has a
  value and at least one citation giving the document, section, PDF page and the quoted text.
  Money is in integer cents. Cost sharing is in basis points, so 2500 means 25%.
- `pbp-documents.json` pins the 2026 and 2027 Plan Benefit Package archives (C13, C14) in the
  same format, with the data dictionary workbook inside each one pinned by hash, size and sheet.
- `cost-bounds.json` holds what the cost engine needs to read the minimum and maximum
  cost-sharing cells of the Beneficiary Cost file. It cites dictionary rows for the cost-share
  structures (3 "Greater of", 4 "Lesser of") and the "Defined Standard" benefit type, the SNP
  field of the plan file, and the low-income subsidy copays in Table V-2 of C5 (PDF page 95).
  The rules themselves are in `src/domain/medicare/part-d-cost/bounds.ts`.
- `drug-classes.json` says where the cost engine gets its plan and drug facts. The PBP field
  `pbp_mrx.mrx_benefit_type` gives the benefit type, decoded with the dictionary rows it cites
  (C13, C14). The formulary flag `SELECTED_DRUG_YN` (C1, C2) says whether a drug is a selected
  drug. No cached file lists covered insulin products, ACIP-recommended adult vaccines or
  applicable drugs under the discount program. The file records a reason for each of these, and
  the engine reports a fact without a source as unknown. The rules are in
  `src/domain/medicare/part-d-cost/classification.ts`.
- `drug-lists.json` pins the CMS drug lists (C15 to C24, cache source `cms-partd-druglists`) and
  holds the selected-drug NDC-11s for 2026 and 2027, built from the CMS selected drug list file
  (C16). An NDC is on a year's list when its rows cover the whole year, from the maximum fair
  price effective date to the end date. A row that ends before it starts records a deselection
  and never applies. Each entry keeps the data rows it rests on. The engine matches on the NDC
  only and checks the list against the formulary flag. `maximumFairPrices` holds, for each year,
  every row of the same file in effect on some day of that year: the NDC-11, the effective and
  end dates and the price per unit. A deselection row never applies. The price path uses a period
  only when the fill date falls inside it. When one of them is silent the other
  settles the program, and when they disagree the program stays open. The CMS fact sheets (C17,
  C18) name the selected drugs without an NDC, so the file keeps them as name-only lists with the reason
  `name_only_list_needs_rxnorm` and never matched. The discount program labeler code and phase-in
  lists (C20 to C22) are pinned but settle nothing. A labeler code names a company. It does not say
  whether FDA approved a product under an NDA or BLA. CMS publishes no covered insulin product list on the
  pages checked (C15, C19, C24).
- `../../tests/fixtures/medicare-costs/oracles.json` repeats the Table V-2 cells by hand and lists
  CMS worked claim examples with their expected figures. The checker compares the parameters with
  those cells, so swapping the 2026 and 2027 values fails.

| Figure | 2026 | 2027 | Source |
|---|---:|---:|---|
| Standard deductible | $615 | $700 | C5, Attachment V, Table V-2 (PDF page 95) |
| Annual out-of-pocket threshold | $2,100 | $2,400 | C5, same table; C4 section 20 for 2026 |
| Cost sharing in the deductible | 100% | 100% | C4 section 20; C10 Table III-6, kept by C5 |
| Cost sharing in initial coverage | 25% | 25% | Same sections |
| Cost sharing in the catastrophic phase | 0% | 0% | C4 section 20; C9, IRA provisions section |

These are the defined standard figures for someone without the low-income subsidy. A plan's own
deductible and cost sharing come from the plan files and take precedence for what that plan
charges. Any other year has no figures here. Nothing extrapolates one from an inflation formula.

## Checking

```sh
node scripts/medicare-costs/check.mjs                                   # offline checks
node scripts/medicare-costs/check.mjs --data-dir "$OPENPLANS_DATA_DIR"  # also rehash the cache
node scripts/medicare-costs/drug-lists.mjs --data-dir "$OPENPLANS_DATA_DIR"  # drug lists
npx vitest run tests/fixtures/medicare-costs tests/domain/medicare-cost-drug-lists.test.ts
```

`drug-lists.mjs --data-dir` also rebuilds the NDC lists from the cached file and fails if they
differ from the committed ones. Add `--write` to rewrite them, then run Prettier on the file.

The offline run checks the pin format, the year set, every citation and the table cells. A
citation of a PBP archive must name a pinned member, its sheet and a row, and must cite the
archive for the same year. With
`--data-dir` it also rehashes each cached document, compares its size, and confirms the cache
metadata names the pinned URL and carries an admission receipt. It also rehashes the pinned
dictionary members inside the PBP archives. A changed byte fails. The tests
cover these failures with synthetic bytes, and verify the real cache when `OPENPLANS_DATA_DIR`
contains it.

## Updating

Fetch a new or revised document only through `src/fetch` under a current admission review. Add a
new pin rather than editing the hash of an old one, then cite the new id. CMS sometimes leaves an
older year in a PDF's title property. Go by the file name, the contents and the release date.
