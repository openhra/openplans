import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { leaseHost } from "../../src/fetch/limiter.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-host-lease-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("serializes two independent processes and leaves unrelated hosts available", async () => {
  const sourceRoot = new URL("../../src/fetch/", import.meta.url);
  for (const name of ["limiter", "errors"]) {
    const source = await readFile(new URL(`${name}.ts`, sourceRoot), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    });
    await writeFile(join(directory, `${name}.js`), result.outputText);
  }
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const script = join(directory, "child.mjs");
  await writeFile(
    script,
    `
    import { leaseHost } from './limiter.js';
    const release = await leaseHost(process.argv[2], 'publisher.test');
    const started = Date.now();
    await new Promise(resolve => setTimeout(resolve, 25));
    const ended = Date.now();
    await release();
    console.log(JSON.stringify({started, ended}));
  `,
  );
  const execute = promisify(execFile);
  const first = execute(process.execPath, [script, directory]);
  const second = execute(process.execPath, [script, directory]);
  const releaseOther = await leaseHost(directory, "other.test");
  await releaseOther();
  const runs = (await Promise.all([first, second]))
    .map((run) => JSON.parse(run.stdout) as { started: number; ended: number })
    .sort((a, b) => a.started - b.started);
  expect(runs[1]!.started).toBeGreaterThanOrEqual(runs[0]!.ended);
  expect(runs[1]!.started - runs[0]!.started).toBeGreaterThanOrEqual(5000);
  expect(
    (await readdir(join(directory, "access", "hosts"))).some((name) =>
      name.endsWith(".lock"),
    ),
  ).toBe(false);
});

it("uses a longer publisher delay even when the previous job used the default", async () => {
  const host = "publisher.test";
  const hosts = join(directory, "access", "hosts");
  await mkdir(hosts, { recursive: true });
  const key = createHash("sha256").update(host).digest("hex");
  const schedule = join(hosts, `${key}.json`);
  const lastRequestAt = Date.now() - 29_750;
  await writeFile(
    schedule,
    JSON.stringify({ lastRequestAt, nextRequestAt: lastRequestAt + 5000 }),
  );
  const release = await leaseHost(directory, host, 30_000);
  expect(Date.now() - lastRequestAt).toBeGreaterThanOrEqual(30_000);
  const state = JSON.parse(await readFile(schedule, "utf8")) as {
    lastRequestAt: number;
    nextRequestAt: number;
  };
  expect(state.nextRequestAt - state.lastRequestAt).toBeGreaterThanOrEqual(
    30_000,
  );
  expect(state.nextRequestAt - state.lastRequestAt).toBeLessThan(31_000);
  await release();
});

it("rejects corrupted pacing state without silently resetting the host limit", async () => {
  const release = await leaseHost(directory, "publisher.test");
  await release();
  const hosts = join(directory, "access", "hosts");
  const schedule = (await readdir(hosts)).find((name) =>
    name.endsWith(".json"),
  )!;
  await writeFile(
    join(hosts, schedule),
    '{"nextRequestAt":"synthetic-corruption"}',
  );
  await expect(leaseHost(directory, "publisher.test")).rejects.toMatchObject({
    code: "admission_denied",
  });
  expect((await readdir(hosts)).some((name) => name.endsWith(".lock"))).toBe(
    false,
  );
});

it("holds an abandoned lease without deleting another process's lock", async () => {
  const hosts = join(directory, "access", "hosts");
  const key = createHash("sha256").update("publisher.test").digest("hex");
  await mkdir(join(hosts, `${key}.lock`), { recursive: true });
  const now = Date.now();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(now)
    .mockReturnValue(now + 60_001);
  try {
    await expect(leaseHost(directory, "publisher.test")).rejects.toMatchObject({
      code: "host_busy",
    });
    expect(await readdir(hosts)).toEqual([`${key}.lock`]);
  } finally {
    clock.mockRestore();
  }
});
