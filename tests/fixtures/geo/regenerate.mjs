#!/usr/bin/env node
import { homedir } from "node:os";
// Run after npm run build. Offline: reads previously downloaded, immutable source snapshots.
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEO_SOURCES,
  centroidStream,
} from "../../../dist/ingest/geo/sources.js";
const directory = fileURLToPath(new URL(".", import.meta.url));
const cache =
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const files = {};
for (const [kind, source] of Object.entries(GEO_SOURCES)) {
  const sourceDir = join(cache, "raw", source.source);
  const metadata = await Promise.all(
    (await readdir(sourceDir))
      .filter((name) => name.endsWith(".meta.json"))
      .map(async (name) =>
        JSON.parse(await readFile(join(sourceDir, name), "utf8")),
      ),
  );
  const latest = metadata
    .filter((m) => m.url === source.url)
    .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0];
  if (!latest)
    throw new Error(
      `Download ${source.source} using acquireGeo before regenerating`,
    );
  files[kind] = {
    path: join(sourceDir, latest.snapshot_id, "payload"),
    metadata: latest,
    zipped: kind === "centroids",
  };
}
async function* lines(path) {
  yield* createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
}
const selected = new Set(["75034"]),
  countySeen = new Set();
for await (const line of lines(files.relationship.path)) {
  const fields = line.split("|");
  if (!fields[9]?.startsWith("48") || !fields[1]) continue;
  if (!countySeen.has(fields[9]) || fields[9] === "48201")
    selected.add(fields[1]);
  countySeen.add(fields[9]);
}
let relationship = "",
  first = true;
for await (const line of lines(files.relationship.path)) {
  if (first) {
    relationship = `${line}\n`;
    first = false;
    continue;
  }
  const fields = line.split("|");
  if (fields[9]?.startsWith("48") && selected.has(fields[1]))
    relationship += `${line}\n`;
}
let centroids = "",
  firstCentroid = true;
for await (const line of createInterface({
  input: (await import("node:stream")).Readable.from(
    centroidStream(files.centroids),
  ),
  crlfDelay: Infinity,
})) {
  if (firstCentroid || selected.has(line.split("\t")[0]))
    centroids += `${line.trimEnd()}\n`;
  firstCentroid = false;
}
const html = await readFile(files.ratingAreas.path, "utf8");
const ratingAreas = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0] + "\n";
if (!ratingAreas.includes("County Name")) throw new Error("CMS table missing");
const manifest = {
  kind: "real_source_cuts",
  selection:
    "TX county rows only: first ZCTA per TX county, all Harris ZCTAs, and 75034; Gazetteer matching ZCTAs; complete CMS TX table without page chrome",
  sources: {},
};
for (const [kind, content, filename] of [
  ["relationship", relationship, "zcta-county-tx.psv"],
  ["centroids", centroids, "zcta-centroids-tx.tsv"],
  ["ratingAreas", ratingAreas, "tx-rating-areas.html"],
]) {
  if (Buffer.byteLength(content) >= 200_000)
    throw new Error(`${filename} exceeds fixture limit`);
  await writeFile(join(directory, filename), content);
  manifest.sources[kind] = {
    filename,
    publisher_url: GEO_SOURCES[kind].url,
    original_snapshot: files[kind].metadata,
    fixture_sha256: createHash("sha256").update(content).digest("hex"),
    fixture_bytes: Buffer.byteLength(content),
  };
  console.log(`${filename}: ${Buffer.byteLength(content)} bytes`);
}
await writeFile(
  join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
