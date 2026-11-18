import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function timingFile(reports) {
  if (reports.length < 3)
    throw new Error("At least three full JSON reports are required");
  const runs = reports.map((report) => {
    const files = new Map();
    if (!Array.isArray(report.testResults) || !report.testResults.length)
      throw new Error("Report contains no test files");
    for (const result of report.testResults) {
      const file = result.name
        .replaceAll("\\", "/")
        .match(/(?:^|\/)((?:tests|plugins)\/.*)$/)?.[1];
      const ms = result.endTime - result.startTime;
      if (!file || !Number.isFinite(ms) || ms < 0 || files.has(file))
        throw new Error(`Invalid or duplicate file timing: ${result.name}`);
      files.set(file, ms);
    }
    return files;
  });
  const names = [...runs[0].keys()].sort();
  for (const run of runs)
    if (run.size !== names.length || names.some((file) => !run.has(file)))
      throw new Error("Reports must contain the same complete file set");
  const median = (values) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2;
  };
  return {
    version: 1,
    runs: reports.length,
    statistic: "median file wall milliseconds (JSON endTime - startTime)",
    files: Object.fromEntries(
      names.map((file) => [file, median(runs.map((run) => run.get(file)))]),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [output, ...inputs] = process.argv.slice(2);
    if (!output)
      throw new Error(
        "Usage: node scripts/test-timings.mjs OUTPUT RUN1.json RUN2.json RUN3.json [...]",
      );
    writeFileSync(
      output,
      JSON.stringify(
        timingFile(
          inputs.map((path) => JSON.parse(readFileSync(path, "utf8"))),
        ),
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
