import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { readCsv } from "../../src/ingest/csv/index.js";
import type { ImportFile } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";

/** Join two unmodified real source cuts from the same acquired CMS archives. */
export async function fixtureFiles(
  directory: string,
  syntheticRateMutation?: (row: Record<string, string>) => void,
): Promise<ImportFile[]> {
  const base = fileURLToPath(
    new URL("../fixtures/puf/import/", import.meta.url),
  );
  const extra = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const provenance = JSON.parse(
    await readFile(join(extra, "provenance.json"), "utf8"),
  );
  const result: ImportFile[] = [];
  for (const kind of IMPORT_KINDS) {
    const records: Record<string, string>[] = [];
    for (const folder of [base, extra]) {
      const data = await readFile(join(folder, `${kind}.csv`));
      const manifest = JSON.parse(
        await readFile(join(folder, "provenance.json"), "utf8"),
      );
      expectHash(
        data,
        manifest.files.find((f: { kind: string }) => f.kind === kind)
          .cut_sha256,
      );
      for await (const row of readCsv(Readable.from([data])))
        records.push(row.values);
    }
    if (kind === "rate" && syntheticRateMutation)
      records.forEach(syntheticRateMutation);
    const keys = Object.keys(records[0]!),
      quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
    const data = Buffer.from(
      [
        keys.map(quote).join(","),
        ...records.map((row) => keys.map((key) => quote(row[key]!)).join(",")),
      ].join("\n") + "\n",
    );
    const path = join(directory, `${kind}.csv`);
    await writeFile(path, data);
    result.push({
      kind,
      path,
      format: "csv",
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
      retrievedAt: "2026-11-07T07:33:40.115Z",
      url: provenance.files.find((f: { kind: string }) => f.kind === kind).url,
    });
  }
  return result;
}
function expectHash(data: Buffer, expected: string) {
  if (createHash("sha256").update(data).digest("hex") !== expected)
    throw new Error("Regenerable fixture hash mismatch");
}
