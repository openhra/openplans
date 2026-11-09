import { StringDecoder } from "node:string_decoder";
import { readCsv } from "../csv/index.js";
import type { CsvRow } from "../csv/index.js";

export class GeoError extends Error {
  constructor(
    readonly code: "schema" | "invalid_fips" | "invalid_value" | "incomplete",
    readonly rowNumber: number,
    message: string,
  ) {
    super(`Geography row ${rowNumber}: ${message}`);
    this.name = "GeoError";
  }
}
const requiredRelationship = [
  "GEOID_ZCTA5_20",
  "GEOID_COUNTY_20",
  "NAMELSAD_COUNTY_20",
  "AREALAND_ZCTA5_20",
  "AREAWATER_ZCTA5_20",
  "AREALAND_COUNTY_20",
  "AREAWATER_COUNTY_20",
  "AREALAND_PART",
  "AREAWATER_PART",
];
function schema(row: CsvRow, columns: string[]): void {
  if (columns.some((column) => !(column in row.values)))
    throw new GeoError(
      "schema",
      row.rowNumber,
      "required published column missing",
    );
}
function digits(value: string, rowNumber: number, kind: string): string {
  if (!/^\d{5}$/.test(value))
    throw new GeoError(
      "invalid_fips",
      rowNumber,
      `${kind} must be a five-digit string`,
    );
  return value;
}
function area(value: string, row: number): string {
  if (!/^\d+$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new GeoError("invalid_value", row, "invalid published area");
  return value;
}
export interface Relationship {
  zcta: string | null;
  countyFips: string;
  countyName: string;
  rowNumber: number;
  areas: [string, string, string, string, string, string] | null;
}
export async function* relationships(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Relationship> {
  let count = 0;
  for await (const row of readCsv(input, { delimiter: "|" })) {
    schema(row, requiredRelationship);
    count++;
    const v = row.values;
    // The published file includes unassigned land: blank ZCTA is not a ZIP or a malformed row.
    const zcta = v.GEOID_ZCTA5_20
      ? digits(v.GEOID_ZCTA5_20, row.rowNumber, "ZCTA")
      : null;
    const countyFips = digits(v.GEOID_COUNTY_20!, row.rowNumber, "County FIPS");
    const countyName = v.NAMELSAD_COUNTY_20!;
    if (!countyName)
      throw new GeoError("invalid_value", row.rowNumber, "missing county name");
    const areas = zcta
      ? ([
          "AREALAND_ZCTA5_20",
          "AREAWATER_ZCTA5_20",
          "AREALAND_COUNTY_20",
          "AREAWATER_COUNTY_20",
          "AREALAND_PART",
          "AREAWATER_PART",
        ].map((key) => area(v[key]!, row.rowNumber)) as Relationship["areas"])
      : null;
    yield { zcta, countyFips, countyName, areas, rowNumber: row.rowNumber };
  }
  if (!count) throw new GeoError("incomplete", 1, "empty relationship source");
}
export async function* centroids(input: AsyncIterable<Uint8Array | string>) {
  let count = 0;
  for await (const row of readCsv(input, { delimiter: "\t" })) {
    schema(row, ["GEOID", "INTPTLAT", "INTPTLONG"]);
    count++;
    const zcta = digits(row.values.GEOID!, row.rowNumber, "ZCTA");
    const latitude = row.values.INTPTLAT!.trim(),
      longitude = row.values.INTPTLONG!.trim();
    if (
      !/^[+-]?\d+\.\d{1,6}$/.test(latitude) ||
      !/^[+-]?\d+\.\d{1,6}$/.test(longitude) ||
      Math.abs(Number(latitude)) > 90 ||
      Math.abs(Number(longitude)) > 180
    ) {
      throw new GeoError(
        "invalid_value",
        row.rowNumber,
        "invalid Gazetteer internal point",
      );
    }
    yield { zcta, latitude, longitude, rowNumber: row.rowNumber };
  }
  if (!count) throw new GeoError("incomplete", 1, "empty Gazetteer source");
}
function htmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&Acirc;|Â/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
/** Bounded row scanner for the CMS county table; unrelated page markup is discarded. */
export async function* ratingRows(input: AsyncIterable<Uint8Array | string>) {
  const decoder = new StringDecoder("utf8");
  let buffer = "",
    rowNumber = 0,
    header = false,
    closed = false,
    count = 0;
  function* consume(text: string) {
    if (closed) return;
    buffer += text;
    for (;;) {
      const start = buffer.search(/<tr\b/i);
      const tableEnd = header ? buffer.search(/<\/table\s*>/i) : -1;
      if (tableEnd >= 0 && (start < 0 || tableEnd < start)) {
        closed = true;
        buffer = "";
        return;
      }
      if (start < 0) {
        buffer = buffer.slice(-16);
        return;
      }
      buffer = buffer.slice(start);
      const end = /<\/tr\s*>/i.exec(buffer);
      if (!end) {
        if (buffer.length > 64 * 1024)
          throw new GeoError(
            "schema",
            rowNumber + 1,
            "CMS table row exceeds limit",
          );
        return;
      }
      const row = buffer.slice(0, end.index + end[0].length);
      buffer = buffer.slice(end.index + end[0].length);
      rowNumber++;
      const cells = [
        ...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi),
      ].map((match) => htmlText(match[1]!));
      if (
        cells[0]?.startsWith("Rating Area ID") &&
        cells[1] === "County Name"
      ) {
        header = true;
        continue;
      }
      if (!header) continue;
      if (
        ![2, 3].includes(cells.length) ||
        !/^Rating Area [1-9]\d*$/.test(cells[0]!) ||
        (!cells[1] && !/^\d{3}$/.test(cells[2] ?? "")) ||
        (cells[2] && !/^\d{3}$/.test(cells[2]))
      ) {
        throw new GeoError(
          "schema",
          rowNumber,
          "unrecognized CMS rating-area row",
        );
      }
      count++;
      yield {
        ratingAreaId: cells[0]!,
        countyName: cells[1]!,
        zipPrefix: cells[2] || null,
        rowNumber,
      };
    }
  }
  for await (const chunk of input)
    yield* consume(
      typeof chunk === "string"
        ? decoder.end() + chunk
        : decoder.write(Buffer.from(chunk)),
    );
  yield* consume(decoder.end());
  if (/<tr\b/i.test(buffer) || !header || !closed || !count)
    throw new GeoError(
      "incomplete",
      rowNumber + 1,
      "missing or truncated CMS county table",
    );
}
