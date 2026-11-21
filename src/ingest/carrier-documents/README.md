# Carrier document extractors

Python (standard library only) readers for two kinds of PDFs that issuers publish: formularies
(drug lists) and Summaries of Benefits and Coverage (SBCs). They read the PDF text layer through
Poppler's `pdftotext`. Like the VT rate extraction in `src/ingest/state/prepare.py`, they are
source preparation tools: an operator installs Poppler, and the worker image does not need it.
`OPENPLANS_PDFTOTEXT` can name the executable; otherwise it is found on `PATH`.

| File | What it reads |
|---|---|
| `poppler.py` | runs `pdftotext -layout` or `-bbox-layout`, and splits pages on the form feed |
| `formulary.py` | drug name, tier and tier label, requirement flags (PA, ST, QL and so on) and quantity-limit text |
| `cover.py` | a formulary's cover: the plan year it prints and the plans it lists |
| `sbc.py` | the federal SBC template's Important Questions table and cost-sharing chart |

```sh
python3 src/ingest/carrier-documents/formulary.py drug-list.pdf
python3 src/ingest/carrier-documents/formulary.py --feed drug-list.pdf
python3 src/ingest/carrier-documents/cover.py drug-list.pdf
python3 src/ingest/carrier-documents/sbc.py summary.pdf
```

`--feed` reads its input as a PDF whatever the file is called, and adds the cover and the PDF's
SHA-256. The [carrier formulary feed](../../../plugins/source-carrier-documents/README.md) runs
it.

## Rules

- **Pages.** `pdftotext` ends every page with a form feed, and `split_pages` splits on it. Never call
  `str.splitlines()` on the whole text: it treats the form feed as a line break, and every row
  ends up on page 1.
- **Formulary rows.** A row is `name  tier  [requirements]`, with two or more spaces between
  cells. A following line whose text starts right of the name column continues the row. Text
  left of the tier column joins the name; text from the tier column on joins the requirements. A
  wrap never crosses a page break. Upper-case lines at the name column are category headings.
- **Legend.** Tiers and their labels and requirement tokens come from the document's own legend.
  Tiers: `Tier 3 - Preferred brand`, `Tier 3: Preferred brand`, or a tiering-table row
  `Tier 3    Preferred brand`. Below a "Drug Tiering" heading, a row that gives the number alone
  (`Lowest Cost-Sharing Tier    1    Preferred Generic Drugs`) also counts; those rows are legend,
  not drugs. Tokens: `PA - Prior authorization` or `PA: Prior Authorization.` A token the legend
  does not define is not a flag, even if another document uses it. A line with two or more token
  definitions is legend text even when a page number ends it.
- **Stated tiers.** A tier the legend leaves out counts only when the document's own text states
  it. The statement is a line outside the drug rows and their wraps that names the tier
  (`Tier 0`) and says what it costs (`$0`, `no cost`, `zero cost`, `no charge` or `preventive`),
  or a row below a "Drug Tiering" heading such as `0    $0 Preventive Drugs`. The first one is
  kept in `legend.stated_tiers` with its page, line and raw text, and its rows take that line as
  their tier label. A `$0 copay` note on a drug row never defines a tier.
- **Footers.** The parser skips `Page n`, `Last updated ...`, `Updated <date>` and
  `Effective <date>` lines, page number and all.
- **Cover.** `cover.py` reads the first two pages from word boxes. The plan list starts at a line
  such as "... COVERS MEMBERS WITH THE FOLLOWING PLANS:". Bullets set the columns, and a line just
  below a bulleted name continues it. The plan year is a four-digit year printed as a word of its
  own on page 1. A date such as 11/1/2026 does not count. One distinct year is the plan year;
  none or several leave it unresolved.
- **SBC columns and rows.** The chart's header words are centred in their columns, so `sbc.py`
  cuts columns at the midpoints between header centres. Rows follow the template's fixed service
  labels. Between two labels the row cut sits in the largest empty vertical gap of the value
  columns, or at the midpoint between the labels when nothing is in between.
- **SBC labels.** Besides the template's own labels, `sbc.py` accepts a short fixed list of
  carrier spellings. It drops a "(Tier n)" suffix ("Specialty drugs (Tier 5)"), even when the number
  wraps into the next column, and "Preferred generic" and "Non-preferred generic" (with or
  without "drugs") are sub-rows of "Generic drugs". Each row says which rule matched (`exact`,
  `tier_suffix`, `sub_row`). Nothing else is accepted. The chart ends on the last page with a
  template label, so the coverage examples and language notices that follow are not read as rows.
- **SBC header.** `sbc.py --feed` also reads the first page's text: the coverage period
  ("Coverage Period: 01/01/2026-12/31/2026") and the plan name printed after the issuer, with its
  parenthetical notes. The plan year is the period's year, only when the period starts and ends in
  the same year; otherwise it is null and the feed refuses the document.
- **Provenance.** Every row carries its page, its line number (formulary) or vertical band (SBC),
  and its raw lines.

## Confidence

Serve only `high` rows. Keep the others for review and serve them as `unknown`.

| Document | `low` | `medium` | `high` |
|---|---|---|---|
| Formulary | the name is a fragment (under four characters, or only digits and punctuation), or the tier is not in the legend | more than three lines merged into the row, requirement text with no legend token, an upper-case token the legend does not define, or no tier legend in the document | everything else |
| SBC chart | the label is not a template label, or the network cell is empty | the network cell is not a dollar amount, a percentage, "No charge" or "Not covered", a cell is off-centre and reaches past its label (a possible boundary bleed; the neighbouring row it reaches is flagged too), or a wrapped "(Tier n)" ended up in the value cell | everything else |

`formulary.round_trips()` lists document-level failures, such as tiers outside the legend or QL
text without a QL flag. An extraction with any failure should not be activated.

## Tests

`tests/ingest/carrier-documents/` holds the tests and a small standard-library PDF writer that
draws synthetic documents: an invented two-page, three-column drug list, the same list behind an
invented cover (`synthetic_pdf.py feed-formulary`), an invented SBC page, and an invented SBC
with the template header (`synthetic_pdf.py feed-sbc`, optionally with carrier labels or another
year's coverage period).
The tests that need `pdftotext` skip when it is not installed. Planted mutants (a wrong tier
mapping, a dropped wrapped line, a low-confidence row labelled high, a dropped legend check, a
`splitlines` page split, an undocumented tier admitted, a tier mention without a cost admitted,
an SBC value shifted one column, carrier sub-rows not accepted, a "(Tier n)" suffix not dropped,
an unflagged boundary bleed) must each fail a check.

```sh
python3 -B -m unittest discover -s tests/ingest/carrier-documents -v
```
