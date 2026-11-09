import { readRecords } from "../csv/index.js";

export const mainRequired = [
  "NPI",
  "Entity Type Code",
  "Provider Organization Name (Legal Business Name)",
  "Provider Last Name (Legal Name)",
  "Provider First Name",
  "Provider Middle Name",
  "Provider Name Prefix Text",
  "Provider Name Suffix Text",
  "Provider Credential Text",
  "Provider Enumeration Date",
  "Last Update Date",
  "NPI Deactivation Date",
  "NPI Reactivation Date",
  "Is Sole Proprietor",
  "Provider Sex Code",
  "Certification Date",
  ...["Mailing", "Practice Location"].flatMap((kind) => [
    `Provider First Line Business ${kind} Address`,
    `Provider Second Line Business ${kind} Address`,
    `Provider Business ${kind} Address City Name`,
    `Provider Business ${kind} Address State Name`,
    `Provider Business ${kind} Address Postal Code`,
    `Provider Business ${kind} Address Country Code (If outside U.S.)`,
    `Provider Business ${kind} Address Telephone Number`,
  ]),
  ...Array.from({ length: 15 }, (_, i) => [
    `Healthcare Provider Taxonomy Code_${i + 1}`,
    `Healthcare Provider Primary Taxonomy Switch_${i + 1}`,
    `Provider License Number State Code_${i + 1}`,
  ]).flat(),
];
export const secondaryRequired = [
  "NPI",
  "Provider Secondary Practice Location Address- Address Line 1",
  "Provider Secondary Practice Location Address-  Address Line 2",
  "Provider Secondary Practice Location Address - City Name",
  "Provider Secondary Practice Location Address - State Name",
  "Provider Secondary Practice Location Address - Postal Code",
  "Provider Secondary Practice Location Address - Country Code (If outside U.S.)",
  "Provider Secondary Practice Location Address - Telephone Number",
  "Provider Secondary Practice Location Address - Telephone Extension",
];
export type Field = (name: string) => string;
export async function* rows(
  input: AsyncIterable<Uint8Array | string>,
  required: string[],
): AsyncGenerator<{ get: Field; rowNumber: number }> {
  let header: Map<string, number> | undefined,
    width = 0;
  for await (const record of readRecords(input, {
    maxRecordLength: 128 * 1024,
  })) {
    if (!header) {
      header = new Map(record.fields.map((s, i) => [s.trim(), i]));
      width = record.fields.length;
      if (
        header.size !== width ||
        required.some((s) => !header!.has(s)) ||
        header.has("Provider Gender Code")
      ) {
        throw new Error(
          "Wrong NPPES version/layout: current V2 CSV header required",
        );
      }
      continue;
    }
    if (record.fields.length !== width)
      throw new Error("NPPES CSV column count mismatch");
    const indexes = header;
    yield {
      get: (name) => record.fields[indexes.get(name) ?? -1] ?? "",
      rowNumber: record.rowNumber,
    };
  }
  if (!header) throw new Error("Missing NPPES V2 header");
}
export function validNpi(npi: string): boolean {
  if (!/^[12][0-9]{9}$/.test(npi)) return false;
  const digits = `80840${npi}`;
  let sum = 0;
  for (
    let i = digits.length - 1, double = false;
    i >= 0;
    i--, double = !double
  ) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}
export function date(value: string): string | null {
  if (!value) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) throw new Error("Invalid NPPES date");
  const d = `${m[3]}-${m[1]}-${m[2]}`;
  if (
    Number.isNaN(Date.parse(d)) ||
    new Date(d).toISOString().slice(0, 10) !== d
  )
    throw new Error("Invalid NPPES date");
  return d;
}
export const nullable = (s: string) => s || null;
export const flag = (s: string): boolean | null =>
  s === "Y" ? true : s === "N" ? false : null;
export interface Address {
  kind: "mailing" | "practice";
  ordinal: number;
  line_1: string | null;
  line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  zip5: string | null;
  zip4: string | null;
  phone: string | null;
  phone_extension: string | null;
}
function address(
  values: string[],
  kind: Address["kind"],
  ordinal: number,
): Address {
  const [
    line1 = "",
    line2 = "",
    city = "",
    state = "",
    postal = "",
    country = "",
    phone = "",
    extension = "",
  ] = values;
  const zip =
    country === "US" || !country
      ? /^(\d{5})(?:-?(\d{4}))?$/.exec(postal)
      : null;
  return {
    kind,
    ordinal,
    line_1: nullable(line1),
    line_2: nullable(line2),
    city: nullable(city),
    state: nullable(state),
    postal_code: nullable(postal),
    country: nullable(country),
    zip5: zip?.[1] ?? null,
    zip4: zip?.[2] ?? null,
    phone: nullable(phone),
    phone_extension: nullable(extension),
  };
}
export function mainAddress(
  get: Field,
  kind: "Mailing" | "Practice Location",
): Address {
  return address(
    [
      `Provider First Line Business ${kind} Address`,
      `Provider Second Line Business ${kind} Address`,
      `Provider Business ${kind} Address City Name`,
      `Provider Business ${kind} Address State Name`,
      `Provider Business ${kind} Address Postal Code`,
      `Provider Business ${kind} Address Country Code (If outside U.S.)`,
      `Provider Business ${kind} Address Telephone Number`,
    ].map(get),
    kind === "Mailing" ? "mailing" : "practice",
    0,
  );
}
export function secondaryAddress(get: Field, ordinal: number): Address {
  return address(secondaryRequired.slice(1).map(get), "practice", ordinal);
}
