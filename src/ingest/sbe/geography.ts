import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Database } from "../../db/database.js";
import { ingestGeo, pastYearTableModified } from "../geo/index.js";
import type { GeoImportOptions } from "../geo/index.js";
import { acquireGeo, centroidStream } from "../geo/sources.js";
import { relationships, centroids, ratingRows } from "../geo/parse.js";
import { saveSnapshot, snapshotId, insertRows } from "../geo/repository.js";
import { CMS_COUNTY_SPELLINGS, countyKey, STATE_FIPS } from "../geo/states.js";

// Literal CMS GRA labels independently matched to unique Census 2020 names.
// Sources: CMS ga-gra row 45, il-gra row 47, nm-gra row 7, ca-gra row 76;
// Census tab20_zcta520_county20_natl.txt supplies the canonical county names.
const spellings: Record<string, Record<string, string>> = {
  GA: { heralson: "haralson" },
  IL: { vermillion: "vermilion" },
  NM: { donaana: "doaana" },
  CA: { sanbernadino: "sanbernardino" },
};

export async function ingestSbeGeography(
  db: Database,
  options: GeoImportOptions,
) {
  const state = options.state!;
  // The existing geography importer owns this explicit, mutable spelling registry.
  for (const [published, census] of Object.entries(spellings[state] ?? {})) {
    const registered = (CMS_COUNTY_SPELLINGS[state] ??= {});
    if (registered[published] && registered[published] !== census)
      throw new Error("Conflicting SBE county spelling evidence");
    registered[published] = census;
  }
  if (state !== "CA" && state !== "MA") return ingestGeo(db, options);
  const year = options.planYear ?? 2026;
  const files = options.files ?? (await acquireGeo(options));
  for (const file of Object.values(files)) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (
      hash.digest("hex") !== file.metadata.sha256 ||
      bytes !== file.metadata.bytes
    )
      throw new Error("SBE geography source integrity failed");
  }
  const tableModified = await pastYearTableModified(files.ratingAreas, year);
  const selected = new Set<string>(),
    counties = new Map<string, string>();
  for await (const row of relationships(
    createReadStream(files.relationship.path),
  ))
    if (row.countyFips.startsWith(STATE_FIPS[state]!)) {
      const key = countyKey(row.countyName);
      if (counties.has(key) && counties.get(key) !== row.countyFips)
        throw new Error("Ambiguous Census county name");
      counties.set(key, row.countyFips);
      if (row.zcta) selected.add(row.zcta);
    }
  if (counties.size !== (state === "CA" ? 58 : 14) || !selected.size)
    throw new Error("Incomplete SBE Census scope");
  const snapshots = {
    relationship: snapshotId(files.relationship),
    centroids: snapshotId(files.centroids),
    ratingAreas: snapshotId(files.ratingAreas),
  };
  let html = await readFile(files.ratingAreas.path, "utf8"),
    scopedZipRows = 0;
  if (Buffer.byteLength(html) > 2 * 1024 ** 2)
    throw new Error("SBE GRA page exceeds bound");
  if (state === "CA")
    html = html.replace(
      /(\d{3})(?:&nbsp;|\s)+\(only within LA County\)/g,
      (_all, prefix: string) => {
        scopedZipRows++;
        return prefix;
      },
    );
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636975)");
    for (const kind of ["relationship", "centroids", "ratingAreas"] as const)
      await saveSnapshot(tx, kind, files[kind], state);
    await tx.query(
      "DELETE FROM rating_area WHERE snapshot_id=$1 AND state=$2 AND plan_year=$3",
      [snapshots.ratingAreas, state, year],
    );
    await tx.query(
      "DELETE FROM rating_area_zip WHERE snapshot_id=$1 AND state=$2 AND plan_year=$3",
      [snapshots.ratingAreas, state, year],
    );
    const write = async (
      table: "zcta_county" | "zcta_centroid" | "rating_area",
      rows: AsyncIterable<unknown[]>,
    ) => {
      let batch: unknown[][] = [],
        count = 0;
      for await (const row of rows) {
        batch.push(row);
        count++;
        if (batch.length === 250) {
          await insertRows(tx, table, batch);
          batch = [];
        }
      }
      await insertRows(tx, table, batch);
      return count;
    };
    const zctaCountyRows = await write(
      "zcta_county",
      (async function* () {
        for await (const row of relationships(
          createReadStream(files.relationship.path),
        ))
          if (row.zcta && selected.has(row.zcta)) {
            yield [
              row.zcta,
              row.countyFips,
              row.countyName,
              ...row.areas!,
              snapshots.relationship,
              row.rowNumber,
            ];
          }
      })(),
    );
    const seenCentroids = new Set<string>();
    const zctaCentroidRows = await write(
      "zcta_centroid",
      (async function* () {
        for await (const row of centroids(centroidStream(files.centroids)))
          if (selected.has(row.zcta)) {
            seenCentroids.add(row.zcta);
            yield [
              row.zcta,
              row.latitude,
              row.longitude,
              snapshots.centroids,
              row.rowNumber,
            ];
          }
      })(),
    );
    if (seenCentroids.size !== selected.size)
      throw new Error("SBE selected ZCTA lacks a centroid");
    const seenCounties = new Set<string>(),
      prefixes = new Set<string>(),
      corrections: {
        published: string;
        censusKey: string;
        sourceRow: number;
      }[] = [];
    const ratingAreaRows = await write(
      "rating_area",
      (async function* () {
        for await (const row of ratingRows(Readable.from([html]))) {
          if (row.zipPrefix) {
            if (row.countyName || prefixes.has(row.zipPrefix))
              throw new Error("Ambiguous SBE ZIP3 rating area");
            prefixes.add(row.zipPrefix);
            await tx.query(
              "INSERT INTO rating_area_zip(state,zip_prefix,rating_area_id,plan_year,snapshot_id,source_row) VALUES($1,$2,$3,$4,$5,$6)",
              [
                state,
                row.zipPrefix,
                row.ratingAreaId,
                year,
                snapshots.ratingAreas,
                row.rowNumber,
              ],
            );
            continue;
          }
          if (state === "MA")
            throw new Error("Unexpected county row in MA ZIP3 GRA");
          const key = countyKey(row.countyName),
            correction = CMS_COUNTY_SPELLINGS[state]?.[key],
            county = counties.get(correction ?? key);
          if (!county || seenCounties.has(county))
            throw new Error("Unknown or duplicate SBE county");
          seenCounties.add(county);
          if (correction)
            corrections.push({
              published: row.countyName,
              censusKey: correction,
              sourceRow: row.rowNumber,
            });
          yield [
            state,
            county,
            row.ratingAreaId,
            year,
            snapshots.ratingAreas,
            row.rowNumber,
          ];
        }
      })(),
    );
    if (
      state === "CA" &&
      (seenCounties.size !== 57 ||
        seenCounties.has("06037") ||
        scopedZipRows !== prefixes.size ||
        !scopedZipRows)
    )
      throw new Error("Changed California county/LA ZIP3 contract");
    if (state === "MA" && !prefixes.size)
      throw new Error("Empty MA ZIP3 geography");
    const unresolvedPrefixes =
      state === "MA"
        ? [...new Set([...selected].map((zip) => zip.slice(0, 3)))]
            .filter((prefix) => !prefixes.has(prefix))
            .sort()
        : [];
    const constraints =
      state === "CA"
        ? {
            county_scoped_zip3: "06037",
            cross_county_prefixes: "ambiguous",
            county_without_zip: "unknown",
          }
        : {
            unlisted_zcta_prefixes: unresolvedPrefixes,
            unlisted_rating_area: "unknown",
          };
    await tx.query(
      `INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation) VALUES($1,'warning',$2,$3)`,
      [
        snapshots.ratingAreas,
        state === "CA"
          ? "county_scoped_zip3_conservative_resolution"
          : "unlisted_border_zcta_prefixes",
        JSON.stringify(constraints),
      ],
    );
    for (const snapshot of Object.values(snapshots))
      await tx.query(
        "UPDATE snapshot SET validation_state='ACTIVE',activated_at=now() WHERE snapshot_id=$1",
        [snapshot],
      );
    await tx.query(
      "UPDATE snapshot SET parser_version='sbe-geo-v1' WHERE snapshot_id=$1",
      [snapshots.ratingAreas],
    );
    await tx.query(
      `INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(state,plan_year) DO UPDATE SET relationship_snapshot_id=EXCLUDED.relationship_snapshot_id,centroid_snapshot_id=EXCLUDED.centroid_snapshot_id,rating_snapshot_id=EXCLUDED.rating_snapshot_id,imported_at=now()`,
      [
        state,
        year,
        snapshots.relationship,
        snapshots.centroids,
        snapshots.ratingAreas,
      ],
    );
    return {
      state,
      planYear: year,
      zctaCountyRows,
      zctaCentroidRows,
      ratingAreaRows: ratingAreaRows + prefixes.size,
      snapshots,
      countyNameCorrections: corrections,
      ...(tableModified
        ? {
            ratingAreaBasis: "cms_table_unmodified_since" as const,
            ratingAreaTableModified: tableModified,
          }
        : { ratingAreaBasis: "current_cms_table" as const }),
      constraints,
    };
  });
}
