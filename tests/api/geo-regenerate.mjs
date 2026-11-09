import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const source = "census-zcta-county-2020";
const sha256 =
  "3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf";
const cache =
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const bytes = await readFile(join(cache, "raw", source, sha256, "payload"));
assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
const lines = bytes.toString("utf8").trimEnd().split("\n");
const header = lines[0].split("|");
const zipColumn = header.indexOf("GEOID_ZCTA5_20");
const zips = new Set(["34786", "34787", "77002"]);
const rows = lines.flatMap((line, i) =>
  i > 0 && zips.has(line.split("|")[zipColumn])
    ? [{ line, source_row: i + 1 }]
    : [],
);
const cut = [lines[0], ...rows.map((row) => row.line)].join("\n") + "\n";
await writeFile(new URL("./geo-relationships.psv", import.meta.url), cut);
await writeFile(
  new URL("./geo-provenance.json", import.meta.url),
  JSON.stringify(
    {
      source,
      url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
      source_sha256: sha256,
      source_rows: rows.map((row) => row.source_row),
      cut_sha256: createHash("sha256").update(cut).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
