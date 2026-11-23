// The hosted runners' limits, read from runner-limits.json next to this file.
//
//   node .github/runner-limits.mjs check <runner>  CI's "Check runner limits" step: prints what the
//                                                  runner has and fails when it differs from the file.
//   node .github/runner-limits.mjs env <runner>    scripts/ci.sh --hosted: prints the heap cap and
//                                                  test worker count to run under, or exits 2 when
//                                                  this Node is not the pinned one.
//
// node_heap_limit_mb is V8's default old-space limit on that runner, the value
// --max-old-space-size takes. The check compares the runner's default heap limit with the limit
// under --max-old-space-size=<node_heap_limit_mb>; equal means the cap reproduces the runner.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

const here = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
const fields = [
  "image",
  "cpus",
  "mem_mb",
  "node_heap_limit_mb",
  "node_version",
];
// Runners report a little less memory than they are sold with; 10% covers that and still
// catches a wrong machine class.
export const memoryTolerance = 0.1;

export function loadLimits(file = join(here, "runner-limits.json")) {
  const limits = JSON.parse(readFileSync(file, "utf8"));
  for (const [runner, entry] of Object.entries(limits)) {
    const keys = Object.keys(entry).sort();
    if (keys.join() !== [...fields].sort().join())
      throw new Error(`${runner}: fields must be ${fields.join(", ")}`);
    for (const field of ["cpus", "mem_mb", "node_heap_limit_mb"])
      if (!Number.isInteger(entry[field]) || entry[field] < 1)
        throw new Error(`${runner}: ${field} must be a positive whole number`);
    if (!/^\d+\.\d+\.\d+$/.test(entry.node_version))
      throw new Error(`${runner}: node_version must be x.y.z`);
  }
  return limits;
}

export function runnerLimits(runner, limits = loadLimits()) {
  if (!Object.hasOwn(limits, runner))
    throw new Error(
      `unknown runner '${runner}'; expected one of ${Object.keys(limits).join(", ")}`,
    );
  return limits[runner];
}

// The worker count vitest.config.ts picks on a machine with this many CPUs.
export function runnerWorkers(cpuCount) {
  return Math.max(1, Math.min(3, Math.floor(cpuCount / 3)));
}

function heapLimitBytes(args) {
  const result = spawnSync(
    process.execPath,
    [...args, "-p", "require('v8').getHeapStatistics().heap_size_limit"],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed`);
  return Number(result.stdout.trim());
}

export function measure(expected) {
  return {
    cpus: cpus().length,
    mem_mb: Math.round(totalmem() / MiB),
    heap_limit_bytes: process.env.NODE_OPTIONS
      ? heapLimitBytes([])
      : getHeapStatistics().heap_size_limit,
    capped_heap_limit_bytes: heapLimitBytes([
      `--max-old-space-size=${expected.node_heap_limit_mb}`,
    ]),
    node_version: process.version,
  };
}

export function compareLimits(expected, measured) {
  const problems = [];
  if (measured.cpus !== expected.cpus)
    problems.push(
      `cpus: runner has ${measured.cpus}, file says ${expected.cpus}`,
    );
  if (
    Math.abs(measured.mem_mb - expected.mem_mb) >
    expected.mem_mb * memoryTolerance
  )
    problems.push(
      `mem_mb: runner has ${measured.mem_mb}, file says ${expected.mem_mb} (±${memoryTolerance * 100}%)`,
    );
  if (measured.heap_limit_bytes !== measured.capped_heap_limit_bytes)
    problems.push(
      `node_heap_limit_mb: the runner's default heap limit is ${measured.heap_limit_bytes} bytes, ` +
        `--max-old-space-size=${expected.node_heap_limit_mb} gives ${measured.capped_heap_limit_bytes}`,
    );
  if (measured.node_version !== `v${expected.node_version}`)
    problems.push(
      `node_version: runner has ${measured.node_version}, file says v${expected.node_version}`,
    );
  return problems;
}

export function pinnedNode(root = join(here, "..")) {
  return readFileSync(join(root, ".node-version"), "utf8").trim();
}

function main([command, runner]) {
  let expected;
  try {
    expected = runnerLimits(runner);
  } catch (error) {
    console.error(`runner-limits: ${error.message}`);
    return 2;
  }
  if (command === "check") {
    const measured = measure(expected);
    console.log(
      `runner ${runner} (${expected.image}), ImageOS ${process.env.ImageOS ?? "unset"}`,
    );
    console.log(`os.cpus().length ${measured.cpus}`);
    console.log(`os.totalmem() ${measured.mem_mb} MB`);
    console.log(
      `v8 heap_size_limit ${measured.heap_limit_bytes} bytes (${(measured.heap_limit_bytes / MiB).toFixed(1)} MB)`,
    );
    console.log(
      `v8 heap_size_limit under --max-old-space-size=${expected.node_heap_limit_mb}: ${measured.capped_heap_limit_bytes} bytes`,
    );
    console.log(`node --version ${measured.node_version}`);
    const problems = compareLimits(expected, measured);
    for (const problem of problems)
      console.error(`runner-limits.json is out of date: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "env") {
    const pinned = pinnedNode();
    if (process.version !== `v${pinned}` || expected.node_version !== pinned) {
      console.error(
        `ci.sh --hosted ${runner}: node ${process.version} is not the pinned v${pinned} ` +
          `(.node-version; runner-limits.json says v${expected.node_version})`,
      );
      return 2;
    }
    console.log(`cap_mb=${expected.node_heap_limit_mb}`);
    console.log(`workers=${runnerWorkers(expected.cpus)}`);
    return 0;
  }
  console.error("usage: runner-limits.mjs check|env <runner>");
  return 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  process.exitCode = main(process.argv.slice(2));
