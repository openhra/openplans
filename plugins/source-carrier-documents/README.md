# Carrier formulary documents source

`@openplans/source-carrier-documents` holds two feed sources. Kind `formulary-pdf` reads the
formulary (drug list) PDFs an issuer publishes on its own website, under that website's terms,
and keeps every drug row with page-level provenance. It is the command
`worker ingest carrier-formulary`. Kind `sbc-pdf` reads the issuer's Summary of Benefits and
Coverage PDFs the same way; it is `worker ingest carrier-sbc` ([SBC documents](#sbc-documents)).

List the package under `plugins` to turn it on. It needs no key. Each host it reads must be
`allowed`, with a current terms review, in your admission manifest
(`OPENPLANS_ACCESS_MANIFEST`), or the plugin does not load. Version 0.1.0 declares two hosts:
`www.christushealthplan.org` (discovery pages) and `chppayment.christushealth.org` (the PDFs).

## Prerequisites

The extractor is Python (standard library) and reads the PDF text layer with Poppler's
`pdftotext`. Run the command where both are installed, from a source checkout. The API image
has neither, and the API does not need them. The extractor and its rules are in
[`src/ingest/carrier-documents`](../../src/ingest/carrier-documents/README.md).

| Option      | Default                                                    | Meaning                                |
| ----------- | ---------------------------------------------------------- | -------------------------------------- |
| `extractor` | the checkout's `src/ingest/carrier-documents/formulary.py` | absolute path of the extractor         |
| `sbcExtractor` | the checkout's `src/ingest/carrier-documents/sbc.py`    | absolute path of the SBC extractor     |
| `python`    | `python3`                                                  | the Python executable                  |
| `pdftotext` | found on `PATH`                                            | absolute path of Poppler's `pdftotext` |
| `identityJoin` | `off`                                                   | `on` lets the RxCUI join run and joined rows answer coverage |

The extractor runs as a child process with only `PATH` in its environment.

## A run

```sh
worker ingest carrier-formulary \
  --discovery https://www.christushealthplan.org/member-resources/individual-families/pharmacy \
  --issuer TX:66252 --issuer LA:98780 --years 2026,2027
```

1. **Window.** The core checks `--years` against the data window before anything else, and
   refuses the whole run if one year falls outside it.
2. **Plan.** `plan` reads each `--discovery` page through the run's admission session, taking
   HTML links or a sitemap's `<loc>` entries. A link becomes a document when it is an https link on a declared
   host, ends in `.pdf`, and has "formulary" or "drug list" in its file name. The file name must
   carry exactly one year, and that year must be in `--years`. `plan` skips translated editions,
   marked `SPA`, `ES` or `Spanish`. A state code at the start of the file name (`TXHIX...`), or standing
   alone in the path, limits the document to the run issuers in that state. Without one, the
   document is matched against every run issuer.
3. **Fetch.** The core fetches every planned PDF through the same session: robots, terms hash,
   pacing and job caps from the manifest.
4. **Stage.** The extractor reads each PDF. The tables keep every row with its page, line, raw
   lines, confidence and reasons, plus the document's SHA-256, legend, tier histogram and the
   plan year and plan list printed on its cover.
5. **Validate.** Each document must pass the round trips below. Each document is
   admitted or refused on its own: a refused document stages nothing, its snapshot is quarantined
   with the refusal code, and an earlier reading of it keeps serving. The other documents of the
   run are activated, and `formulary_document_status` is recorded for the years they cover. The run
   fails only when every document is refused.

## Round trips (refusal codes)

| Code                        | The document                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `formulary_empty`           | has no drug rows                                                                                                                    |
| `formulary_legend_missing`  | has no tier legend                                                                                                                  |
| `formulary_tier_histogram`  | has rows on a tier that neither its legend nor its own text defines, and more than a tenth of its rows (`MAX_UNDEFINED_TIER_SHARE`) |
| `formulary_ql_round_trip`   | has more quantity-limit texts than QL flags                                                                                         |
| `document_year_unresolved`  | prints no single plan year on its cover                                                                                             |
| `document_year_outside_run` | prints a cover year that is not in `--years`                                                                                        |

The year a document applies to is the one printed on its cover, never the year in its URL.

### Rows on an undefined tier

A row whose tier is neither in the legend nor stated by the document's text is not a reason to
refuse the document by itself. `stage` keeps the row with its page, line and raw text, and marks
it `unknown_reason = tier_not_defined_in_document`. `validate` then checks the remaining rows
against the legend and refuses the document only when the undefined-tier rows are more than
`MAX_UNDEFINED_TIER_SHARE` of all its rows (one tenth, in `src/constants.ts`) or any other round
trip fails. The share is a fixed policy and is not tuned for a document. Marked rows are never
served as tier answers: `formularyDocumentEvidence` answers `unknown` with
`tier_not_defined_in_document` and the page and line where the document prints the name.

A tier missing from the legend is admitted only when the document's own text states it: a
heading, footnote or legend line that names the tier (`Tier 0`) and its cost (`$0`, `no cost`,
`zero cost`, `no charge` or `preventive`), or a tiering-table row such as
`0    $0 Preventive Drugs`. The extractor keeps the first such line in `stated_tiers` on the
document row, with its page, line and raw text. `validate` admits a stated tier only with that
evidence. A `$0 copay` note on a drug row describes that drug, not the tier, so it never defines
one.

## Plans

Covers name plans by marketing name, not plan id. `stage` compares each cover name with the active
federal catalog of each run issuer for the printed year, in two steps:

1. **Exact name.** Trailing parenthetical notes are dropped (`(2 Free PCP Visits)`), spacing and
   case are ignored, and so are the brand words every one of the issuer's catalog names starts
   with.
2. **Base name**, only for a cover name with no exact match. Trailing benefit add-ons are also
   dropped, on both sides: one of the joins `+`, `Plus`, `with`, `&` or `and`, followed by one of
   the add-ons `Dental & Vision`, `Dental and Vision`, `Dental`, `Vision` or `Fitness`
   (`ADD_ONS` and `ADD_ON_JOINS` in `src/match.ts`). "Gold + Dental & Vision + Fitness" becomes
   "Gold".

Either step attaches a name only when exactly one catalog plan matches. No other words change: a
join word alone is never dropped, so "Bronze Plus" never matches "Bronze + Dental & Vision". A
plain plan and its add-on variant share a base name, which is why the exact name is tried first.

| Link status              | Meaning                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `attached`               | exactly one catalog plan has the name                                                                                                         |
| `plan_mapping_ambiguous` | two or more catalog plans have it (by exact name, or by base name when no exact name exists), or two documents of the run claim the same plan |
| `plan_not_in_catalog`    | no catalog plan has it                                                                                                                        |

Only attached plans get document evidence. `data_availability.formulary_document_status` for
each run issuer and year becomes `available` when every catalog plan is attached, `partial`
when some are, and `unknown` otherwise.

## What is served

`formularyDocumentEvidence(db, { planId, planYear, drugName })` answers what the active
documents print for one plan, year and drug name. It is text evidence: the name as printed, the
tier number and label as the document prints them, the requirement flags, the quantity-limit
text, and the document's URL, SHA-256, page and line. It is never a coverage flag, and the tier
is never mapped onto a plan's own tier structure.

- Only `high` confidence rows are served. A name found only in `medium` or `low` rows answers
  `unknown` with `pdf_low_confidence`.
- The drug name must match a printed name exactly, ignoring case and spacing. No RxCUI is
  attached (`identity: "not_resolved"`). Joining printed names to RxCUIs is the drug identity
  stage's job, and a name is never guessed into an RxCUI.
- A name the document does not print is `unknown` (`name_not_found_in_document`), never "not
  covered". Plans without an attached document answer `formulary_document_not_available`,
  `plan_mapping_ambiguous` or `plan_not_on_document_cover`.

## RxCUI join

A printed drug name becomes an RxCUI only through the drug identity stage, and never by guessing.
The join is an ingest-time batch, `worker ingest carrier-formulary-identity [--max-lookups N]`.
It never runs while the API answers a request. It is off unless the plugin option
`identityJoin` is `on`. It also needs the RxNav identity source (`OPENPLANS_RXNAV_IDENTITY=on`).
Without it, the first lookup comes back unanswered and the run stops without recording
anything. With `identityJoin` off, the command asks nothing and writes nothing, and rows stay
text evidence.

For each `high` row on a defined tier in an active document that has no entry yet:

1. **Read the name.** `readPrintedName` splits the printed name into ingredients and salts (or
   the brand, for an all-capitals row), strengths and dose form. Only `tab`, `cap`, `chew tab`,
   `orally disintegrating tab` (generic) and `TAB`, `CAP`, `CHW` (brand) map to an RxNorm dose
   form. Extended release, injections, kits, liquids with a volume, and names without a
   strength or unit stay unresolved, with the reason (`dose_form_not_mapped`,
   `strength_missing`, ...), and no lookup is made.
2. **Search.** The `drug-name-search` kind is asked once per query: the first ingredient's
   base name, or the brand name. Every row sharing that query reuses the answer.
3. **Match.** A row matches a candidate only with the same term type (`SCD` for generic rows,
   `SBD` for brand rows), the same dose form, the same ingredients (a salt the concept names
   must be printed too), and the same strengths (masses compared in MG, `mg/ml` per mL). Exactly
   one match is needed. Zero gives `no_matching_candidate`, several give
   `several_matching_candidates`, and the order RxNav lists candidates in is never used. A
   list cut at the search's 100-candidate limit gives `candidate_list_truncated`, since a
   second match could sit past the cut.
4. **Confirm.** The `drug-identity` kind (RxNav `properties.json`) must confirm the one RxCUI,
   or the row is `rxcui_not_confirmed`.

**A loaded release wins.** When an RxNorm release is ACTIVE, the join searches and confirms
against it instead of RxNav: the release's current concepts of the row's term type whose name
contains the query, cut at the same 100 candidates, then the one RxCUI must be a current concept
of the release. Nothing is sent to RxNav and no wait is needed. Such rows carry
`identity_source: "rxnorm-release"` and the release snapshot and version as evidence.

The results go to `plg_carrierdoc_row_identity`, one entry per document row, with the query,
the matched concept name, the identity source's evidence blocks and `confirmed_at`, when the
source last confirmed the RxCUI. Entries are written per
query, so a run that stops resumes at the next query. A run stops at `--max-lookups` (default
1,000, at most 5,000), when the identity stage is unavailable (budget spent, outage) or when
the command's time limit passes. It always exits 0 when it stopped cleanly. An entry less than
30 days old is reused for the same printed name in a re-staged document without asking again;
it keeps its own `confirmed_at`.

**Monthly confirmation.** NLM asks applications that keep RxNav data to refresh it regularly, so
a resolved row answers coverage only while its RxCUI was confirmed within 35 days
(`IDENTITY_CONFIRMATION_MAX_AGE_DAYS`). Each run first confirms again every resolved RxCUI
confirmed more than 30 days ago (`IDENTITY_REFRESH_AGE_DAYS`), one lookup per RxCUI, before it
joins new rows. A row the source no longer confirms becomes `unresolved`
(`rxcui_not_confirmed`). Run the command at least monthly; a row whose confirmation aged past 35
days answers `unknown` (`identity_confirmation_stale`) until a run confirms it again.

**Budget.** RxNav allows one call per 5 seconds without a key and 5,000 calls a day, shared with
the identity questions requests ask. The join waits 5 seconds before every live lookup, so a
default run takes about 85 minutes and uses a fifth of the day's budget. In a formulary of
about 3,500 served rows, roughly half had a name the join can read, giving about 630 distinct
queries. A full join then needs about 630 searches plus one confirmation per matched RxCUI,
which is one or two nightly runs.

**Coverage.** `formularyDrugCoverage(db, { planId, planYear, rxcui, identityJoin })` answers from
joined rows of the attached documents. A `high` row on a defined tier whose entry is `resolved`
to that RxCUI answers `covered`: the document's printed tier and label, `prior_authorization`,
`step_therapy` and `quantity_limit` from the row's flags, and the quantity-limit text. Each
row is cited with the PDF URL and SHA-256, page, line, raw line and the identity source's
evidence. Rows that disagree answer `unknown` (`document_rows_conflict`) and cite every row.
Everything else is `unknown`: `identity_join_off`, `identity_unresolved` while any row of the
documents is unresolved, `name_not_found_in_document` when every row is resolved, and the plan
mapping reasons above, and `identity_confirmation_stale` when the only matching rows were
confirmed more than 35 days ago. A drug missing from a document is never "not covered".

**In drug answers.** The source registers `formularyDrugCoverage` as its `drugCoverage` hook, so
with `identityJoin` on the core uses it in `/v1/plans/{id}/drugs/{rxcui}`,
`POST /v1/drug-coverage`, quotes, the compatibility quote and the MCP `check_drug_coverage`
tool:

- The issuer's machine-readable files win. When they settle the question, the answer is theirs,
  and `passthrough_conflict` records (source `carrier-formulary-pdf`) whether the document
  agrees.
- When they leave it `unknown` for a missing, incomplete or refused source set, a `covered`
  document answer is served as `listed_covered`: `drug_tier` is the printed label (or the
  number), `tier_status` is `unresolved`, the flags come from the row, and
  `formulary_document` holds the tier, quantity-limit text and every row with its snapshot,
  PDF URL, page, line and identity evidence. In MCP each row is an evidence record citing the
  document snapshot.
- The CMS fallback runs after this, only on answers still `unknown`. A stored CMS answer for a
  question a document settled is not served; `cms_api_conflict` records the comparison.
- A document answer is local data. `x-openplans-upstream` names RxNav only when the request
  itself asked RxNav to confirm the RxCUI (no ACTIVE release).

## SBC documents

```sh
worker ingest carrier-sbc \
  --discovery https://www.christushealthplan.org/member-resources/individual-families/forms-documents \
  --issuer TX:66252 --years 2026
```

The run takes the same steps as the formulary run (window check, `plan` through the admission
session, fetch, `stage`, `validate`). Each document is admitted or refused on its own.

**Plan.** A link becomes a document when it is an https link on a declared host, ends in `.pdf`,
and its file name says `SBC` (or "summary of benefits") or carries a HIOS plan id
(`71837TX001000100.pdf`). It must not be a translated edition (`SPA`, `ES` or `Spanish` anywhere in
the path). Its path must name exactly one year, the file name's first, which must be in `--years`.
State codes in the path (`/TX_SBC/`) narrow the run issuers it is matched against.

**Extraction.** `sbc.py --feed` rebuilds the Important Questions table and the cost-sharing chart
from word coordinates and reads the coverage period and plan name from the header
([rules](../../src/ingest/carrier-documents/README.md)). Carrier spellings are accepted only from a
fixed list. The extractor drops a "(Tier n)" suffix, and keeps "Preferred generic" and "Non-preferred generic"
as sub-rows of "Generic drugs" (stored as `Generic drugs: Preferred generic`).

**Refusal codes.**

| Code | The document |
| --- | --- |
| `sbc_coverage_period_unresolved` | prints no coverage period, or one that spans two calendar years |
| `sbc_coverage_period_mismatch` | prints a coverage period whose year differs from the year its link names, or is outside `--years` |
| `sbc_chart_empty` | has no chart row with a template label |

The plan year is the printed coverage period, never the URL. A 2026 page that links a 2025 SBC
(the file path says one year, the document another) refuses that document.

**Plans.** Each admitted document is mapped to the variants of the run issuer's active catalog for
its coverage year (`plg_carrierdoc_sbc_link`):

1. **HIOS id in the file name.** If the file name carries one, it decides, and it must also be in
   the catalog. A variant id names that variant; a base id names its standard variants (`-00`,
   `-01`). An id missing from the catalog attaches nothing, and the name is not tried instead.
2. **Printed plan name**, only without a HIOS id. It must equal a variant's marketing
   name, trailing notes dropped, case and spacing ignored, and the brand words every variant
   name starts with left out. Variants of one base plan that share the name (on- and off-exchange)
   are attached together. A name that variants of two base plans share is
   `plan_mapping_ambiguous`, and none is `plan_not_in_catalog`. A variant two documents of the run
   claim is ambiguous for both.

**Cross-check.** Every row of an attached document is checked against each variant's federal values
(`plg_carrierdoc_sbc_check`): the deductible and out-of-pocket answers with the plan attributes'
in-network individual and family amounts, and the chart rows that have exactly one counterpart in
the benefits PUF (`PUF_BENEFIT` in `src/sbc-compare.ts`) with its network copay and coinsurance.
The status is `agrees`, `conflicting`, `puf_absent`, `not_compared` (the cell is not one plain cost,
such as "Office visit: $60 ... Surgery: 20%") or `no_puf_counterpart` (sub-rows, and rows such as
"Physician/surgeon fees" that the PUF splits differently).

**What is served.** `sbcCostSharingEvidence(db, { planId, planYear })` takes a variant id and
answers from the one document attached to it:

- Where the federal tables have a value, the answer keeps it. The item is `puf_value` with
  `agrees` true, or null when the SBC cell cannot be compared. When the two disagree the item is
  `conflicting` and names both values. Neither value is picked.
- Only for a variant the federal tables hold no cost sharing for at all (no benefit rows and no
  deductible or out-of-pocket amounts, as in an SBE scope without benefit files) is an SBC row
  `served`, labelled `source: "sbc_document"`, with the PDF URL, SHA-256, coverage period, printed
  plan name and page. For a plan the tables cover, the items they leave out are `unknown`
  (`puf_has_cost_sharing`).
- Only `high` rows are compared or served; others are `unknown` (`pdf_low_confidence`). A variant
  with no attached document is `unknown` (`sbc_document_not_available`,
  `plan_mapping_ambiguous` or `plan_not_mapped_to_document`).

The comparison runs again on every answer, against the tables as they are then, so a later PUF
load takes over from the SBC without a new SBC run. The evidence function is not yet wired into
the cost-sharing API responses.

## Tests

`tests/feed.test.ts` runs the feed through the core runner. It uses synthetic PDFs drawn by
`tests/ingest/carrier-documents/synthetic_pdf.py` (invented plans and values, labelled
synthetic), an invented discovery page and catalog, and an injected transport. The PDF tests
skip when `pdftotext` is not installed. Eight planted mutants must each fail a test, among them an undefined-tier row served and a document over the threshold admitted: an
ambiguous plan match attached, a base name matching two plans attached, a low-confidence row
served, a legend failure not refused, a tier the document never states admitted, and a document
outside the run's years planned.

`tests/sbc.test.ts` runs the SBC feed through the core runner on synthetic SBCs
(`synthetic_pdf.py feed-sbc`), an invented discovery page and an invented catalog with invented
cost sharing. Four planted mutants must each fail a test: a wrong-year SBC admitted, an SBC value
served where the federal tables have one, an ambiguous plan mapping attached, and a conflicting
row served.

`tests/identity.test.ts` covers the RxCUI join, monthly confirmation and the release lookup. It uses the recorded RxNav answer for
`metformin`, synthetic candidate lists and an in-memory identity stage, with no network. Six
planted mutants must each fail a test: a multi-candidate name resolved, a strength mismatch
accepted, an absent drug answered as not covered, a join run with the switch off, a stale
identity served, and RxNav used while a release is ACTIVE.

`tests/plugins/carrier-formulary-coverage.test.ts` in the core runs the answers through the API
services, quotes, MCP and the CMS fallback, and one `worker ingest carrier-formulary-identity` run
with the real RxNav source over a recorded transport (the recorded `albendazole` name search). A
planted mutant lets a document outrank the machine-readable files.
