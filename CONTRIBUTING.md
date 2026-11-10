# Contributing to OpenPlans

Read and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when taking part in OpenPlans.

OpenPlans is a public preview. Expect changes on `develop` between tagged releases.

## How work flows

1. Branch from `develop`, one task per branch.
2. Run `npm ci` once, then `scripts/ci.sh` before you commit. It works offline.
3. Open a pull request against `develop`. Maintainers merge after the checks pass.
4. `main` only moves forward to a fully validated `develop` commit. Fix failures forward.

## Data rules

- Use only the public sources listed in the [README](README.md), and keep their source URLs,
  versions, retrieval times and SHA-256 hashes.
- Never invent premiums, coverage, NPIs or RxCUIs. Missing evidence stays `unknown`.
- Keep fixtures under 200 KB. Cut them from real files with a committed script. Label synthetic
  records as synthetic.
- Put downloads and reports in an external `OPENPLANS_DATA_DIR`, never in the repository.
- Never commit credentials, `.env` files, household data or contact email addresses.

## Tests

Every check needs a negative control. Break a temporary copy of the input and show that the same
check rejects it. Never mutate real source snapshots to test failure handling.

## Questions

Use the contact section of <https://www.openhra.com/#contact>.
