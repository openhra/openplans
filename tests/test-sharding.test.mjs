import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import TimedSequencer, {
  balancedShards,
  orderedFiles,
  readTimings,
} from "../scripts/test-sequencer.js";
import { timingFile } from "../scripts/test-timings.mjs";

const files = [
  "tests/a.test.ts",
  "tests/b.test.ts",
  "tests/c.test.ts",
  "tests/d.test.ts",
  "plugins/sdk/tests/e.test.ts",
];
const timings = Object.fromEntries(
  files.map((file, index) => [file, [100, 80, 40, 30, 10][index]]),
);

function assertPartition(shards, input) {
  const all = shards.flat();
  expect(all.length).toBe(input.length);
  expect(new Set(all).size).toBe(input.length);
  expect([...all].sort()).toEqual([...input].sort());
}

it("balances the longest files and ignores discovery order", () => {
  const shards = balancedShards(files, timings, 2);
  expect(shards).toEqual([
    [files[0], files[3]],
    [files[1], files[2], files[4]],
  ]);
  expect(balancedShards([...files].reverse(), timings, 2)).toEqual(shards);
  expect(
    shards.map((shard) => shard.reduce((sum, file) => sum + timings[file], 0)),
  ).toEqual([130, 130]);
});

it.each([1, 2, 3, 8])(
  "partitions every file exactly once across %i shards, including new and skipped files",
  (count) => {
    const input = [...files, "tests/new.test.ts", "tests/skipped.test.ts"];
    const shards = balancedShards(
      input,
      { ...timings, "tests/skipped.test.ts": 0 },
      count,
    );
    assertPartition(shards, input);
    expect(
      balancedShards(
        input.slice().reverse(),
        { ...timings, "tests/skipped.test.ts": 0 },
        count,
      ),
    ).toEqual(shards);
  },
);

it("uses paths and shard index to resolve equal weights", () => {
  expect(balancedShards(files.slice(0, 4).reverse(), {}, 2)).toEqual([
    [files[0], files[2]],
    [files[1], files[3]],
  ]);
  expect(orderedFiles(files.slice().reverse(), timings)).toEqual(files);
});

it.each([0, -1, 1.5, NaN, Infinity])(
  "rejects invalid shard count %j",
  (count) => {
    expect(() => balancedShards(files, timings, count)).toThrow(
      "positive safe integer",
    );
  },
);

it("rejects duplicate files instead of running a check twice", () => {
  expect(() => balancedShards([...files, files[0]], timings, 2)).toThrow(
    "Duplicate test file",
  );
});

it("the partition check rejects a missing, duplicate or extra file", () => {
  for (const mutant of [
    [[files[0]], files.slice(2)],
    [[files[0]], files],
    [files, ["tests/unexpected.test.ts"]],
  ])
    expect(() => assertPartition(mutant, files)).toThrow();
});

function report(values) {
  return {
    testResults: files.map((file, index) => ({
      name: `/temporary/worktree/openplans/${file}`,
      startTime: 1000,
      endTime: 1000 + values[index],
    })),
  };
}

it("takes medians of three full JSON runs without storing checkout paths", () => {
  const result = timingFile([
    report([4, 10, 0, 90, 1]),
    report([6, 20, 0, 70, 2]),
    report([100, 15, 0, 80, 3]),
  ]);
  expect(result.runs).toBe(3);
  expect(result.files).toEqual(
    Object.fromEntries(
      files.map((file, index) => [file, [6, 15, 0, 80, 2][index]]),
    ),
  );
  expect(JSON.stringify(result)).not.toContain("worktree");
});

it("rejects incomplete or malformed timing evidence", () => {
  const valid = report([1, 2, 3, 4, 5]);
  const missing = structuredClone(valid);
  missing.testResults.pop();
  const duplicate = structuredClone(valid);
  duplicate.testResults.push(duplicate.testResults[0]);
  const negative = structuredClone(valid);
  negative.testResults[0].endTime = 0;
  for (const reports of [
    [valid],
    [valid, valid, missing],
    [valid, valid, duplicate],
    [valid, valid, negative],
  ])
    expect(() => timingFile(reports)).toThrow();
});

it("rejects corrupted checked-in timings", () => {
  const dir = mkdtempSync(join(tmpdir(), "openplans-timing-control-"));
  const path = join(dir, "timings.json");
  try {
    for (const data of [
      { version: 2, files: timings },
      { version: 1, files: 10 },
      { version: 1, files: {} },
      { version: 1, files: { "tests/a.test.ts": -1 } },
      { version: 1, files: { "tests/a.test.ts": "10" } },
    ]) {
      writeFileSync(path, JSON.stringify(data));
      expect(() => readTimings(pathToFileURL(path))).toThrow();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("Vitest uses the balanced assignment and duration order for the full suite", async () => {
  const root = "/temporary/worktree/openplans";
  const measured = JSON.parse(
    readFileSync(
      new URL("../scripts/test-timings.json", import.meta.url),
      "utf8",
    ),
  ).files;
  const input = Object.keys(measured).map((file) => ({
    moduleId: `${root}/${file}`,
  }));
  const partitions = [];
  for (let index = 1; index <= 3; index++) {
    const sequencer = new TimedSequencer({
      config: { root, shard: { index, count: 3 } },
    });
    const actual = await sequencer.shard(input);
    partitions.push(actual.map((file) => file.moduleId));
    expect(
      actual.map((file) => file.moduleId.slice(root.length + 1)).sort(),
    ).toEqual(
      balancedShards(Object.keys(measured), measured, 3)
        [index - 1].slice()
        .sort(),
    );
    const sorted = await sequencer.sort(input);
    expect(sorted.map((file) => file.moduleId.slice(root.length + 1))).toEqual(
      orderedFiles(Object.keys(measured), measured),
    );
  }
  assertPartition(
    partitions,
    input.map((file) => file.moduleId),
  );
});

function assertOracleIsolation(config) {
  expect(config.test.include).toBeUndefined();
  const [parallel, isolated] = config.test.projects;
  expect(isolated.extends).toBe(true);
  expect(parallel.extends).toBe(true);
  expect(isolated.test.include).toEqual([
    "tests/plugins/passthrough-wiring.test.ts",
    "tests/oracle/harness.test.mjs",
  ]);
  for (const file of isolated.test.include)
    expect(parallel.test.exclude).toContain(file);
  expect(isolated.test.maxWorkers).toBe(1);
  expect(isolated.test.fileParallelism).toBe(false);
  expect(parallel.test.sequence.groupOrder).toBeGreaterThan(0);
  expect(isolated.test.sequence.groupOrder).toBeGreaterThan(
    parallel.test.sequence.groupOrder,
  );
  expect(config.test.testTimeout).toBe(20_000);
  expect(config.test.hookTimeout).toBe(30_000);
}

it("isolates CPU and I/O heavy oracles without changing assertions or timeouts", async () => {
  const { default: config } = await import("../vitest.config.ts");
  assertOracleIsolation(config);
  for (const mutate of [
    (copy) => {
      copy.test.projects[1].test.maxWorkers = 2;
    },
    (copy) => {
      copy.test.projects[1].test.sequence.groupOrder = 1;
    },
    (copy) => {
      copy.test.projects[0].test.exclude = [];
    },
    (copy) => {
      copy.test.testTimeout = 60_000;
    },
    (copy) => {
      copy.test.include = ["tests/**/*.test.ts"];
    },
  ]) {
    const copy = {
      test: { ...config.test, projects: structuredClone(config.test.projects) },
    };
    mutate(copy);
    expect(() => assertOracleIsolation(copy)).toThrow();
  }
});
