These are unmodified CMS PY2026 Rate PUF rows for Texas Rating Area 10: 51 age
bands each for `20069TX0100006`, `29418TX0140049`, `33602TX0460563`, and
`87226TX0100013`. The JSON records the whole input file's SHA-256 and each CSV
record number. The header is record 1. CMS is the publisher; the source archive was
provided by the owner. No premiums were invented.

Regenerate from the existing external cache, from `openplans/`:

```sh
python3 tests/fixtures/rating/regenerate.py
# Requires OPENPLANS_DATA_DIR, or supply --source /path/to/rate-puf.csv.
```

Run `npm test -- tests/domain/rating` for the public fixture checks.

The unit tests label all altered rows and households as synthetic test
scenarios. Negative controls remove a tobacco price, create a date gap, and
compile an isolated source copy that charges every child; the same four-child
assertion must reject that mutant. The real sources remain untouched.
