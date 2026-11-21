# RxNav drug identity source

`@openplans/source-rxnav-identity` is the pass-through source `rxnav`. It checks whether an
RxCUI is a current, unsuppressed RxNorm concept by asking the public RxNorm API at
`rxnav.nlm.nih.gov`, and it suggests concepts for a drug name. It answers identity only, never
coverage, tier or cost.

The core plugin registers it while `OPENPLANS_RXNAV_IDENTITY=on`. The switch is off by default,
and the source needs no entry under `plugins` and no key.

## When it is asked

Only when a drug question names an RxCUI that is not in a local RxNorm release and no release is
ACTIVE. A loaded release always wins, and then RxNav is never asked. Each lookup covers one
RxCUI:

1. `/REST/rxcui/{rxcui}/properties.json`. A concept with properties and suppress flag `N` is
   confirmed. A suppressed concept is not.
2. `/REST/rxcui/{rxcui}/historystatus.json`, only for an RxCUI without current properties. It
   never confirms. Its status (`Remapped`, `Obsolete` and so on) goes into the answer's
   provenance.

An RxCUI that is no concept may come back as a 200 with `{}` or as a 404, from either path. Both
mean "not confirmed", so the drug question stays `rxcui_not_in_rxnorm`.

A confirmed RxCUI moves the drug question past the identity check, so it can reach the
coverage sources. A coverage source can also accept the confirmation for a negative. The CMS
Marketplace API source does this: its `NotCovered` becomes `covered: false` with
`cms_api.identity_source: "rxnav"`. A confirmation counts only for the request that made it.
Anything else leaves the answer `unknown`: `rxcui_not_in_rxnorm` when RxNav did not confirm
the RxCUI, `rxnorm_terminology_unavailable` when RxNav could not be asked.

A drug answer whose RxCUI RxNav confirmed carries RxNav's evidence block as `rxnorm_identity`,
with NLM's statement in `source` and the terms URL in `terms_url`, whatever the coverage step
finds. MCP drug coverage results carry the same object.

A request with `passthrough=off` asks RxNav nothing, and the RxCUI stays
`rxcui_not_in_rxnorm`. When RxNav was asked, `rxnav` is named in the `x-openplans-upstream`
response header, also when the call failed. The response cache keys entries by the switch, so
turning it on or off never serves an answer cached under the other setting.

## Name search

Kind `drug-name-search`. When a drug name search finds no RxNorm release ACTIVE, the host asks
`/REST/drugs.json?name=<name>` with the name in lower case and with single spaces. The source
takes names of 2 to 100 letters, digits, spaces and common punctuation, and nothing else. The source
keeps every current, unsuppressed concept in RxNav's order, at most 100, as `rxcui`, `name` and
`tty`. The core builds the answer itself: `terminology_status: "passthrough"`, the candidates and
the `rxnav` evidence block. The host puts the block in `terminology_evidence`.

Candidates are suggestions for picking an exact RxCUI. They never confirm an RxCUI and never
answer coverage, and `exact_concept_required` stays `true`. A name with no current concept is
cached for 1 hour, a list for 24 hours. A search shares the source's switch, budget, pacing and
per-request call with the identity lookups. `passthrough=off` asks nothing, and a search that
asked RxNav names `rxnav` in `x-openplans-upstream`.

## Cache, budget and terms

- Cache level `memory`: a confirmation is kept for 24 hours, anything else for 1 hour, at most
  100,000 entries. Nothing reaches the database or backups. An operator can make the level
  stricter but not looser.
- At most one call every 5 seconds, which is the fetcher's floor for a host without a key, and
  5,000 calls a day. A call is one or two lookups. NLM publishes a limit of 20 requests per
  second per IP address. One RxCUI is checked per inbound request; questions that miss the
  budget stay `unknown`.
- The shipped manifest entry `rxnav.nlm.nih.gov` in `data/access/federal-publishers.json`
  permits `/REST/rxcui/`, `/REST/drugs.json` and `/REST/version.json`. The host answers
  `robots.txt` with a direct 404. The terms page,
  <https://www.lhncbc.nlm.nih.gov/RxNav/TermsofService.html>, is read and its hash checked
  before the first call and daily after that; if the page changes, calls stop until the entry
  is reviewed again.
- The evidence block, `rxnav`, carries the statement NLM asks applications to include:

  > This product uses publicly available data from the U.S. National Library of Medicine
  > (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not
  > responsible for the product and does not endorse or recommend this or any other product.

## Tests

`tests/fixtures/rxnav/` holds public RxNorm API responses for RxCUI 860975 and for the
name `metformin`, labelled `recorded`, with their URLs, hashes and retrieval times. `record.mjs` there re-records them by
hand. `synthetic-unknown-rxcui.json` holds hand-written responses for an RxCUI that is no
concept (`{}` and 404), labelled `synthetic`. Tests never use the network.
