import { readRecords } from "../csv/index.js";
export interface BatchRow {
  id: string;
  status: "Match" | "No_Match" | "Tie";
  quality: string | null;
  latitude?: number;
  longitude?: number;
  countyFips?: string;
  matchedAddress?: string;
  rawResponse?: string;
}
export interface BatchIssue {
  line: number;
  id?: string;
  code: string;
}
export async function parseBatch(
  text: string,
): Promise<{ rows: Map<string, BatchRow>; issues: BatchIssue[] }> {
  const rows = new Map<string, BatchRow>(),
    issues: BatchIssue[] = [],
    duplicate = new Set<string>(),
    seen = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let id: string | undefined;
    try {
      const records = [];
      for await (const row of readRecords(
        (async function* () {
          yield line;
        })(),
        { maxRecordLength: 16_384 },
      ))
        records.push(row);
      const f = records[0]?.fields ?? [];
      id = f[0];
      if (records.length !== 1 || !id || !/^[1-9][0-9]*$/.test(id))
        throw new Error();
      if (seen.has(id)) {
        rows.delete(id);
        duplicate.add(id);
        throw new Error();
      }
      seen.add(id);
      const status = f[2];
      if (!["Match", "No_Match", "Tie"].includes(status ?? "") || f.length < 3)
        throw new Error();
      const row: BatchRow = {
        id,
        status: status as BatchRow["status"],
        quality: f[3] || null,
      };
      if (status === "Match") {
        if (
          ![8, 12].includes(f.length) ||
          !["Exact", "Non_Exact", "Non-Exact"].includes(f[3] ?? "")
        )
          throw new Error();
        const coordinates = f[5]?.split(",");
        if (coordinates?.length !== 2 || coordinates.some((v) => !v.trim()))
          throw new Error();
        const [longitude, latitude] = coordinates.map(Number);
        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude!) > 90 ||
          Math.abs(longitude!) > 180
        )
          throw new Error();
        row.latitude = latitude;
        row.longitude = longitude;
        row.matchedAddress = f[4];
        row.rawResponse = line;
        if (f.length === 12) {
          if (!/^\d{2}$/.test(f[8] ?? "") || !/^\d{3}$/.test(f[9] ?? ""))
            throw new Error();
          row.countyFips = f[8]! + f[9]!;
        }
      } else {
        // A tie is never a match, even if a publisher includes extra response fields.
        row.quality = null;
      }
      rows.set(id, row);
    } catch {
      issues.push({
        line: index + 1,
        id,
        code: duplicate.has(id ?? "") ? "duplicate_row" : "malformed_row",
      });
    }
  }
  return { rows, issues };
}
