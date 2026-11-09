import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { measure } from "./measure-cache.mjs";

it("measures raw UTF-8 records, quoted strings, escapes, depth and incomplete tails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-json-measure-"));
  try {
    const path = join(directory, "synthetic.json");
    const row = { synthetic: ["é😀", { text: '\\"[]{}' }] };
    const record = JSON.stringify(row),
      text = `[ \n${record}, 1, "x" ]`;
    await writeFile(path, text);
    expect(await measure(path)).toEqual({
      bytes: Buffer.byteLength(text),
      maxDepth: 4,
      maxRecordBytes: Buffer.byteLength(record),
      maxStringBytes: Buffer.byteLength('"synthetic"'),
      records: 3,
      incomplete: false,
    });
    await writeFile(path, `[${record},`);
    expect(await measure(path)).toMatchObject({
      maxRecordBytes: Buffer.byteLength(record),
      records: 1,
      incomplete: true,
    });
    await writeFile(path, "<html>synthetic</html>");
    expect(await measure(path)).toEqual({ skipped: "not_root_array" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("measures strings and records across the scan buffer boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-json-measure-"));
  try {
    const path = join(directory, "synthetic.json");
    const row = { synthetic: true, text: "x".repeat(1024 ** 2) + '\\"😀' };
    await writeFile(path, JSON.stringify([row]));
    expect(await measure(path)).toMatchObject({
      maxDepth: 2,
      maxRecordBytes: Buffer.byteLength(JSON.stringify(row)),
      maxStringBytes: Buffer.byteLength(JSON.stringify(row.text)),
      records: 1,
      incomplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
