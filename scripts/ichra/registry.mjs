import { readFile, readdir } from "node:fs/promises";

export const dataDirectory = new URL("../../data/ichra/", import.meta.url);
export const generatedFile = new URL(
  "../../src/domain/ichra/generated.ts",
  import.meta.url,
);
export async function readParameterFiles(directory = dataDirectory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}\.json$/.test(name))
    .sort();
  if (!names.length) throw new Error("No ICHRA year parameter files");
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
    "// Generated from data/ichra/*.json by scripts/ichra/build.mjs. Do not edit.\n" +
    `export const ichraRegistry: Readonly<Record<number, unknown>> = ${JSON.stringify(values, null, 2)};\n`
  );
}
