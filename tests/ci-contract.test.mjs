import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFileInfo } from "prettier";
import { pathToFileURL } from "node:url";
import * as checkRequiredModule from "../.github/check-required.mjs";

const {
  advisoryJobs,
  checkRequired,
  macosShardJobs,
  requiredJobs,
  sameCommitJob,
} = checkRequiredModule;

const root = fileURLToPath(new URL("..", import.meta.url));
const runnerLimits = JSON.parse(
  await readFile(join(root, ".github/runner-limits.json"), "utf8"),
);
const dockerIgnorePattern = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**/", "(?:.*/)?")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*")
      .replaceAll("?", "[^/]")}$`,
  );
const workflow = JSON.parse(
  await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
);
const installNpm =
  'npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund';
const verifyVersions =
  'test "$(node --version)" = "v$(cat .node-version)"\ntest "$(npm --version)" = "$(cat .github/npm-version)"';
const retiredRunnerLabels = ["macos-13", "macos-14"];
// The checks run unless the same-commit job found a passing develop run of the commit.
const fullOnly = "${{ needs.dedupe.outputs.full == 'true' }}";

it("keeps JSON-form workflows byte-identical during formatting and detects a missing ignore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-workflow-format-"));
  try {
    const ignore = await readFile(join(root, ".prettierignore"), "utf8");
    const bytes = await readFile(join(root, ".github/workflows/ci.yml"));
    const path = join(directory, ".github/workflows/ci.yml");
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(join(directory, ".prettierignore"), ignore);
    const format = () =>
      spawnSync(
        process.execPath,
        [
          join(root, "node_modules/prettier/bin/prettier.cjs"),
          "--ignore-path",
          ".prettierignore",
          "--write",
          ".",
        ],
        { cwd: directory, encoding: "utf8" },
      );
    expect(
      (
        await getFileInfo(path, {
          ignorePath: join(directory, ".prettierignore"),
        })
      ).ignored,
    ).toBe(true);
    expect(format().status).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(workflow);
    await writeFile(
      join(directory, ".prettierignore"),
      ignore.replace(".github/workflows/*.yml", ""),
    );
    expect(
      (
        await getFileInfo(path, {
          ignorePath: join(directory, ".prettierignore"),
        })
      ).ignored,
    ).toBe(false);
    expect(format().status).toBe(0);
    expect(await readFile(path)).not.toEqual(bytes);
    const formatted = await readFile(path, "utf8");
    expect(() => JSON.parse(formatted)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function commandContract(value) {
  // Branch pushes only: a release tag points at a main commit that already has a run.
  expect(value.on).toEqual({
    push: { branches: ["**"] },
    pull_request: null,
    workflow_dispatch: null,
  });
  expect(value.permissions).toEqual({ contents: "read" });
  expect(value.defaults).toEqual({ run: { shell: "bash" } });
  expect(Object.keys(value.jobs).sort()).toEqual([
    "dedupe",
    "docker",
    "linux",
    "macos",
    "macos-shard",
    "postgis",
    "required",
  ]);
  for (const id of ["linux", "docker"]) {
    const job = value.jobs[id];
    expect(job.name).toBe(requiredJobs[id]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toBe(fullOnly);
    expect(job.needs).toEqual(["dedupe"]);
    expect(job.strategy).toBeUndefined();
  }
  // The same-commit job reads workflow runs and decides; it never skips itself.
  const dedupe = value.jobs.dedupe;
  expect(dedupe.name).toBe(sameCommitJob.dedupe);
  expect(dedupe["runs-on"]).toBe("ubuntu-24.04");
  expect(dedupe["timeout-minutes"]).toBe(60);
  expect(dedupe.if).toBeUndefined();
  expect(dedupe.needs).toBeUndefined();
  expect(dedupe.permissions).toEqual({ actions: "read", contents: "read" });
  expect(dedupe.outputs).toEqual({
    full: "${{ steps.decide.outputs.full }}",
    source_run: "${{ steps.decide.outputs.source_run }}",
  });
  expect(dedupe.steps).toHaveLength(3);
  expect(dedupe.steps[1].with).toEqual({
    "node-version-file": ".node-version",
  });
  expect(dedupe.steps[2]).toEqual({
    id: "decide",
    name: "Find a passing run of this commit",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: "node .github/check-required.mjs same-commit",
  });
  // macOS runs the project checks as a matrix of test shards on separate runners. Each shard
  // tells ci.sh its slice; the count comes from the matrix itself, so the slices always cover
  // every test file exactly once.
  const shard = value.jobs["macos-shard"];
  expect(shard.name).toBe("OpenPlans / macOS shard ${{ matrix.shard }}");
  expect(shard["runs-on"]).toBe("macos-15-intel");
  expect(retiredRunnerLabels).not.toContain(shard["runs-on"]);
  expect(shard["timeout-minutes"]).toBeLessThanOrEqual(45);
  expect(shard.if).toBe(fullOnly);
  expect(shard.needs).toEqual(["dedupe"]);
  expect(Object.keys(shard.strategy).sort()).toEqual(["fail-fast", "matrix"]);
  expect(shard.strategy["fail-fast"]).toBe(false);
  expect(Object.keys(shard.strategy.matrix)).toEqual(["shard"]);
  const slices = shard.strategy.matrix.shard;
  expect(slices.length).toBeGreaterThan(1);
  expect(slices).toEqual(slices.map((_, index) => index + 1));
  // The macOS check has a summary job. Cancellation is advisory; a test failure is not.
  const macos = value.jobs.macos;
  expect(macos.name).toBe(advisoryJobs.macos);
  expect(macos["runs-on"]).toBe("ubuntu-24.04");
  expect(macos.if).toBe(
    "${{ always() && needs.dedupe.outputs.full == 'true' }}",
  );
  expect(macos.needs).toEqual(["dedupe", ...Object.keys(macosShardJobs)]);
  expect(macos.strategy).toBeUndefined();
  expect(macos.steps).toHaveLength(3);
  expect(macos.steps[1].with).toEqual({ "node-version-file": ".node-version" });
  expect(macos.steps[2].run).toBe("node .github/check-required.mjs macos");
  expect(macos.steps[2].env).toEqual({ NEEDS_RESULTS: "${{ toJSON(needs) }}" });
  for (const step of macos.steps) expect(step.if).toBeUndefined();
  expect(advisoryJobs).toEqual({ macos: "OpenPlans / macOS" });
  for (const [id, job] of Object.entries(value.jobs)) {
    expect(job["continue-on-error"], id).toBeUndefined();
    expect(job["working-directory"]).toBeUndefined();
    expect(job.defaults).toBeUndefined();
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
    expect(job.steps[0].with).toEqual({ "persist-credentials": false });
    for (const step of job.steps) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step["working-directory"]).toBeUndefined();
      if (step.uses)
        expect(step.uses).toMatch(
          /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/,
        );
    }
  }
  for (const id of ["linux", "macos-shard"]) {
    const steps = value.jobs[id].steps;
    // Poppler's pdftotext runs the carrier-document PDF tests. The job declares it required, so
    // those tests fail instead of skipping when the install step goes missing.
    expect(value.jobs[id].env).toEqual({ OPENPLANS_REQUIRE_POPPLER: "1" });
    expect(steps).toHaveLength(8);
    // Right after setup-node, before anything else: the runner must still match
    // runner-limits.json, the file `scripts/ci.sh --hosted` reproduces locally.
    expect(steps[2]).toEqual({
      name: "Check runner limits",
      run: `node .github/runner-limits.mjs check ${id === "linux" ? "linux" : "macos"}`,
    });
    expect(runnerLimits[id === "linux" ? "linux" : "macos"].image).toBe(
      value.jobs[id]["runs-on"],
    );
    expect(steps[3].name).toBe("Install Poppler");
    expect(steps[3].run).toBe(
      id === "linux"
        ? "sudo apt-get update\nsudo apt-get install --yes --no-install-recommends poppler-utils\npdftotext -v"
        : "brew install poppler\npdftotext -v",
    );
    expect(steps[1].uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(steps[1].with).toEqual({ "node-version-file": ".node-version" });
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      steps[2].run,
      steps[3].run,
      installNpm,
      verifyVersions,
      "npm ci --no-audit --no-fund",
      "scripts/ci.sh",
    ]);
    expect(steps[7].env).toEqual(
      id === "linux"
        ? { npm_config_offline: "true" }
        : {
            npm_config_offline: "true",
            OPENPLANS_CI_SHARD: "${{ matrix.shard }}/${{ strategy.job-total }}",
          },
    );
    for (const step of steps) expect(step.if).toBeUndefined();
  }
  const docker = value.jobs.docker.steps;
  expect(docker).toHaveLength(5);
  expect(docker[1].run).toBe(
    "docker build --pull --tag openplans-ci:${{ github.sha }} .",
  );
  expect(docker[2].run).toBe(
    "docker run --rm --network none openplans-ci:${{ github.sha }} node --check dist/api/server.js",
  );
  // The report is off by default: with no network the image prints its state and exits 0.
  expect(docker[3].run).toContain(
    "--network none -e OPENPLANS_PUBLIC_QUOTING=off -e OPENPLANS_PUBLIC_HOUSEHOLD=off -e OPENPLANS_PUBLIC_COMPAT=off openplans-ci:${{ github.sha }} worker usage-report show",
  );
  expect(docker[3].run).toContain("grep -qx 'state: off'");
  for (const step of docker.slice(0, 4)) expect(step.if).toBeUndefined();
  expect(docker[4].if).toBe("${{ always() }}");
  // The PostGIS job builds Dockerfile.db and runs the suites that need PostGIS in a disposable
  // container from it; scripts/postgis-tests.sh fails when any of their tests is skipped.
  const postgis = value.jobs.postgis;
  expect(postgis.name).toBe(requiredJobs.postgis);
  expect(postgis["runs-on"]).toBe("ubuntu-24.04");
  expect(postgis["timeout-minutes"]).toBeLessThanOrEqual(30);
  expect(postgis.if).toBe(fullOnly);
  expect(postgis.needs).toEqual(["dedupe"]);
  expect(postgis.strategy).toBeUndefined();
  expect(postgis.steps).toHaveLength(9);
  expect(postgis.steps[1].with).toEqual({
    "node-version-file": ".node-version",
  });
  expect(
    postgis.steps.filter((step) => step.run).map((step) => step.run),
  ).toEqual([
    installNpm,
    verifyVersions,
    "npm ci --no-audit --no-fund",
    "npm run build:plugins",
    "docker build --pull --tag openplans-postgis-ci:${{ github.sha }} --file Dockerfile.db .",
    "scripts/postgis-tests.sh --image openplans-postgis-ci:${{ github.sha }}",
    "if docker image inspect openplans-postgis-ci:${{ github.sha }} >/dev/null 2>&1; then\n  docker image rm openplans-postgis-ci:${{ github.sha }}\nfi",
  ]);
  expect(postgis.steps[7].env).toEqual({ npm_config_offline: "true" });
  for (const step of postgis.steps.slice(0, 8)) expect(step.if).toBeUndefined();
  expect(postgis.steps[8].if).toBe("${{ always() }}");
  const required = value.jobs.required;
  expect(required.name).toBe("OpenPlans / required");
  expect(required.if).toBe("${{ always() }}");
  expect(required.needs).toEqual([
    ...Object.keys(sameCommitJob),
    ...Object.keys(requiredJobs),
    "macos",
  ]);
  expect(required.steps).toHaveLength(3);
  expect(required.steps[1].with).toEqual({
    "node-version-file": ".node-version",
  });
  expect(required.steps[2].run).toBe("node .github/check-required.mjs");
  expect(required.steps[2].env).toEqual({
    NEEDS_RESULTS: "${{ toJSON(needs) }}",
  });
  for (const step of required.steps) expect(step.if).toBeUndefined();
}

it("runs clean extracted-root checks on both platforms, the PostGIS suites and builds the Linux artifact", () => {
  commandContract(workflow);
});

it.each(retiredRunnerLabels)(
  "negative control: rejects retired runner label %s",
  (label) => {
    const copy = structuredClone(workflow);
    copy.jobs["macos-shard"]["runs-on"] = label;
    expect(() => commandContract(copy)).toThrow();
  },
);

const digestPin =
  /^FROM [a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}( AS [a-z]+)?$/;

function unpinnedFromLines(dockerfile) {
  const lines = dockerfile.match(/^FROM .+$/gm) ?? [];
  if (lines.length === 0) throw new Error("no FROM line");
  return lines.filter((line) => !digestPin.test(line));
}

it.each(["Dockerfile", "Dockerfile.db"])(
  "pins every base image in %s by tag and digest",
  async (name) => {
    expect(unpinnedFromLines(await readFile(join(root, name), "utf8"))).toEqual(
      [],
    );
  },
);

it.each([
  ["a tag without a digest", (line) => line.replace(/@sha256:[0-9a-f]+/, "")],
  [
    "a short digest",
    (line) => line.replace(/(@sha256:[0-9a-f]{12})[0-9a-f]+/, "$1"),
  ],
  ["a digest without a tag", (line) => line.replace(/:[^:@]+@/, "@")],
])(
  "negative control: flags a Dockerfile FROM line with %s",
  async (_, mutate) => {
    const docker = await readFile(join(root, "Dockerfile"), "utf8");
    const [first] = docker.match(/^FROM .+$/m);
    const mutant = docker.replace(first, mutate(first));
    expect(mutant).not.toBe(docker);
    expect(unpinnedFromLines(mutant)).toEqual([mutate(first)]);
  },
);

it("pins the same Node and npm versions for project and Docker checks", async () => {
  const node = (await readFile(join(root, ".node-version"), "utf8")).trim();
  const npm = (
    await readFile(join(root, ".github/npm-version"), "utf8")
  ).trim();
  expect(node).toBe("22.23.5");
  expect(npm).toBe("10.9.10");
  const docker = await readFile(join(root, "Dockerfile"), "utf8");
  expect(
    docker
      .match(/^FROM .+$/gm)
      ?.map((line) => line.replace(/@sha256:[0-9a-f]{64}/, "")),
  ).toEqual([
    `FROM node:${node} AS build`,
    `FROM node:${node}-slim AS runtime`,
  ]);
  expect(docker).toContain("COPY .github/npm-version .github/npm-version");
  expect(docker).toContain(installNpm);
  const ci = await readFile(join(root, "scripts/ci.sh"), "utf8");
  expect(ci).toContain("export npm_config_offline=true");
});

it("builds workspace packages before core and discovers their tests", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(pkg.workspaces).toEqual(["plugins/*"]);
  expect(pkg.scripts.build).toBe(
    "npm run build:plugins && tsc -p tsconfig.build.json",
  );
  expect(pkg.scripts["build:sdk"]).toBe(
    "npm run build -w @openplans/plugin-sdk",
  );
  expect(pkg.scripts["build:plugins"]).toBe(
    "npm run build:sdk && npm run build --workspaces --if-present",
  );
  expect(pkg.scripts.pretypecheck).toBe("npm run build:plugins");
  const sdk = JSON.parse(
    await readFile(join(root, "plugins/sdk/package.json"), "utf8"),
  );
  expect(pkg.dependencies[sdk.name]).toBe(sdk.version);
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  expect(lock.packages["node_modules/@openplans/plugin-sdk"]).toEqual({
    resolved: "plugins/sdk",
    link: true,
  });
  const config = (await import("../vitest.config.ts")).default;
  expect(config.test.dir).toBeUndefined();
  expect(config.test.projects[0].test.include).toContain(
    "plugins/*/tests/**/*.test.ts",
  );
});

it("sizes the test workers for a shared machine", async () => {
  const { default: config, testWorkers } = await import("../vitest.config.ts");
  expect(config.test.pool).toBe("forks");
  expect(config.test.maxWorkers).toBe(testWorkers());
  // A third of the CPUs, at least 1 and at most 3.
  for (const [cpus, workers] of [
    [1, 1],
    [4, 1],
    [6, 2],
    [10, 3],
    [64, 3],
  ])
    expect(testWorkers({}, cpus)).toBe(workers);
  expect(testWorkers({ OPENPLANS_TEST_WORKERS: "1" }, 64)).toBe(1);
  expect(testWorkers({ OPENPLANS_TEST_WORKERS: "6" }, 4)).toBe(6);
  expect(testWorkers({ OPENPLANS_TEST_WORKERS: "" }, 10)).toBe(3);
  // The PostGIS suites share one server and count its advisory locks: one file at a time.
  const postgis = await readFile(
    join(root, "scripts/postgis-tests.sh"),
    "utf8",
  );
  expect(postgis).toContain("OPENPLANS_TEST_WORKERS=1 npx vitest run ");
  for (const value of ["0", "-1", "2.5", "two", " 2"])
    expect(() => testWorkers({ OPENPLANS_TEST_WORKERS: value }, 10)).toThrow(
      "OPENPLANS_TEST_WORKERS must be a positive whole number",
    );
});

const installScripts = ["preinstall", "install", "postinstall", "prepare"];

// npm does not order workspace lifecycle scripts by dependency, so during `npm ci` a plugin's
// install-time build can run before the SDK exists. Only the SDK may build on install, and
// plugins may depend on no workspace package but the SDK, so "SDK first, then the rest" holds.
function installOrderProblems(packages, sdkName) {
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  // Admin composes the status package's exported reader and view. Its build script builds
  // that dependency first; npm install itself must still have no plugin lifecycle scripts.
  const buildTimeWorkspaceDependencies = new Map([
    ["plugins/admin", new Set(["@openplans/plugin-status"])],
  ]);
  const problems = [];
  for (const { dir, manifest } of packages) {
    if (manifest.name === sdkName) {
      if (
        Object.keys(manifest.dependencies ?? {}).some((name) => names.has(name))
      )
        problems.push(`${dir}: SDK depends on a workspace package`);
      continue;
    }
    for (const script of installScripts) {
      if (manifest.scripts?.[script])
        problems.push(`${dir}: ${script} script runs before the SDK is built`);
    }
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        const isAllowedBuildDependency =
          section === "dependencies" &&
          buildTimeWorkspaceDependencies.get(dir)?.has(name);
        if (names.has(name) && name !== sdkName && !isAllowedBuildDependency)
          problems.push(`${dir}: depends on workspace package ${name}`);
      }
    }
  }
  return problems;
}

it("builds only the SDK during install so a clean npm ci never needs a missing SDK", async () => {
  const plugins = join(root, "plugins");
  const packages = [];
  for (const dir of (await readdir(plugins, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const manifest = JSON.parse(
      await readFile(join(plugins, dir, "package.json"), "utf8"),
    );
    packages.push({ dir: `plugins/${dir}`, manifest });
  }
  const sdk = packages.find(({ dir }) => dir === "plugins/sdk");
  expect(sdk.manifest.scripts.prepare).toBe("npm run build");
  expect(packages.length).toBeGreaterThan(1);
  expect(installOrderProblems(packages, sdk.manifest.name)).toEqual([]);

  // Negative controls: each planted mutant must be reported.
  const mutate = (dir, change) =>
    packages.map((entry) =>
      entry.dir === dir
        ? { dir, manifest: change(structuredClone(entry.manifest)) }
        : entry,
    );
  const plugin = packages.find(({ dir }) => dir !== "plugins/sdk").dir;
  for (const script of installScripts) {
    const mutant = mutate(plugin, (manifest) => {
      manifest.scripts = { ...manifest.scripts, [script]: "npm run build" };
      return manifest;
    });
    expect(installOrderProblems(mutant, sdk.manifest.name)).toEqual([
      `${plugin}: ${script} script runs before the SDK is built`,
    ]);
  }
  const other = packages.find(
    ({ dir }) => dir !== "plugins/sdk" && dir !== plugin,
  ).manifest.name;
  const chained = mutate(plugin, (manifest) => {
    manifest.dependencies = { ...manifest.dependencies, [other]: "0.1.0" };
    return manifest;
  });
  expect(installOrderProblems(chained, sdk.manifest.name)).toEqual([
    `${plugin}: depends on workspace package ${other}`,
  ]);
});

it("packages workspace manifests before install and retains only runtime plugin files", async () => {
  const docker = await readFile(join(root, "Dockerfile"), "utf8");
  expect(docker.indexOf("COPY plugins ./plugins")).toBeLessThan(
    docker.indexOf("&& npm ci"),
  );
  expect(
    docker.indexOf(
      "COPY scripts/source-mutation.mjs scripts/source-mutation.d.mts ./scripts/",
    ),
  ).toBeGreaterThan(-1);
  expect(
    docker.indexOf(
      "COPY scripts/source-mutation.mjs scripts/source-mutation.d.mts ./scripts/",
    ),
  ).toBeLessThan(docker.indexOf("RUN npm run build"));
  expect(docker.indexOf("COPY plugins ./plugins")).toBeLessThan(
    docker.indexOf("RUN npm run build"),
  );
  expect(docker).toContain(
    "-name dist -o -name package.json -o -name migrations",
  );
  expect(docker).toContain(
    "COPY --from=build --chown=node:node /runtime/plugins ./plugins",
  );
  expect(docker).toContain("COPY plugins ./plugins");
  const admin = JSON.parse(
    await readFile(join(root, "plugins/admin/package.json"), "utf8"),
  );
  expect(admin.main).toBe("dist/index.js");
  expect(admin.types).toBe("dist/index.d.ts");
  expect(docker).toContain(
    "-name dist -o -name package.json -o -name migrations",
  );
  const ignore = await readFile(join(root, ".dockerignore"), "utf8");
  const ignoredPaths = ignore.split("\n");
  for (const path of ["**/node_modules", "**/dist", "**/.env", "**/.env.*"]) {
    expect(ignoredPaths).toContain(path);
  }
  const sourcePaths = [];
  const collectSources = async (directory, relative = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await collectSources(join(directory, entry.name), path);
      } else if (path.includes("/src/")) {
        sourcePaths.push(path);
      }
    }
  };
  await collectSources(join(root, "plugins"), "plugins");
  const rules = ignoredPaths
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => dockerIgnorePattern(line.replace(/^\/+/, "")));
  expect(sourcePaths.length).toBeGreaterThan(0);
  for (const path of sourcePaths) {
    const segments = path.split("/");
    const prefixes = segments.map((_, index) =>
      segments.slice(0, index + 1).join("/"),
    );
    expect(
      rules.some((rule) => prefixes.some((prefix) => rule.test(prefix))),
      `${path} must remain in the image build context`,
    ).toBe(false);
  }
});

it.each([
  [
    "missing platform",
    (copy) => {
      delete copy.jobs.macos;
    },
  ],
  [
    "skipped platform",
    (copy) => {
      copy.jobs.linux.if = "${{ false }}";
    },
  ],
  [
    "skipped project command",
    (copy) => {
      copy.jobs["macos-shard"].steps[7].if = "${{ false }}";
    },
  ],
  [
    "macOS shards that skip the project checks",
    (copy) => {
      delete copy.jobs["macos-shard"].steps[7].env.OPENPLANS_CI_SHARD;
    },
  ],
  [
    "a fixed shard count that can drift from the matrix",
    (copy) => {
      copy.jobs["macos-shard"].steps[7].env.OPENPLANS_CI_SHARD =
        "${{ matrix.shard }}/3";
    },
  ],
  [
    "a gap in the shard list",
    (copy) => {
      copy.jobs["macos-shard"].strategy.matrix.shard = [1, 3];
    },
  ],
  [
    "a single macOS shard",
    (copy) => {
      copy.jobs["macos-shard"].strategy.matrix.shard = [1];
    },
  ],
  [
    "fail-fast shards",
    (copy) => {
      copy.jobs["macos-shard"].strategy["fail-fast"] = true;
    },
  ],
  [
    "a raised macOS timeout",
    (copy) => {
      copy.jobs["macos-shard"]["timeout-minutes"] = 60;
    },
  ],
  [
    "a macOS summary that ignores the shards",
    (copy) => {
      copy.jobs.macos.needs = [];
    },
  ],
  [
    "a success-only macOS summary",
    (copy) => {
      delete copy.jobs.macos.if;
    },
  ],
  [
    "a macOS summary that checks the top-level set",
    (copy) => {
      copy.jobs.macos.steps[2].run = "node .github/check-required.mjs";
    },
  ],
  [
    "ignored failure",
    (copy) => {
      copy.jobs.docker["continue-on-error"] = true;
    },
  ],
  [
    "an aggregate that omits the macOS summary",
    (copy) => {
      copy.jobs.required.needs.pop();
    },
  ],
  [
    "a Linux job without the Poppler install",
    (copy) => {
      copy.jobs.linux.steps.splice(2, 1);
    },
  ],
  [
    "a macOS shard that does not require Poppler",
    (copy) => {
      delete copy.jobs["macos-shard"].env;
    },
  ],
  [
    "unlocked install",
    (copy) => {
      copy.jobs.linux.steps[5].run = "npm install";
    },
  ],
  [
    "missing prerequisite",
    (copy) => {
      copy.jobs.required.needs.pop();
    },
  ],
  [
    "success-only aggregate",
    (copy) => {
      delete copy.jobs.required.if;
    },
  ],
  [
    "parent working directory",
    (copy) => {
      copy.jobs.linux.steps[6]["working-directory"] = "source-package";
    },
  ],
  [
    "filtered workflow",
    (copy) => {
      copy.on.push = { paths: ["src/**"] };
    },
  ],
  [
    "tag pushes that test the release commit a third time",
    (copy) => {
      copy.on.push = null;
    },
  ],
  [
    "checks skipped on main without a same-commit proof",
    (copy) => {
      copy.jobs.linux.if = "${{ github.ref != 'refs/heads/main' }}";
    },
  ],
  [
    "an aggregate that ignores the same-commit decision",
    (copy) => {
      copy.jobs.required.needs.shift();
    },
  ],
  [
    "a same-commit job that cannot read workflow runs",
    (copy) => {
      copy.jobs.dedupe.permissions = { contents: "read" };
    },
  ],
  [
    "a non-release ref that skips the checks",
    (copy) => {
      copy.jobs.docker.if =
        "${{ github.ref != 'refs/heads/develop' && needs.dedupe.outputs.full == 'true' }}";
    },
  ],
  [
    "feature branch pushes without checks",
    (copy) => {
      copy.on.push = { branches: ["develop", "main"] };
    },
  ],
])("negative control: rejects %s", (_name, mutate) => {
  const copy = structuredClone(workflow);
  mutate(copy);
  expect(() => commandContract(copy)).toThrow();
});

const fullRun = () => ({
  dedupe: { result: "success", outputs: { full: "true", source_run: "" } },
});
const successful = () => ({
  ...fullRun(),
  ...Object.fromEntries(
    [...Object.keys(requiredJobs), "macos"].map((id) => [
      id,
      { result: "success", outputs: {} },
    ]),
  ),
});
it("accepts only a complete successful set of required job results", () => {
  expect(() => checkRequired(successful())).not.toThrow();
  for (const id of Object.keys(requiredJobs)) {
    for (const status of [
      "skipped",
      "failure",
      "cancelled",
      "pending",
      undefined,
    ]) {
      const result = successful();
      result[id].result = status;
      expect(() => checkRequired(result)).toThrow(
        `${requiredJobs[id]} did not succeed`,
      );
    }
    const missing = successful();
    delete missing[id];
    expect(() => checkRequired(missing)).toThrow("missing or unexpected");
  }
  for (const value of [
    null,
    [],
    {},
    { ...successful(), extra: { result: "success" } },
  ]) {
    expect(() => checkRequired(value)).toThrow("missing or unexpected");
  }
  for (const status of ["skipped", "failure", "cancelled", undefined]) {
    const result = successful();
    result.dedupe.result = status;
    expect(() => checkRequired(result)).toThrow(
      `${sameCommitJob.dedupe} did not succeed`,
    );
  }
  for (const full of [undefined, "", "yes"]) {
    const result = successful();
    result.dedupe.outputs.full = full;
    expect(() => checkRequired(result)).toThrow("gave no decision");
  }
});

it("allows cancelled macOS shards but still rejects test and Linux failures", () => {
  const unavailable = {
    ...successful(),
    macos: { result: "cancelled", outputs: {} },
  };
  expect(checkRequired(unavailable)).toBe("full");
  for (const result of ["failure", "timed_out"]) {
    expect(() =>
      checkRequired({ ...successful(), macos: { result, outputs: {} } }),
    ).toThrow("OpenPlans / macOS did not succeed");
  }
  expect(() =>
    checkRequired({ ...successful(), linux: { result: "failure" } }),
  ).toThrow(`${requiredJobs.linux} did not succeed`);
});

it("summarizes cancelled macOS shards and rejects shard test failures", () => {
  const shards = {
    ...fullRun(),
    "macos-shard": { result: "success", outputs: {} },
  };
  expect(() => checkRequired(shards, macosShardJobs)).not.toThrow();
  for (const status of ["cancelled", "skipped"]) {
    expect(
      checkRequired(
        { ...fullRun(), "macos-shard": { result: status, outputs: {} } },
        macosShardJobs,
      ),
    ).toBe("advisory-unavailable");
  }
  for (const status of ["failure", "pending", undefined]) {
    expect(() =>
      checkRequired(
        { ...fullRun(), "macos-shard": { result: status, outputs: {} } },
        macosShardJobs,
      ),
    ).toThrow("OpenPlans / macOS shards did not succeed");
  }
  for (const value of [
    null,
    {},
    successful(),
    { ...shards, extra: {} },
    { "macos-shard": { result: "success" } },
  ]) {
    expect(() => checkRequired(value, macosShardJobs)).toThrow(
      "missing or unexpected",
    );
  }
});

it.each([
  [
    ["macos"],
    JSON.stringify({ ...fullRun(), "macos-shard": { result: "success" } }),
    0,
  ],
  [
    ["macos"],
    JSON.stringify({ ...fullRun(), "macos-shard": { result: "failure" } }),
    1,
  ],
  [["macos"], JSON.stringify(successful()), 1],
  [
    [],
    JSON.stringify({ ...fullRun(), "macos-shard": { result: "success" } }),
    1,
  ],
  [["unknown"], JSON.stringify(successful()), 1],
])(
  "the shard-results command %j exits according to its group and input",
  (args, input, code) => {
    const result = spawnSync(
      process.execPath,
      [".github/check-required.mjs", ...args],
      {
        cwd: root,
        env: { ...process.env, NEEDS_RESULTS: input },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(code);
    expect(result.stdout.includes("required-jobs: PASS")).toBe(code === 0);
  },
);

it.each(["0/3", "4/3", "a/b", "1/3x", " 1/3", "01/3", "1/0", "2"])(
  "negative control: ci.sh rejects shard %j before running anything",
  (value) => {
    const result = spawnSync("bash", [join(root, "scripts/ci.sh")], {
      cwd: root,
      env: { ...process.env, OPENPLANS_CI_SHARD: value },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENPLANS_CI_SHARD must be");
  },
);

it("passes the shard to vitest and keeps the static checks in shard 1", async () => {
  const ci = await readFile(join(root, "scripts/ci.sh"), "utf8");
  expect(ci).toContain('npm test -- --shard="$shard"');
  expect(ci).toContain('[ "${BASH_REMATCH[1]}" = 1 ] || static=false');
  for (const check of [
    "npm run format:check",
    "npm run lint",
    "npm run typecheck",
    "npm run check:extraction",
  ])
    expect(ci.indexOf(check)).toBeGreaterThan(
      ci.indexOf('if [ "$static" = true ]; then'),
    );
  // Every shard builds, once, before the static block that reads the build: the build sits
  // outside that block, and no later step rebuilds the plugins.
  expect(ci.match(/^\s*(?:step )?npm run build\b.*$/gm)).toEqual([
    "step npm run build",
  ]);
  expect(ci.indexOf("\nstep npm run build\n")).toBeGreaterThan(-1);
  expect(ci.indexOf("\nstep npm run build\n")).toBeLessThan(
    ci.indexOf('if [ "$static" = true ]; then'),
  );
  expect(ci).toContain("  step npm run typecheck --ignore-scripts\n");
});

it.each([
  [JSON.stringify(successful()), 0],
  [JSON.stringify({ ...successful(), macos: { result: "cancelled" } }), 0],
  [JSON.stringify({ ...successful(), macos: { result: "failure" } }), 1],
  [JSON.stringify({ ...successful(), linux: { result: "failure" } }), 1],
  ["{", 1],
  ["", 1],
])(
  "the required-results command exits according to its actual input",
  (input, code) => {
    const result = spawnSync(process.execPath, [".github/check-required.mjs"], {
      cwd: root,
      env: { ...process.env, NEEDS_RESULTS: input },
      encoding: "utf8",
    });
    expect(result.status).toBe(code);
    expect(result.stdout.includes("required-jobs: PASS")).toBe(code === 0);
  },
);

it("negative control: a fresh offline npm ci rejects a mismatched lock even with installed modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-ci-lock-"));
  try {
    for (const name of ["one", "two"]) {
      await mkdir(join(directory, name));
      await writeFile(
        join(directory, name, "package.json"),
        JSON.stringify({ name: "synthetic-ci-dependency", version: "1.0.0" }),
      );
    }
    const manifest = {
      name: "synthetic-ci-lock",
      version: "1.0.0",
      dependencies: { "synthetic-ci-dependency": "file:./one" },
    };
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    const npm = (command, extra = []) =>
      spawnSync(
        "npm",
        [
          command,
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          ...extra,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: join(directory, "cache") },
        },
      );
    expect(npm("install", ["--package-lock-only"]).status).toBe(0);
    expect(npm("ci").status).toBe(0);
    manifest.dependencies["synthetic-ci-dependency"] = "file:./two";
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    const rejected = npm("ci");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("EUSAGE");
    expect(rejected.stderr).toContain("Missing: synthetic-ci-dependency");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

// Same-commit runs. A release pushes develop and main at the same commit; main relies on the
// develop run instead of repeating it. These checks run against the real module and against
// planted mutants of its source, each of which must make at least one check fail.
const sha = "a".repeat(40);
const sourceUrl = "https://github.com/openhra/openplans/actions/runs/7";
const mainPush = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: "openhra/openplans",
};
const sourceRun = (overrides = {}) => ({
  id: 7,
  run_attempt: 1,
  head_sha: sha,
  head_branch: "develop",
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  html_url: sourceUrl,
  ...overrides,
});
const sourceJobs = (module) =>
  [
    module.sameCommitJob.dedupe,
    ...Object.values(module.requiredJobs),
    module.advisoryJobs.macos,
    module.aggregateJob,
  ].map((name, id) => ({
    id,
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  }));

// A synthetic GitHub: each poll of the run list returns the next entry of `runs`.
function fakeGitHub(runs, jobs) {
  let clock = 0;
  const calls = [];
  return {
    calls,
    now: () => clock,
    sleep: async (seconds) => {
      clock += seconds * 1000;
    },
    get: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes("/jobs?"))
        return { total_count: jobs.length, jobs };
      return { workflow_runs: runs.length > 1 ? runs.shift() : runs[0] };
    },
  };
}

const sameCommitResults = (module, overrides = {}) => ({
  dedupe: {
    result: "success",
    outputs: { full: "false", source_run: sourceUrl },
  },
  ...Object.fromEntries(
    [...Object.keys(module.requiredJobs), "macos"].map((id) => [
      id,
      { result: "skipped" },
    ]),
  ),
  ...overrides,
});

// A run may skip its checks only with proof that the same commit passed a full develop run.
async function proofIsRequired(module) {
  expect(module.checkRequired(sameCommitResults(module))).toBe("same-commit");
  for (const source_run of [undefined, "", "https://example.invalid/runs/7"]) {
    const results = sameCommitResults(module);
    results.dedupe.outputs.source_run = source_run;
    expect(() => module.checkRequired(results)).toThrow();
  }
  expect(() =>
    module.checkRequired(
      sameCommitResults(module, {
        // Outputs set before a later step failed still prove nothing.
        dedupe: {
          result: "failure",
          outputs: { full: "false", source_run: sourceUrl },
        },
      }),
    ),
  ).toThrow();
  expect(() =>
    module.checkRequired(
      sameCommitResults(module, { linux: { result: "failure" } }),
    ),
  ).toThrow();
  const jobs = sourceJobs(module);
  expect(module.checkSourceRun(sourceRun(), jobs, sha)).toBe(sourceUrl);
  expect(
    module.checkSourceRun(sourceRun({ conclusion: "failure" }), jobs, sha),
  ).toBe(sourceUrl);
  const failedMac = structuredClone(jobs);
  failedMac[4].conclusion = "failure";
  expect(() =>
    module.checkSourceRun(sourceRun({ conclusion: "failure" }), failedMac, sha),
  ).toThrow();
  for (const run of [
    sourceRun({ status: "in_progress", conclusion: null }),
    sourceRun({ head_sha: "b".repeat(40) }),
    sourceRun({ head_branch: "main" }),
    sourceRun({ event: "workflow_dispatch" }),
    sourceRun({ path: ".github/workflows/other.yml" }),
  ])
    expect(() => module.checkSourceRun(run, jobs, sha)).toThrow();
  for (const [index, change] of [
    [1, { conclusion: "skipped" }],
    [2, { conclusion: "failure" }],
    [0, { head_sha: "b".repeat(40) }],
  ]) {
    const changed = structuredClone(jobs);
    Object.assign(changed[index], change);
    expect(() => module.checkSourceRun(sourceRun(), changed, sha)).toThrow();
  }
  expect(() =>
    module.checkSourceRun(sourceRun(), jobs.slice(1), sha),
  ).toThrow();
  // A failed develop run fails the main run instead of letting it skip.
  const failed = fakeGitHub(
    [[sourceRun({ conclusion: "failure" })]],
    sourceJobs(module).map((job) =>
      job.name === module.advisoryJobs.macos
        ? { ...job, conclusion: "failure" }
        : job,
    ),
  );
  await expect(
    module.findSameCommitRun({ env: mainPush, ...failed }),
  ).rejects.toThrow();
  // A develop run still in progress is awaited, then used.
  const pending = fakeGitHub(
    [[sourceRun({ status: "in_progress", conclusion: null })], [sourceRun()]],
    sourceJobs(module),
  );
  expect(await module.findSameCommitRun({ env: mainPush, ...pending })).toEqual(
    { full: "false", source_run: sourceUrl },
  );
  expect(pending.now()).toBeGreaterThan(0);
  // A develop run that never finishes fails the main run.
  const stuck = fakeGitHub(
    [[sourceRun({ status: "queued", conclusion: null })]],
    sourceJobs(module),
  );
  await expect(
    module.findSameCommitRun({ env: mainPush, ...stuck }),
  ).rejects.toThrow("did not finish in time");
}

// Every event and ref except a push to main runs the full checks without asking GitHub.
async function otherRefsRunFull(module) {
  for (const env of [
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/develop" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/lane/x/feature" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/release/1.0" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/mainline" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0" },
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" },
  ]) {
    expect(module.runDecision(env)).toBe("full");
    const github = fakeGitHub([[sourceRun()]], sourceJobs(module));
    expect(
      await module.findSameCommitRun({
        env: { ...mainPush, ...env },
        ...github,
      }),
    ).toEqual({ full: "true", source_run: "" });
    expect(github.calls).toEqual([]);
  }
  expect(module.runDecision(mainPush)).toBe("look");
  // A main commit that develop never ran gets the full checks after a short wait.
  const absent = fakeGitHub([[]], sourceJobs(module));
  expect(await module.findSameCommitRun({ env: mainPush, ...absent })).toEqual({
    full: "true",
    source_run: "",
  });
  expect(absent.now()).toBeGreaterThanOrEqual(
    module.sameCommitTiming.appearSeconds * 1000,
  );
  // With full checks, a skipped check job still fails the aggregate.
  const full = Object.fromEntries(
    [...Object.keys(module.requiredJobs), "macos"].map((id) => [
      id,
      { result: "success" },
    ]),
  );
  full.dedupe = {
    result: "success",
    outputs: { full: "true", source_run: "" },
  };
  expect(module.checkRequired(full)).toBe("full");
  full.linux = { result: "skipped" };
  expect(() => module.checkRequired(full)).toThrow();
}

it("skips repeated checks only with proof of a passing run of the same commit", async () => {
  await proofIsRequired(checkRequiredModule);
});

it("runs the full checks on every ref and event except a push to main", async () => {
  await otherRefsRunFull(checkRequiredModule);
});

const sameCommitMutants = [
  [
    "skipped checks accepted without a source run",
    'if (!runUrl.test(proof.outputs?.source_run ?? ""))',
    "if (false)",
    proofIsRequired,
  ],
  [
    "skipped checks accepted after a failed same-commit job",
    'if (proof?.result !== "success")',
    "if (false)",
    proofIsRequired,
  ],
  [
    "a failed macOS summary accepted as proof",
    'matching[0].conclusion !== "success"',
    "false",
    proofIsRequired,
  ],
  [
    "develop pushes that skip the checks",
    'env.GITHUB_REF === "refs/heads/main"',
    'env.GITHUB_REF.startsWith("refs/heads/")',
    otherRefsRunFull,
  ],
  [
    "manual and pull request runs on main that skip the checks",
    'env.GITHUB_EVENT_NAME === "push" &&',
    "",
    otherRefsRunFull,
  ],
  [
    "a main commit without a develop run that skips the checks",
    'return { full: "true", source_run: "" };\n    } else {',
    'return { full: "false", source_run: "" };\n    } else {',
    otherRefsRunFull,
  ],
];

it.each(sameCommitMutants)(
  "negative control: a planted mutant is caught: %s",
  async (_name, before, after, check) => {
    const source = await readFile(
      join(root, ".github/check-required.mjs"),
      "utf8",
    );
    expect(source.split(before)).toHaveLength(2);
    const directory = await mkdtemp(join(tmpdir(), "openplans-same-commit-"));
    try {
      const path = join(directory, "check-required.mjs");
      await writeFile(path, source.replace(before, after));
      const mutant = await import(pathToFileURL(path).href);
      await expect(check(mutant)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("gives every lint entry point an explicit 4096 MB heap", async () => {
  // Type-aware lint peaks near 2.4 GB of JS heap. Runner defaults differ (about 2 GB in a 4 GB
  // container), so the scripts set the heap on the node command line, which works on every OS
  // and takes precedence over NODE_OPTIONS.
  const { scripts } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const heap = "node --max-old-space-size=4096 ";
  for (const name of ["lint", "lint:prune", "check:lint-setup"]) {
    const commands = scripts[name].split("&&").map((part) => part.trim());
    for (const command of commands) expect(command.startsWith(heap)).toBe(true);
  }
  expect(scripts.lint).toContain(`${heap}node_modules/eslint/bin/eslint.js .`);
  expect(scripts.lint).toContain(`${heap}scripts/lint-baseline.mjs`);
  expect(JSON.stringify(scripts)).not.toMatch(/(^|[" &])eslint /);
});
