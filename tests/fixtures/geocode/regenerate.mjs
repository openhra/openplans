// Explicit network-only re-recording. All raw responses remain in OPENPLANS_DATA_DIR.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { acquireBatch } from "../../../dist/ingest/geocode/census.js";
import { batchCsv } from "../../../dist/ingest/geocode/address.js";
if (!process.argv.includes("--record"))
  throw new Error("Network recording requires --record");
const addresses = JSON.parse(
  await readFile(new URL("./inputs.json", import.meta.url), "utf8"),
);
const { file } = await acquireBatch(batchCsv(addresses));
const raw = await readFile(file.path);
await writeFile(new URL("./census.csv", import.meta.url), raw);
await writeFile(
  new URL("./provenance.json", import.meta.url),
  JSON.stringify(
    {
      publisher: "US Census Bureau",
      url: file.metadata.url,
      fetched_at: file.metadata.fetched_at,
      sha256: createHash("sha256").update(raw).digest("hex"),
      benchmark: "Public_AR_Current",
      notes:
        "Public building addresses and published NPPES practice locations; PO box and incomplete street are explicitly unmatched/ambiguous test inputs. Coordinates are Census-interpolated, not rooftop locations.",
    },
    null,
    2,
  ) + "\n",
);
const { acquireGeo, centroidStream } =
  await import("../../../dist/ingest/geo/sources.js");
const { centroids } = await import("../../../dist/ingest/geo/parse.js");
const geo = await acquireGeo();
const points = [];
for await (const point of centroids(centroidStream(geo.centroids)))
  if (["77002", "77030", "77356"].includes(point.zcta)) points.push(point);
await writeFile(
  new URL("./centroids.json", import.meta.url),
  JSON.stringify({ source: geo.centroids.metadata, points }, null, 2) + "\n",
);
