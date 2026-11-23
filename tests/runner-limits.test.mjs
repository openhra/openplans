// scripts/ci.sh --hosted runs every step under a hosted runner's limits from
// .github/runner-limits.json; CI's "Check runner limits" step keeps that file true.
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  compareLimits,
  loadLimits,
  runnerWorkers,
} from "../.github/runner-limits.mjs";
import { testWorkers } from "../vitest.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pinned = (await readFile(join(root, ".node-version"), "utf8")).trim();
const here = process.version.slice(1);
const temps = [];
afterEach(async () => {
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function heapLimit(args = []) {
  const result = spawnSync(
    process.execPath,
    [...args, "-p", "require('v8').getHeapStatistics().heap_size_limit"],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  return Number(result.stdout.trim());
}

// A copy of ci.sh and the limits files, with an npm stand-in that records what each step saw.
// `node` is the real one; `version` is what .node-version and the file pin.
async function sandbox({ version = here, limits, npmBody } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openplans-hosted-"));
  temps.push(dir);
  await mkdir(join(dir, "scripts"));
  await mkdir(join(dir, ".github"));
  await mkdir(join(dir, "bin"));
  await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
  await copyFile(join(root, "scripts/ci.sh"), join(dir, "scripts/ci.sh"));
  await chmod(join(dir, "scripts/ci.sh"), 0o755);
  await copyFile(
    join(root, ".github/runner-limits.mjs"),
    join(dir, ".github/runner-limits.mjs"),
  );
  const file = limits ?? loadLimits(join(root, ".github/runner-limits.json"));
  for (const entry of Object.values(file)) entry.node_version = version;
  await writeFile(
    join(dir, ".github/runner-limits.json"),
    JSON.stringify(file, null, 2),
  );
  await writeFile(join(dir, ".node-version"), `${version}\n`);
  for (const tool of ["tsc", "vitest"]) {
    await writeFile(join(dir, "node_modules/.bin", tool), "#!/bin/sh\n");
    await chmod(join(dir, "node_modules/.bin", tool), 0o755);
  }
  await writeFile(
    join(dir, "bin/npm"),
    `#!/bin/sh\necho "npm $*" >> "${dir}/npm.calls"\n` +
      (npmBody ??
        `node -p "require('v8').getHeapStatistics().heap_size_limit" >> "${dir}/heap"\n` +
          `echo "\${OPENPLANS_TEST_WORKERS:-unset}" >> "${dir}/workers"\n`),
  );
  await chmod(join(dir, "bin/npm"), 0o755);
  const run = (args, env = {}) =>
    spawnSync("bash", ["scripts/ci.sh", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        NODE_OPTIONS: "",
        OPENPLANS_TEST_WORKERS: "",
        OPENPLANS_CI_SHARD: "2/3",
        ...env,
      },
    });
  const read = async (name) => {
    try {
      return (await readFile(join(dir, name), "utf8")).trim().split("\n");
    } catch {
      return [];
    }
  };
  return { dir, run, read };
}

it("commits limits for both hosted runners, on the pinned Node", () => {
  const limits = loadLimits();
  expect(Object.keys(limits).sort()).toEqual(["linux", "macos"]);
  for (const entry of Object.values(limits))
    expect(entry.node_version).toBe(pinned);
  // Measured on run 45014343582: eslint died at 2096 MB total heap on macos-15-intel (14 GB).
  expect(limits.macos.node_heap_limit_mb).toBe(2048);
});

it("gives the worker count vitest.config.ts picks on the runner's CPUs", () => {
  for (let count = 1; count <= 64; count += 1)
    expect(runnerWorkers(count)).toBe(testWorkers({}, count));
});

it("runs every step under the runner's heap cap and worker count", async () => {
  const limits = loadLimits();
  const box = await sandbox();
  const result = box.run(["--hosted", "macos"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    `heap cap ${limits.macos.node_heap_limit_mb} MB`,
  );
  const expected = heapLimit([
    `--max-old-space-size=${limits.macos.node_heap_limit_mb}`,
  ]);
  const heaps = await box.read("heap");
  expect(heaps).toHaveLength(2); // build and the test shard
  for (const value of heaps) expect(Number(value)).toBe(expected);
  expect(await box.read("workers")).toEqual(
    Array(2).fill(String(runnerWorkers(limits.macos.cpus))),
  );
});

it("leaves the heap and workers alone without --hosted", async () => {
  const box = await sandbox();
  const result = box.run([]);
  expect(result.status, result.stderr).toBe(0);
  for (const value of await box.read("heap"))
    expect(Number(value)).toBe(heapLimit());
  expect(await box.read("workers")).toEqual(["unset", "unset"]);
});

it("refuses a Node other than the pinned one before any step", async () => {
  const box = await sandbox({ version: "0.0.1" });
  const result = box.run(["--hosted", "macos"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("is not the pinned v0.0.1");
  expect(await box.read("npm.calls")).toEqual([]);
});

it.each([
  [["--hosted", "windows"], "unknown runner 'windows'"],
  [["--hosted"], "--hosted needs a runner"],
  [["--fast"], "unknown argument '--fast'"],
])("exits 2 on %j", async (args, message) => {
  const box = await sandbox();
  const result = box.run(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(message);
  expect(await box.read("npm.calls")).toEqual([]);
});

it("names a step that dies on the heap cap", async () => {
  const limits = loadLimits();
  limits.macos.node_heap_limit_mb = 32;
  const box = await sandbox({
    limits,
    npmBody:
      `case "$*" in run\\ build) exit 0;; esac\n` +
      `exec node -e "const a = []; for (;;) a.push(new Array(1e5).fill(1))"\n`,
  });
  const result = box.run(["--hosted", "macos"]);
  expect(result.status).toBe(134);
  expect(result.stdout).toContain("JavaScript heap out of memory");
  expect(result.stderr).toContain("ci.sh: node heap exhausted (cap 32 MB)");
});

it("does not call any other failure a heap exhaustion, even one that quotes the message", async () => {
  const box = await sandbox({
    npmBody:
      'echo "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"\nexit 3\n',
  });
  const result = box.run(["--hosted", "macos"]);
  expect(result.status).toBe(3);
  expect(result.stderr).not.toContain("heap exhausted");
});

const runner = {
  image: "macos-15-intel",
  cpus: 4,
  mem_mb: 14336,
  node_heap_limit_mb: 2048,
  node_version: pinned,
};
const matching = {
  cpus: 4,
  mem_mb: 14336,
  heap_limit_bytes: 2197815296,
  capped_heap_limit_bytes: 2197815296,
  node_version: `v${pinned}`,
};

it("accepts a runner that matches its entry, memory within 10%", () => {
  expect(compareLimits(runner, matching)).toEqual([]);
  expect(compareLimits(runner, { ...matching, mem_mb: 13500 })).toEqual([]);
});

it.each([
  ["cpus", { cpus: 3 }],
  ["mem_mb", { mem_mb: 143360 }],
  ["node_heap_limit_mb", { heap_limit_bytes: 4345298944 }],
  ["node_version", { node_version: "v26.5.0" }],
])("negative control: flags a drifted %s", (field, change) => {
  const problems = compareLimits(runner, { ...matching, ...change });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(new RegExp(`^${field}:`));
});

it("negative control: the check step fails on a planted file with 10x the memory", async () => {
  const limits = loadLimits();
  // Match this machine on everything but memory.
  limits.macos.cpus = cpus().length;
  limits.macos.mem_mb = Math.round(totalmem() / 1024 / 1024) * 10;
  const box = await sandbox({ limits });
  const result = spawnSync(
    process.execPath,
    [join(box.dir, ".github/runner-limits.mjs"), "check", "macos"],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("os.totalmem()");
  expect(result.stderr).toMatch(
    /out of date: mem_mb: runner has \d+, file says \d+/,
  );
});
