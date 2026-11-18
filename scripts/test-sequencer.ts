import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

export type Timings = Record<string, number>;

export function readTimings(path: URL): Timings {
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    files: Timings;
  };
  if (
    data.version !== 1 ||
    !data.files ||
    typeof data.files !== "object" ||
    Array.isArray(data.files) ||
    Object.keys(data.files).length === 0
  )
    throw new Error("Invalid test timing file");
  for (const [file, ms] of Object.entries(data.files)) {
    if (!/^(tests|plugins)\//.test(file) || !Number.isFinite(ms) || ms < 0)
      throw new Error(`Invalid test timing: ${file}`);
  }
  return data.files;
}

function weights(timings: Timings): (file: string) => number {
  const known = Object.values(timings)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] ?? 1000;
  return (file) => Math.max(1, timings[file] ?? fallback);
}

export function orderedFiles(files: string[], timings: Timings): string[] {
  const weight = weights(timings);
  return [...files].sort((a, b) => {
    const difference = weight(b) - weight(a);
    if (difference !== 0) return difference;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/** Longest files first, assigning each to the lightest shard with stable path/index ties. */
export function balancedShards(
  files: string[],
  timings: Timings,
  count: number,
): string[][] {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Shard count must be a positive safe integer");
  if (new Set(files).size !== files.length)
    throw new Error("Duplicate test file");
  const weight = weights(timings);
  const shards = Array.from({ length: count }, () => [] as string[]);
  const totals = Array.from({ length: count }, () => 0);
  for (const file of orderedFiles(files, timings)) {
    let target = 0;
    for (let index = 1; index < count; index++)
      if (totals[index]! < totals[target]!) target = index;
    shards[target]!.push(file);
    totals[target]! += weight(file);
  }
  return shards;
}

export default class TimedSequencer extends BaseSequencer {
  private timings = readTimings(
    new URL("./test-timings.json", import.meta.url),
  );

  private path(file: TestSpecification): string {
    return relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
  }

  override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const selected = new Set(
      balancedShards(
        files.map((file) => this.path(file)),
        this.timings,
        count,
      )[index - 1],
    );
    return files.filter((file) => selected.has(this.path(file)));
  }

  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const order = new Map(
      orderedFiles(
        files.map((file) => this.path(file)),
        this.timings,
      ).map((file, index) => [file, index]),
    );
    return [...files].sort(
      (a, b) => order.get(this.path(a))! - order.get(this.path(b))!,
    );
  }
}
