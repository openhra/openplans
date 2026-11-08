# NUCC provider taxonomy

NUCC display names are **off by default**. `worker bootstrap --with-providers` and
`--with-geocode` retain NPPES taxonomy codes and issuer participation without acquiring or
importing the NUCC dataset. Dry-run reports the taxonomy step as `status: skipped` with
`reason: opt_in_required`. No environment variable enables this import.

Review the [NUCC terms page](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57)
and obtain any licence required for your use before opting in. NUCC says commercial use,
including selling or licensing products using the code set, needs a NUCC licence. The software
licence does not grant rights to this dataset, and passing a flag does not obtain a licence.

Add `--with-nucc-taxonomy` to bootstrap to accept responsibility for satisfying those terms
and enable the import. It can be used alone or alongside `--with-providers`:

```sh
worker bootstrap --states TX --years 2026 --with-providers --with-nucc-taxonomy
worker ingest taxonomy --accept-nucc-terms
```

`worker ingest taxonomy --accept-nucc-terms` fetches the current Health Care Provider Taxonomy CSV linked from the
[NUCC CSV page](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57)
and stores it under `OPENPLANS_DATA_DIR/raw/nucc-provider-taxonomy/` through `fetchToCache`.
The importer records the NUCC version and source snapshot. After import, provider responses include the NUCC
display name, classification and specialization alongside `taxonomy_status`. Each taxonomy
entry carries its NPPES `code`, nullable `display_name` (also `taxonomy_display_name`) and a
`taxonomy_source`: `nucc` for a matched name, `nppes_code_only` otherwise. Codes absent from a
loaded NUCC version have null names and `unknown_code` status. An empty or absent taxonomy table produces
the same code-only response. The API never infers display names from codes.

`/v1/providers?taxonomy=207Q00000X` and `?specialty=207Q00000X` search exact codes without NUCC.
A specialty name search requires loaded taxonomy, then searches NUCC names case-insensitively
and issuer specialty text. Without taxonomy it returns HTTP 422 with
`error.code: unsupported_without_taxonomy`, even if the location or coverage would produce no
matches. The compatibility API preserves the codes, nullable names and source note and forwards
this error. Existing imported names remain available on later bootstraps; omitting the opt-in
flag skips further imports and does not delete previously loaded data.

Attribution: Health Care Provider Taxonomy Code Set, maintained by the National Uniform Claim
Committee (NUCC), copyright American Medical Association. NUCC's CSV page states that commercial
use, including sales or licensing, requires a license obtained from NUCC. Verify and satisfy the
publisher's current terms before commercial redistribution. The dataset is versioned; this
ingest does not imply licensing, credentialing or scope-of-practice evidence.

The offline fixture is a small cut of the official CSV. Regenerate it after acquiring the source:

```sh
python3 tests/fixtures/taxonomy/regenerate.py
```
