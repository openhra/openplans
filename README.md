<img src="brand/repo/readme-header-light.svg" alt="OpenPlans by OpenHRA: US health plan data. On your server." width="960" height="280">

# OpenPlans

US health plan data you can host yourself.

OpenPlans turns public CMS, Census, NPPES, NLM RxNorm and insurer files into an HTTP API for ACA
marketplace plans, household premiums, subsidy estimates, drug coverage and provider networks. It
runs in Docker on your own server. You can trace every answer to the public file it came from.

Project page: <https://plans.openhra.com/> · Part of [OpenHRA](https://www.openhra.com/).

> **Status: in development, no release yet.** The code is here and its offline checks pass.
> Expect changes on `develop` until the first tagged version.

[Get started with Docker, call the API and check coverage](docs/usage.md) ·
[self-hosting guide](docs/self-host.md).

## What it answers

| Question | Source |
|---|---|
| Which plans are sold for this ZIP and county? | CMS Exchange public use files, Census ZCTA files |
| What does this household pay? | Filed rate tables (federal age curve; NY and VT family tiers) |
| What subsidy might apply? | Benchmark plan, expected contribution, Form 8962 rounding |
| Is this drug covered, at what tier? | Insurer formulary files, NLM RxNorm |
| Is this provider in the plan's network? | Insurer provider files, CMS NPPES |

## Principles

- OpenPlans uses public sources only and keeps attribution and provenance for every row.
- OpenPlans never invents data. Missing, blocked or incomplete evidence is `unknown`, never
  "not covered".
- Host it yourself with Docker Compose, PostgreSQL and PostGIS. Services bind to `127.0.0.1`.
- We compare releases value by value against the raw public files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md).
For questions, use the contact section of <https://www.openhra.com/#contact>.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Public datasets keep their
publishers' terms; OpenPlans downloads them at install time and does not redistribute them.
