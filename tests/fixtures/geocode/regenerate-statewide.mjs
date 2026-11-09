// Network is opt-in. Source recordings and hashes stay in OPENPLANS_DATA_DIR; cuts stay <200 KB.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  acquireBatch,
  dataDirectory,
} from "../../../dist/ingest/geocode/census.js";
import { batchCsv } from "../../../dist/ingest/geocode/address.js";
import {
  countyUrl,
  parseCounties,
} from "../../../dist/ingest/geocode/counties.js";
const root = dataDirectory(),
  directory = new URL("./", import.meta.url);
const names = await readdir(join(root, "raw", "census-tx-county-bounds"));
const metadata = JSON.parse(
  await readFile(
    join(
      root,
      "raw",
      "census-tx-county-bounds",
      names
        .filter((n) => n.endsWith(".meta.json"))
        .sort()
        .at(-1),
    ),
    "utf8",
  ),
);
const rawPath = join(
  root,
  "raw",
  "census-tx-county-bounds",
  metadata.snapshot_id,
  "payload",
);
const countyRaw = await readFile(rawPath);
if (createHash("sha256").update(countyRaw).digest("hex") !== metadata.sha256)
  throw new Error("County cache hash mismatch");
const counties = parseCounties(
  countyRaw.toString("utf8"),
  `census-tx-county-bounds:${metadata.sha256}`,
);
const cut = {
  source: countyUrl,
  sha256: metadata.sha256,
  generated_by: "regenerate-statewide.mjs",
  counties: counties
    .filter((c) =>
      ["48113", "48453", "48141", "48201", "48225", "48339"].includes(
        c.county_fips,
      ),
    )
    .map(({ rings, ...bounds }) => bounds),
};
await writeFile(
  new URL("tx-county-bounds.json", directory),
  JSON.stringify(cut, null, 2) + "\n",
);
if (process.argv.includes("--record")) {
  const addresses = JSON.parse(
    await readFile(new URL("inputs.json", directory), "utf8"),
  );
  const result = await acquireBatch(batchCsv(addresses), { geographies: true });
  const raw = await readFile(result.file.path);
  if (raw.length > 200_000) throw new Error("Oversized fixture");
  await writeFile(new URL("tx-census.csv", directory), raw);
  await writeFile(
    new URL("tx-census.provenance.json", directory),
    JSON.stringify(
      {
        url: result.file.metadata.url,
        sha256: result.file.metadata.sha256,
        benchmark: "Public_AR_Current",
        vintage: "Current_Current",
        generated_by: "regenerate-statewide.mjs --record",
      },
      null,
      2,
    ) + "\n",
  );
}
