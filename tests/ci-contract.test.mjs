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
import {
  checkRequired,
  macosShardJobs,
  requiredJobs,
} from "../.github/check-required.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = JSON.parse(
  await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
);
const installNpm =
  'npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund';
const verifyVersions =
  'test "$(node --version)" = "v$(cat .node-version)"\ntest "$(npm --version)" = "$(cat .github/npm-version)"';
const retiredRunnerLabels = ["macos-13", "macos-14"];

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
  expect(value.on).toEqual({
    push: null,
    pull_request: null,
    workflow_dispatch: null,
  });
  expect(value.permissions).toEqual({ contents: "read" });
  expect(value.defaults).toEqual({ run: { shell: "bash" } });
  expect(Object.keys(value.jobs).sort()).toEqual([
    "docker",
    "linux",
    "macos",
    "macos-shard",
    "required",
  ]);
  for (const id of ["linux", "docker"]) {
    const job = value.jobs[id];
    expect(job.name).toBe(requiredJobs[id]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toBeUndefined();
  }
  // macOS runs the project checks as a matrix of test shards on separate runners. Each shard
  // tells ci.sh its slice; the count comes from the matrix itself, so the slices always cover
  // every test file exactly once.
  const shard = value.jobs["macos-shard"];
  expect(shard.name).toBe("OpenPlans / macOS shard ${{ matrix.shard }}");
  expect(shard["runs-on"]).toBe("macos-15-intel");
  expect(retiredRunnerLabels).not.toContain(shard["runs-on"]);
  expect(shard["timeout-minutes"]).toBeLessThanOrEqual(45);
  expect(shard.if).toBeUndefined();
  expect(shard.needs).toBeUndefined();
  expect(Object.keys(shard.strategy).sort()).toEqual(["fail-fast", "matrix"]);
  expect(shard.strategy["fail-fast"]).toBe(false);
  expect(Object.keys(shard.strategy.matrix)).toEqual(["shard"]);
  const slices = shard.strategy.matrix.shard;
  expect(slices.length).toBeGreaterThan(1);
  expect(slices).toEqual(slices.map((_, index) => index + 1));
  // The macOS check name the release tooling requires belongs to a summary job that fails
  // unless every shard succeeded.
  const macos = value.jobs.macos;
  expect(macos.name).toBe(requiredJobs.macos);
  expect(macos["runs-on"]).toBe("ubuntu-24.04");
  expect(macos.if).toBe("${{ always() }}");
  expect(macos.needs).toEqual(Object.keys(macosShardJobs));
  expect(macos.strategy).toBeUndefined();
  expect(macos.steps).toHaveLength(3);
  expect(macos.steps[1].with).toEqual({ "node-version-file": ".node-version" });
  expect(macos.steps[2].run).toBe("node .github/check-required.mjs macos");
  expect(macos.steps[2].env).toEqual({ NEEDS_RESULTS: "${{ toJSON(needs) }}" });
  for (const step of macos.steps) expect(step.if).toBeUndefined();
  for (const job of Object.values(value.jobs)) {
    expect(job["continue-on-error"]).toBeUndefined();
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
    expect(steps).toHaveLength(6);
    expect(steps[1].uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(steps[1].with).toEqual({ "node-version-file": ".node-version" });
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      installNpm,
      verifyVersions,
      "npm ci --no-audit --no-fund",
      "scripts/ci.sh",
    ]);
    expect(steps[5].env).toEqual(
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
  expect(docker).toHaveLength(4);
  expect(docker[1].run).toBe(
    "docker build --pull --tag openplans-ci:${{ github.sha }} .",
  );
  expect(docker[2].run).toBe(
    "docker run --rm --network none openplans-ci:${{ github.sha }} node --check dist/api/server.js",
  );
  for (const step of docker.slice(0, 3)) expect(step.if).toBeUndefined();
  expect(docker[3].if).toBe("${{ always() }}");
  const required = value.jobs.required;
  expect(required.name).toBe("OpenPlans / required");
  expect(required.if).toBe("${{ always() }}");
  expect(required.needs).toEqual(Object.keys(requiredJobs));
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

it("runs clean extracted-root checks on both platforms and builds the Linux artifact", () => {
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
  expect(config.test.include).toContain("plugins/*/tests/**/*.test.ts");
});

const installScripts = ["preinstall", "install", "postinstall", "prepare"];

// npm does not order workspace lifecycle scripts by dependency, so during `npm ci` a plugin's
// install-time build can run before the SDK exists. Only the SDK may build on install, and
// plugins may depend on no workspace package but the SDK, so "SDK first, then the rest" holds.
function installOrderProblems(packages, sdkName) {
  const names = new Set(packages.map(({ manifest }) => manifest.name));
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
        if (names.has(name) && name !== sdkName)
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
  const ignore = await readFile(join(root, ".dockerignore"), "utf8");
  for (const path of ["**/node_modules", "**/dist", "**/.env", "**/.env.*"]) {
    expect(ignore.split("\n")).toContain(path);
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
      copy.jobs["macos-shard"].steps[5].if = "${{ false }}";
    },
  ],
  [
    "macOS shards that skip the project checks",
    (copy) => {
      delete copy.jobs["macos-shard"].steps[5].env.OPENPLANS_CI_SHARD;
    },
  ],
  [
    "a fixed shard count that can drift from the matrix",
    (copy) => {
      copy.jobs["macos-shard"].steps[5].env.OPENPLANS_CI_SHARD =
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
    "unlocked install",
    (copy) => {
      copy.jobs.linux.steps[4].run = "npm install";
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
      copy.jobs.linux.steps[5]["working-directory"] = "source-package";
    },
  ],
  [
    "filtered workflow",
    (copy) => {
      copy.on.push = { paths: ["src/**"] };
    },
  ],
])("negative control: rejects %s", (_name, mutate) => {
  const copy = structuredClone(workflow);
  mutate(copy);
  expect(() => commandContract(copy)).toThrow();
});

const successful = () =>
  Object.fromEntries(
    Object.keys(requiredJobs).map((id) => [
      id,
      { result: "success", outputs: {} },
    ]),
  );
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
});

it("accepts only successful macOS shards", () => {
  const shards = { "macos-shard": { result: "success", outputs: {} } };
  expect(() => checkRequired(shards, macosShardJobs)).not.toThrow();
  for (const status of [
    "skipped",
    "failure",
    "cancelled",
    "pending",
    undefined,
  ]) {
    expect(() =>
      checkRequired(
        { "macos-shard": { result: status, outputs: {} } },
        macosShardJobs,
      ),
    ).toThrow("OpenPlans / macOS shards did not succeed");
  }
  for (const value of [null, {}, successful(), { ...shards, extra: {} }]) {
    expect(() => checkRequired(value, macosShardJobs)).toThrow(
      "missing or unexpected",
    );
  }
});

it.each([
  [["macos"], JSON.stringify({ "macos-shard": { result: "success" } }), 0],
  [["macos"], JSON.stringify({ "macos-shard": { result: "failure" } }), 1],
  [["macos"], JSON.stringify(successful()), 1],
  [[], JSON.stringify({ "macos-shard": { result: "success" } }), 1],
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
  // Every shard builds: the build sits after the static block, not inside it.
  expect(ci).toContain("  npm run check:extraction\nfi\nnpm run build\n");
});

it.each([
  [JSON.stringify(successful()), 0],
  [JSON.stringify({ ...successful(), macos: { result: "skipped" } }), 1],
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
