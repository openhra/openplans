# Continuous integration

The exported repository owns `.github/workflows/ci.yml`. It runs from the
repository root on branch pushes, pull requests and manual dispatches. It needs no
secrets, data downloads or publication policy file. The workflow uses JSON syntax,
which is valid YAML, so the command-contract tests can parse it without adding a
YAML dependency. The workflow pins Checkout and setup-node to commit IDs.

Node is pinned in `.node-version`. npm is pinned in `.github/npm-version`. The Docker build uses the same versions. Each
`FROM` line in `Dockerfile` and `Dockerfile.db` names its base image by tag and by
multi-platform index digest, so a retagged base image can't change the build. Package
versions are pinned in `package-lock.json`.
To reproduce a project job with that Node version on Linux or macOS, run:

```sh
npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund
npm ci --no-audit --no-fund
scripts/ci.sh
```

The install may use the network. After installation, `scripts/ci.sh` uses offline
npm commands and ends with `PASS`. It builds the SDK, the plugins and the app once,
then runs formatting and lint checks, tooling negative controls, typechecking,
publisher-review freshness, extraction boundaries and fixture tests. Vitest runs
test files in parallel on a third of the CPUs, at most 3 workers, and one at a time
on a machine with fewer than 6 CPUs. Set `OPENPLANS_TEST_WORKERS=<n>` to choose the
count. The pass-through wiring checks and optional SQLite harness run after the parallel
files, in a separate group with one worker. Their cold module imports and cache reads
then have no sibling test workers competing for CPU or I/O. The checks keep the same
assertions and timeouts.

The optional neutrality audit skips when no external
policy is supplied. That skip does not approve publication. Public CI does not
run real-data checks or deploy anything.

The Linux and macOS jobs install Poppler (`poppler-utils` with apt, `poppler` with Homebrew) so the
carrier-document PDF tests run. Both jobs set `OPENPLANS_REQUIRE_POPPLER=1`: with that variable set, a
missing `pdftotext` fails `test_poppler_required.py` and `extract.test.ts` instead of letting the PDF tests
skip. Without the variable the tests still skip with a reason, for contributors who have no Poppler.

Require these exact check names when activating branch protection and release
validation:

- `OpenPlans / Linux`, Ubuntu 24.04, clean install and offline project checks.
- `OpenPlans / PostGIS`, Ubuntu 24.04, the keyed provider search and maintenance locks against a
  PostGIS container.
- `OpenPlans / Docker Linux`, Ubuntu 24.04, Docker build and compiled entry check.
- `OpenPlans / required`, checks every prerequisite result, even after failure.

## One full run per commit

A release pushes the same commit to `develop` and `main` and tags it. Each commit gets one
full run:

- Tag pushes start no run. A release tag always points at the current `main` commit, and
  GitHub shows that commit's checks on the tag.
- Every run starts with `OpenPlans / same-commit check`. On a push to `main` it looks for a
  push run of `ci.yml` on `develop` for the same commit. It waits up to three minutes for
  that run to appear, then up to 55 minutes for it to finish. If the develop run passed with
  every check job, the main run skips its check jobs and records the develop run's URL as
  its `source_run` output and in the job summary. If the develop run failed or never
  finished, the main run fails. If no develop run appears, the main run runs every check
  itself.
- Every other event and ref runs every check: pull requests, manual dispatches, and pushes
  to `develop`, feature branches and `release/**`.
- `OpenPlans / required` accepts skipped checks only when the same-commit job succeeded,
  chose to skip, and named a run URL. Branch protection should require this check: it is the
  one that fails when `main` skips without proof. GitHub counts a job skipped by its
  condition as passing, so the other required names never block a `main` push.

To see why a `main` run skipped its checks, open its same-commit job summary.

The macOS checks are advisory when GitHub cancels or skips them. The required job reads the
`OpenPlans / macOS` summary and records that outcome. A failed macOS test still fails the
required job. The same-commit proof requires Linux, Docker, PostGIS and the required summary.
Read the macOS summary when you change platform-specific code.

The macOS checks run on macOS 15 on Intel x64 as three `OpenPlans / macOS shard <n>` jobs on
separate runners. Those runners take about twice as long as Linux for the same tests, and with
4 CPUs they run one test file at a time, so one macOS job no longer fits its time limit. Each shard sets
`OPENPLANS_CI_SHARD=<n>/<count>`, and `scripts/ci.sh` then builds everything and runs that
slice of the test files with `vitest --shard`. Shard 1 also runs the formatting, lint,
typecheck, publisher-review and extraction checks. Vitest assigns every test file to exactly
one slice, so the shards together run the whole suite. A checked-in timing file,
`scripts/test-timings.json`, gives each file its median wall time from three full JSON
reporter runs. The sequencer assigns each file, longest first, to the lightest shard. Ties use the
file path, then the shard index. New files use the median known duration and still
run once. Each runner reads the same committed timing file. Local Vitest caches
do not change shard membership.
To run one slice locally:

```sh
OPENPLANS_CI_SHARD=2/3 scripts/ci.sh
```

Omit `OPENPLANS_CI_SHARD` for a single-command full run. Collect fresh timings from
three unsharded runs on the same source and with the same worker count:

```sh
npx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/tests-1.json
npx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/tests-2.json
npx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/tests-3.json
node scripts/test-timings.mjs scripts/test-timings.json /tmp/tests-{1,2,3}.json
```

Commit the resulting timing file. It stores durations under relative test paths.

The final job rejects missing, canceled and failed prerequisites, and skipped ones unless
a passing run of the same commit exists (see above). Required jobs have no path filters,
and the same-commit decision is their only condition. Contract tests check the workflow's
platforms, commands, pins and prerequisites. Planted mutants prove that the tests catch a
skip without a passing same-commit run and a skip on any ref other than `main`. They also prove that a mismatched lock
cannot pass a clean install. Existing archive tests retain stored-byte checks,
decoded DEFLATE comparisons, CRC checks and decompression limits.

A local run proves only the commands it executes. During activation, record hosted
run URLs for Linux, macOS and Docker at the exact candidate commit. A local result
is not evidence that hosted branch protection is configured.
