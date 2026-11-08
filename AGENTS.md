# OpenPlans: agent rules

Agent-neutral rules for Claude Code, Codex or a person working in this repository. Claude reads this
through `CLAUDE.md`; Codex reads it directly. Put every rule here, never in an agent-specific file.

## Rules

- **This repository is public.** Write every file, commit message, branch name and issue as if
  strangers will read it.
- **Git: develop-flow.** Work on a branch cut from `develop`; merge into `develop` after the gate
  passes; `main` only fast-forwards to a validated `develop` commit. Never commit to `main`, never
  rewrite or force-push, always fix forward. Push only when a maintainer asks.
- **Public sources only.** CMS, Census, NPPES, NLM RxNorm, insurer QHP files and the CMS
  Marketplace API. Respect each publisher's terms; keep attribution and provenance. Never call a
  proprietary health-plan API and never name private vendors or proprietary APIs. Insurer names
  from public data are fine.
- **Never fabricate data.** No invented premiums, coverage, NPIs or RxCUIs. Missing evidence is
  `unknown`, never `not covered`. Synthetic fixtures are labelled synthetic.
- **Data cache.** Real downloads go to `OPENPLANS_DATA_DIR`, never into the repository. Committed
  fixtures stay under 200 KB each and are cut from real files by a committed script.
- **Offline CI.** `scripts/ci.sh` must pass with no network. Checks that need real data belong in
  `scripts/realdata.sh`.
- **Tests have negative controls:** break a temporary copy on purpose and show the check fails.
- **Secrets.** Never print, copy or commit `.env` values or API keys.
- **No contact email addresses** anywhere. Point people to <https://www.openhra.com/#contact>.
- **Docker.** Containers bind to `127.0.0.1`; Compose project names start with `openplans-`; tear
  down what you start.
- **Name.** Write the project's name as **OpenPlans** in prose, headings and alt text. Technical
  identifiers stay lowercase: the repository `openhra/openplans`, package and CLI names,
  `OPENPLANS_*` variables, the `openplans-` Compose prefix and the `openplans/<version>` User-Agent.
- **Report honestly:** what works, what was written but not run, the gate output, and what still
  has to be tried by hand.
