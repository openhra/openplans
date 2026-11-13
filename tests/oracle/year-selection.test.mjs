import { afterAll, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const directory = await mkdtemp(join(tmpdir(), "openplans-year-selection-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const parsers = [
  ["run.mjs", "const cache ="],
  ["all-states.mjs", "await mkdir(reports"],
  ["dental.mjs", 'if (args.includes("--all-states"))'],
  ["csr.mjs", 'if (args.includes("--all-states"))'],
  ["sbe.mjs", "const mutant ="],
  ["medicare.mjs", "const dataDir ="],
  ["medicare-part-d.mjs", "const dataDir ="],
  ["medicare-cost.mjs", "const dataDir ="],
].filter(
  ([name]) => name !== "run.mjs" || existsSync(`scripts/oracle/${name}`),
);

async function parserSource(name, end) {
  const source = await readFile(`scripts/oracle/${name}`, "utf8");
  const start = source.indexOf("const args = process.argv.slice(2)");
  const stop = source.indexOf(end, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(stop).toBeGreaterThan(start);
  return source.slice(start, stop);
}

function selectedYear(source, args) {
  // Run the actual CLI argument block, stopping before cache access or imports.
  return runInNewContext(`${source}\nyear;`, {
    process: {
      argv: ["node", "oracle.mjs", ...args],
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
    console: { error() {} },
  });
}

it("selects the requested year in every realdata Node entry point without opening a cache", async () => {
  for (const [name, end] of parsers) {
    const source = await parserSource(name, end);
    for (const year of [2025, 2026, 2027])
      expect(selectedYear(source, ["--year", String(year)]), name).toBe(year);
    if (name !== "all-states.mjs")
      expect(selectedYear(source, []), name).toBe(2026);
  }
});

it("rejects unsupported and missing years in the constrained Node parsers and catches a whitelist mutant", async () => {
  for (const [name, end] of parsers.filter(
    ([name]) =>
      !["medicare.mjs", "medicare-part-d.mjs", "medicare-cost.mjs"].includes(
        name,
      ),
  )) {
    const source = await parserSource(name, end);
    for (const args of [["--year", "2024"], ["--year", "2028"], ["--year"]])
      expect(() => selectedYear(source, args), name).toThrow();
    const mutant = source.replace(/2025, /g, "").replace(/"2025", /g, "");
    expect(mutant, name).not.toBe(source);
    expect(() => selectedYear(mutant, ["--year", "2025"]), name).toThrow();
  }
});

it("dispatches the requested years and runs the NY identity check only for 2026", async () => {
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const command of ["npm", "node"]) {
    const path = join(bin, command);
    await writeFile(
      path,
      `#!/usr/bin/env bash\nprintf '%s\\n' '${command}' "$@"\n`,
    );
    await chmod(path, 0o755);
  }
  const nodeCommand = (script, year, extra = []) => [
    "node",
    ...extra,
    `scripts/oracle/${script}.mjs`,
    ...(script === "dental" || script === "csr" ? ["--all-states"] : []),
    "--year",
    String(year),
  ];
  const expected = (years) => {
    let firstChecks = [];
    if (existsSync("scripts/oracle/run.mjs"))
      firstChecks = years.flatMap((y) => nodeCommand("run", y));
    else if (years.includes(2026))
      firstChecks = ["node", "scripts/oracle/raw-evidence.mjs"];
    return [
      "npm",
      "run",
      "build",
      ...firstChecks,
      ...years.flatMap((y) => nodeCommand("all-states", y)),
      ...years.flatMap((y) => nodeCommand("dental", y)),
      "PASS",
      ...years.flatMap((y) => nodeCommand("csr", y)),
      "PASS",
      ...years.flatMap((y) => nodeCommand("medicare", y)),
      ...years.flatMap((y) =>
        nodeCommand("medicare-part-d", y, ["--max-old-space-size=8192"]),
      ),
      "node",
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/ingest/medicare/medicare-cost-oracle.test.ts",
      ...years.flatMap((y) =>
        nodeCommand("medicare-cost", y, ["--max-old-space-size=8192"]),
      ),
      ...(years.includes(2026)
        ? [
            ...nodeCommand("medicare-part-d-price", 2026),
            "--cached",
            "--optional",
            "node",
            "src/ingest/state/ny-identitycheck.mjs",
            "node",
            "src/ingest/state/vt-metalcheck.mjs",
          ]
        : []),
      ...years.flatMap((y) => nodeCommand("sbe", y)),
      "node",
      "scripts/oracle/surface-sweep.mjs",
      ...years.flatMap((y) => ["--year", String(y)]),
      "--optional",
      "PASS",
      "",
    ].join("\n");
  };
  for (const years of [[2025], [2026], [2027], [2026, 2027]]) {
    const args = years.length === 1 ? ["--year", String(years[0])] : [];
    const run = spawnSync("bash", ["scripts/realdata.sh", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(expected(years));
  }
  const source = await readFile("scripts/realdata.sh", "utf8");
  const mutant = source.replace("[ \"$2\" = '2025' ] || ", "");
  expect(mutant).not.toBe(source);
  const path = join(directory, "year-mutant.sh");
  await writeFile(path, mutant);
  const run = spawnSync("bash", [path, "--year", "2025"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("Usage:");
});

it("accepts 2025 in the real Python parsers and rejects an unsupported year before collecting data", () => {
  const script = String.raw`
import argparse, runpy, sys
original = argparse.ArgumentParser.parse_args
def parse(self, *args, **kwargs):
    parsed = original(self, *args, **kwargs)
    print(parsed.year)
    raise SystemExit(0)
argparse.ArgumentParser.parse_args = parse
path, year, cache = sys.argv[1:]
output = '--directory' if path.endswith('all-states-reference.py') else '--rates' if path.endswith('/reference.py') else '--output'
sys.argv = [path, '--year', year, '--cache', cache, '--manifest', cache + '/absent.json', output, cache + '/unused']
if output != '--directory': sys.argv += ['--summary', cache + '/unused-summary']
runpy.run_path(path, run_name='__main__')
`;
  for (const name of [
    "reference.py",
    "all-states-reference.py",
    "dental-reference.py",
  ].filter(
    (name) => name !== "reference.py" || existsSync(`scripts/oracle/${name}`),
  )) {
    for (const year of [2025, 2026, 2027, 2028]) {
      const run = spawnSync(
        "python3",
        ["-B", "-c", script, `scripts/oracle/${name}`, String(year), directory],
        { encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(year === 2028 ? 2 : 0);
      if (year !== 2028) expect(run.stdout).toBe(`${year}\n`);
      else expect(run.stderr).toContain("invalid choice");
    }
  }
});
