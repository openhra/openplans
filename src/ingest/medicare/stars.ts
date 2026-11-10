import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database } from "../../db/database.js";
import { inspectZip, streamZipMember } from "../../fetch/index.js";
import { parseStars } from "../../domain/medicare/index.js";
import { readRecords } from "../csv/index.js";
import { readXlsxRows } from "../xlsx/index.js";
import type { CachedArchive } from "./acquire.js";
import { importRelease, insertRows } from "./release.js";
import type { ReleaseReport } from "./release.js";
import { archiveLimits } from "./sources.js";
import { memberText } from "./tabular.js";

const measures = [
  ["Part C Summary", "part_c_summary"],
  ["Part D Summary", "part_d_summary"],
  ["Overall", "overall"],
] as const;

async function* summaryRows(
  path: string,
  member: string,
): AsyncGenerator<{ rowNumber: number; cells: string[] }> {
  const limits = archiveLimits.stars;
  if (member.toLowerCase().endsWith(".csv")) {
    for await (const record of readRecords(
      memberText(path, member, limits, "utf-8"),
    ))
      yield { rowNumber: record.rowNumber, cells: record.fields };
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openplans-stars-"));
  try {
    const file = join(directory, "summary.xlsx");
    await pipeline(
      Readable.from(streamZipMember(path, member, limits)),
      createWriteStream(file, { flags: "wx" }),
    );
    let rowNumber = 0;
    for await (const cells of readXlsxRows(file, { maxRows: 20_000 }))
      yield { rowNumber: ++rowNumber, cells };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Contract-level summary and overall ratings (Star Ratings data tables, Summary Ratings). */
export async function importStars(
  db: Database,
  cached: CachedArchive,
): Promise<ReleaseReport> {
  const year = cached.archive.year;
  const member = (await inspectZip(cached.path, archiveLimits.stars)).members
    .map((entry) => entry.name)
    .filter((name) =>
      new RegExp(
        `${year} Star Ratings Data Table - Summary Ratings .*\\.(csv|xlsx)$`,
        "i",
      ).test(name),
    )
    .sort((a, b) => Number(b.endsWith(".csv")) - Number(a.endsWith(".csv")))[0];
  if (!member) throw new Error("Star Ratings archive has no summary table");
  return importRelease(db, cached, member, async (tx, snapshotId) => {
    let header: string[] | undefined;
    const batch: unknown[][] = [];
    const counts: Record<string, number> = { contracts: 0 };
    for await (const row of summaryRows(cached.path, member)) {
      const cells = row.cells.map((cell) => cell.trim());
      if (!header) {
        if (cells[0] === "Contract Number") {
          header = cells;
          for (const [label] of measures)
            if (!header.includes(`${year} ${label}`))
              throw new Error("Star Ratings summary header changed");
        }
        continue;
      }
      const contract = cells[0] ?? "";
      if (!contract) continue;
      if (!/^[EHRS0-9][0-9A-Z]{4}$/.test(contract))
        throw new Error("Invalid contract in Star Ratings summary");
      counts.contracts!++;
      for (const [label, measure] of measures) {
        const published = cells[header.indexOf(`${year} ${label}`)] ?? "";
        const cell = parseStars(published);
        counts[`${measure}_${cell.status}`] =
          (counts[`${measure}_${cell.status}`] ?? 0) + 1;
        batch.push([
          snapshotId,
          year,
          contract,
          measure,
          cell.status,
          cell.stars,
          published,
          row.rowNumber,
        ]);
      }
      if (batch.length >= 900)
        await insertRows(
          tx,
          "medicare_star_rating",
          [
            "snapshot_id",
            "rating_year",
            "contract_id",
            "measure",
            "status",
            "stars",
            "published",
            "source_row",
          ],
          batch,
        );
    }
    await insertRows(
      tx,
      "medicare_star_rating",
      [
        "snapshot_id",
        "rating_year",
        "contract_id",
        "measure",
        "status",
        "stars",
        "published",
        "source_row",
      ],
      batch,
    );
    if (!header || !counts.contracts)
      throw new Error("Empty Star Ratings summary");
    return counts;
  });
}
