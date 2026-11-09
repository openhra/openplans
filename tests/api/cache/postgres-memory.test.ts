import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory: string, script: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-memory-profile-"));
  const compose = await readFile(
    new URL("../../../compose.yml", import.meta.url),
    "utf8",
  );
  const source = compose
    .split("# BEGIN MEMORY PROFILE\n")[1]!
    .split("# END MEMORY PROFILE")[0]!
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .replaceAll("$$", "$");
  script = join(directory, "openplans-postgres");
  await writeFile(script, source);
  const entrypoint = join(directory, "docker-entrypoint.sh");
  await writeFile(entrypoint, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(entrypoint, 0o755);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function profile(memory?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
  };
  delete env.OPENPLANS_DB_MEMORY;
  if (memory !== undefined) env.OPENPLANS_DB_MEMORY = memory;
  return execFileSync("sh", [script], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
describe("one-knob Postgres budget", () => {
  it("defaults conservatively, scales buffers and bounds connections and per-query work memory", () => {
    expect(profile()).toContain("shared_buffers=256MB");
    expect(profile()).toContain("max_connections=32");
    for (const [budget, shared, effective, work, maintenance, connections] of [
      ["2g", 512, 1433, 2, 204, 64],
      ["4g", 1024, 2867, 2, 409, 100],
      ["8g", 2048, 5734, 5, 819, 100],
      ["16g", 4096, 11468, 10, 1024, 100],
    ] as const) {
      const actual = profile(budget);
      for (const setting of [
        `shared_buffers=${shared}MB`,
        `effective_cache_size=${effective}MB`,
        `work_mem=${work}MB`,
        `maintenance_work_mem=${maintenance}MB`,
        `max_connections=${connections}`,
      ])
        expect(actual).toContain(setting);
    }
    expect(profile("512m")).toContain("max_connections=20");
    expect(profile("256g")).toContain("work_mem=32MB");
  });
  it("negative controls reject malformed, tiny and absurd budgets instead of launching Postgres", () => {
    for (const budget of [
      "0g",
      "1",
      "1.5g",
      "1g;false",
      "10MB",
      "01g",
      "511m",
      "257g",
      "9999999999999999999g",
    ]) {
      expect(() => profile(budget)).toThrow();
    }
  });
});
