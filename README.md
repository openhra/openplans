# openplans

US health plan data you can host yourself.

openplans turns public CMS, Census, NPPES, NLM RxNorm and insurer files into an HTTP API for ACA
marketplace plans, household premiums, subsidy estimates, drug coverage and provider networks. It
runs in Docker on your own server, and every answer can be traced to the public file it came from.

Project page: <https://plans.openhra.com/> · Part of [OpenHRA](https://www.openhra.com/).

> **Status: in development.** The code is being moved into this repository from its incubator. Until
> the first release, `main` may be empty or incomplete. Watch the repository for the first tagged
> version.

## What it answers

| Question | Source |
|---|---|
| Which plans are sold for this ZIP and county? | CMS Exchange public use files, Census ZCTA files |
| What does this household pay? | Filed rate tables (federal age curve; NY and VT family tiers) |
| What subsidy might apply? | Benchmark plan, expected contribution, Form 8962 rounding |
| Is this drug covered, at what tier? | Insurer formulary files, NLM RxNorm |
| Is this provider in the plan's network? | Insurer provider files, CMS NPPES |

## Principles

- **Public sources only**, with attribution and provenance kept for every row.
- **Nothing is invented.** Missing, blocked or incomplete evidence is `unknown`, never
  "not covered".
- **Self-hosted.** Docker Compose with PostgreSQL and PostGIS; services bind to `127.0.0.1`.
- **Checked against the source.** Releases are compared value by value with the raw public files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).
Questions: use the contact section of <https://www.openhra.com/#contact>.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Public datasets keep their
publishers' terms; openplans downloads them at install time and does not redistribute them.
