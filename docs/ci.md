# Continuous integration

The exported repository owns `.github/workflows/ci.yml`. It runs from the
repository root on pushes, pull requests and manual dispatches. It needs no
secrets, data downloads or publication policy file. The workflow uses JSON syntax,
which is valid YAML, so the command-contract tests can parse it without adding a
YAML dependency. Checkout v4.3.1 and setup-node v4.4.0 are pinned to commit IDs.

Node is pinned in `.node-version` to 22.23.4. npm is pinned in
`.github/npm-version` to 10.9.10. The Docker build uses the same versions. Package
versions remain in `package-lock.json`, including TypeScript 5.9.3 and Vitest 2.1.9.
To reproduce a project job with that Node version on Linux or macOS, run:

```sh
npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund
npm ci --no-audit --no-fund
scripts/ci.sh
```

The install may use the network. After installation, `scripts/ci.sh` uses offline
npm commands and ends with `PASS`. It runs typechecking, extraction boundaries,
build and fixture tests. The optional neutrality audit skips when no external
policy is supplied. That skip does not approve publication. Public CI does not
run real-data checks or deploy anything.

Require these exact check names when activating branch protection and release
validation:

- `OpenPlans / Linux`, Ubuntu 24.04, clean install and offline project checks.
- `OpenPlans / macOS`, macOS 15 on Intel x64, the same commands.
- `OpenPlans / Docker Linux`, Ubuntu 24.04, Docker build and compiled entry check.
- `OpenPlans / required`, checks every prerequisite result, even after failure.

The final job rejects missing, skipped, canceled and failed prerequisites. Required
jobs have no path filters or conditional skips. Contract tests check the workflow's
platforms, commands, pins and prerequisites. They also prove that a mismatched lock
cannot pass a clean install. Existing archive tests retain stored-byte checks,
decoded DEFLATE comparisons, CRC checks and decompression limits.

A local run proves only the commands it executes. During activation, record hosted
run URLs for Linux, macOS and Docker at the exact candidate commit. A local result
is not evidence that hosted branch protection is configured.
