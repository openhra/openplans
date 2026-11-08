# RxNorm Current Prescribable Content

`worker ingest rxnorm` discovers the newest dated `RxNorm_full_prescribe_MMDDYYYY.zip`
link on the [NLM files page](https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html).
The [public CPC subset](https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html)
requires no UMLS account. A login redirect, missing public link or invalid ZIP fails the
command; there is no account/authentication fallback. The licensed full release is never selected.

The shared safe fetcher caches the files page in `raw/nlm-rxnorm-files/` and the release in
`raw/nlm-rxnorm-prescribe/<sha256>/payload`, under `OPENPLANS_DATA_DIR`. Repeated acquisition
of an already cached dated URL verifies and reuses its SHA-256. The filename's release date
is `rx_release.source_version`; it is not inferred from the retrieval date. Each release
retains its snapshot, SHA-256, URL, retrieval date and local archive path in the provenance
schema. Every terminology row carries its snapshot and the original RRF line number.

The three RRF members stream directly from the ZIP, with inspected paths/expansion limits
and actual decompressed byte bounds and member CRC checks. The importer never buffers or extracts a full feed. A bounded RRF
adapter escapes literal quotes before feeding `src/ingest/csv/readRecords` with `delimiter: '|'`;
RRF quotes are data, not CSV quoting. Fixed column counts and the final pipe are mandatory.
All inserts use bounded 500-row batches. The full import is one transaction, protected by a
transaction advisory lock. Malformed data rolls back the new release and quarantines its
snapshot, leaving the previous active release usable. A successfully imported release date
and hash is a no-op on repetition; changed bytes under an already imported date are rejected.

## Stored rows and relations

- `rx_concept` preserves every SAB=RXNORM atom, its RxCUI, name, TTY and suppression flag.
  Multiple names and TTYs for the same RxCUI are intentional. Counts are atom counts, not
  distinct RxCUI counts. Other vocabularies are excluded.
- `rx_relation` stores distinct published concept edges (including their suppression flag)
  only when both endpoints have RXNORM concepts. Per NLM's
  [RRF layout](https://www.nlm.nih.gov/research/umls/rxnorm/docs/techdoc.html#s12_7),
  the semantic direction is **RXCUI2 --RELA--> RXCUI1**. Stored columns make this explicit:
  `source_rxcui --rela--> target_rxcui`. The retained reciprocal pairs are:
  `has_ingredient / ingredient_of`, `has_precise_ingredient / precise_ingredient_of`,
  `tradename_of / has_tradename`, `consists_of / constitutes`, `has_dose_form / dose_form_of`,
  `form_of / has_form`, `contains / contained_in`, and `has_part / part_of`.
  These link ingredients, precise ingredients, components, SCD/SBD, brands, packs and dose forms.
  This is a terminology graph, not clinical interchangeability or coverage evidence.
- `rx_ndc` stores distinct RxCUI/11-digit NDC/suppression mappings from RXNSAT with ATN=NDC
  and SAB=RXNORM, retaining the string exactly, including leading zeros. Non-11-digit RXNORM
  NDC values fail the import rather than being padded, truncated or guessed. Multiple RxCUIs
  may map to one NDC. Duplicate mapping/edge evidence has a representative original line.

## Helpers

`createRxnormRepository(db)` uses the most recent ACTIVE release by source date:

- `activeRelease()`: the selected snapshot ID and published release date, or null when
  terminology has not been loaded or no release is ACTIVE. An empty name search alone
  does not distinguish missing terminology from an unknown name.
- `searchDrugs(text, { includeSuppressed?, limit?, offset? })`: literal case-insensitive
  substring candidates; SCD/SBD rank first, then prefix matches, then stable name/ID ordering.
  Default page size 50, maximum 1,000. Empty text returns no candidates; SQL wildcard characters
  are literal. Each candidate includes RxCUI, name, TTY, suppression, snapshot ID and a representative original RRF line (`source_record`).
- `conceptByRxcui(rxcui)`: all published distinct names/TTYs for an exact string ID, including
  suppressed names, so callers can explicitly inspect the selected concept. No fuzzy fallback.
- `rxcuisForNdc(ndc)` and `ndcsForRxcui(rxcui)`: all active (`SUPPRESS=N`) exact mappings.
  Inputs must be strings; NDCs must already be the published 11-digit form.
- `ingredientsOf(rxcui)`: active IN/PIN/MIN candidates reachable through forward component,
  ingredient, precise-ingredient, brand-to-generic and salt-to-base links. It does not follow
  inverse edges into other products. UNION bounds cycles. Returned ingredient concepts carry
  the same snapshot ID as the source graph. Missing concepts or mappings return empty lists.

Name search proposes candidates. Select and verify an exact RxCUI before
querying coverage, as required by spec 10.1. No search result silently resolves a name, infers equivalence,
or implies formulary coverage. The absence of terminology is not a coverage determination.

## Bootstrap a shopping database

Importing the plan catalog does not load RxNorm. Run the terminology importer against
the **same database** that serves searches:

```sh
npm run build
# PostgreSQL: DATABASE_URL is supplied privately in the environment.
node dist/worker/cli.js ingest rxnorm
```

For a developer PGlite database, stop its API before making a private copy, then use
the existing API/worker runner on that copy (never on a shared reference database):

```sh
cp -R /absolute/prepared/pglite /absolute/private/pglite-with-rxnorm
OPENPLANS_PGLITE_DIR=/absolute/private/pglite-with-rxnorm node dist/api/pglite.js ingest rxnorm
# Start the API on the same copy, with its credentials supplied privately:
OPENPLANS_PGLITE_DIR=/absolute/private/pglite-with-rxnorm npm run api:pglite
```

Set `OPENPLANS_DATA_DIR` to the existing external cache in both cases. The command
checks the NLM files page and reuses a matching hash-verified cached release; it is
not a network-free command. A cache-only diagnostic can call `importRxnorm(db,
{ version, path, metadata })` directly with that dated archive's recorded metadata;
the importer verifies the file hash and byte count before writing anything. The
standalone `rxnorm/pglite.js` runner below creates its own terminology-only database;
it does not populate a separate shopping database.

After import, `/compat/v1/drugs?search_term=metformin` should have candidates and NDC
associations. Both the facade and repository use literal case-insensitive substring
search without a TTY exclusion. The facade adds `rxnorm_terminology_unavailable` when
there is no ACTIVE release. A loaded terminology with an unmatched name returns an
empty result without that gap.

## Package evidence

The facade's package IDs come only from current `RXNSAT.RRF` attributes with
`ATN=NDC`, `SAB=RXNORM`, `SUPPRESS=N`, joined by the exact RxCUI in the active
release. Formatting the published 11-digit string as 5-4-2 preserves leading zeros;
it does not recover an original 10-digit labeler/product segmentation.

These NDC attributes contain identifiers, not package/container descriptions.
`RXNCONSO` clinical names are not container descriptions either: NLM explains this
distinction in its [technical documentation, section 1](https://www.nlm.nih.gov/research/umls/rxnorm/docs/techdoc.html).
Even a GPCK/BPCK name describes a clinical pack, not the bottle/carton presentation
of each associated NDC. Package `description` and `med_id` therefore remain null,
with `ndc_package_descriptions_and_med_ids_unavailable`. No clinical name is passed
off as a container quantity and no other vocabulary's identifiers are copied.
An FDA package-directory adapter could supply descriptions later; it is not part
of this RxNorm import.

## Offline checks and real run

Offline tests use a real CPC cut in `tests/fixtures/rxnorm/`, with archive SHA-256 and release
version in `provenance.json`. Regenerate after acquiring the public release:

```sh
npm run build
node --input-type=module -e 'import {acquireRelease} from "./dist/ingest/rxnorm/acquire.js"; console.log(JSON.stringify(await acquireRelease()))' > "$OPENPLANS_DATA_DIR/rxnorm-acquired.json"
python3 tests/fixtures/rxnorm/regenerate.py "$OPENPLANS_DATA_DIR/rxnorm-acquired.json"
```

No real downloads belong in the repository. The suppression test modifies a real fixture
concept in its isolated test database: CPC itself has no suppressed RXNORM atoms. Other
negative controls deliberately corrupt ZIP member bytes, coerce NDCs to numbers and remove `tradename_of`, then assert
that the corresponding invariants fail. The importer must quarantine a malformed later release without
replacing the prior terminology.

With dev dependencies installed, run the full public release in a persistent PGlite database:

```sh
npm run build
node dist/ingest/rxnorm/pglite.js
```

The developer runner uses `OPENPLANS_DATA_DIR/rxnorm-pglite-p2a`, omits only PostGIS from a
temporary migration copy, imports the full release, repeats it to prove the no-op, and writes
`reports/p2a-rxnorm-realdata.json`. Production `worker` migrations never skip PostGIS.
Set `OPENPLANS_REFERENCE_CAPTURES_DIR` to an external fixture directory for the optional comparison of
metformin, lisinopril and Lipitor against `drugs/*.json` `meta.total`.
RxNorm counts are distinct name/TTY candidates (also reported as distinct RxCUIs); the oracle
counts NDC products and was captured on a different date. They are not expected to be equal.
