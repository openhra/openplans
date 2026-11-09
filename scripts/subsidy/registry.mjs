import { readFile, readdir } from "node:fs/promises";

export const dataDirectory = new URL("../../data/subsidy/", import.meta.url);
export const generatedFile = new URL(
  "../../src/domain/subsidy/generated.ts",
  import.meta.url,
);
export async function readParameterFiles(directory = dataDirectory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}\.json$/.test(name))
    .sort();
  if (!names.length) throw new Error("No year parameter files");
  return Promise.all(
    names.map(async (name) => ({
      name,
      value: JSON.parse(await readFile(new URL(name, directory), "utf8")),
    })),
  );
}
export function registrySource(files) {
  const values = Object.fromEntries(
    files.map(({ name, value }) => [name.slice(0, 4), value]),
  );
  return (
    "// Generated from data/subsidy/*.json by scripts/subsidy/build.mjs. Do not edit.\n" +
    `export const parameterRegistry: Readonly<Record<number, unknown>> = ${JSON.stringify(values, null, 2)};\n`
  );
}
