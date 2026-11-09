import type { Address } from "./address.js";
import { addressIdentity } from "./address.js";

export const normalizationVersion = "usps-cleanup-v1";
// Publication 28, C1. Apply suffixes only in the suffix position, never inside a street name.
const suffixes: Record<string, string> = {
  ALLEY: "ALY",
  ANNEX: "ANX",
  ARCADE: "ARC",
  AVENUE: "AVE",
  AV: "AVE",
  BAYOU: "BYU",
  BEACH: "BCH",
  BEND: "BND",
  BLUFF: "BLF",
  BOULEVARD: "BLVD",
  BRANCH: "BR",
  BRIDGE: "BRG",
  BROOK: "BRK",
  BYPASS: "BYP",
  CAMP: "CP",
  CANYON: "CYN",
  CAPE: "CPE",
  CAUSEWAY: "CSWY",
  CENTER: "CTR",
  CENTRE: "CTR",
  CIRCLE: "CIR",
  CLIFF: "CLF",
  CLUB: "CLB",
  COMMON: "CMN",
  CORNER: "COR",
  COURSE: "CRSE",
  COURT: "CT",
  COURTS: "CTS",
  COVE: "CV",
  CREEK: "CRK",
  CRESCENT: "CRES",
  CREST: "CRST",
  CROSSING: "XING",
  DALE: "DL",
  DRIVE: "DR",
  DRIVES: "DRS",
  ESTATE: "EST",
  EXPRESSWAY: "EXPY",
  EXTENSION: "EXT",
  FALLS: "FLS",
  FERRY: "FRY",
  FIELD: "FLD",
  FIELDS: "FLDS",
  FLAT: "FLT",
  FORD: "FRD",
  FOREST: "FRST",
  FORGE: "FRG",
  FORK: "FRK",
  FORT: "FT",
  FREEWAY: "FWY",
  GARDEN: "GDN",
  GARDENS: "GDNS",
  GATEWAY: "GTWY",
  GLEN: "GLN",
  GREEN: "GRN",
  GROVE: "GRV",
  HARBOR: "HBR",
  HAVEN: "HVN",
  HEIGHTS: "HTS",
  HIGHWAY: "HWY",
  HILL: "HL",
  HILLS: "HLS",
  HOLLOW: "HOLW",
  INLET: "INLT",
  ISLAND: "IS",
  ISLANDS: "ISS",
  JUNCTION: "JCT",
  KEY: "KY",
  KNOLL: "KNL",
  LAKE: "LK",
  LAKES: "LKS",
  LANDING: "LNDG",
  LANE: "LN",
  LIGHT: "LGT",
  LODGE: "LDG",
  MANOR: "MNR",
  MEADOWS: "MDWS",
  MILL: "ML",
  MISSION: "MSN",
  MOTORWAY: "MTWY",
  MOUNT: "MT",
  MOUNTAIN: "MTN",
  ORCHARD: "ORCH",
  OVAL: "OVAL",
  OVERPASS: "OPAS",
  PARKWAY: "PKWY",
  PASSAGE: "PSGE",
  PATH: "PATH",
  PIKE: "PIKE",
  PINE: "PNE",
  PLACE: "PL",
  PLAIN: "PLN",
  PLAZA: "PLZ",
  POINT: "PT",
  PORT: "PRT",
  PRAIRIE: "PR",
  RADIAL: "RADL",
  RANCH: "RNCH",
  RAPID: "RPD",
  REST: "RST",
  RIDGE: "RDG",
  RIVER: "RIV",
  ROAD: "RD",
  ROADS: "RDS",
  ROUTE: "RTE",
  ROW: "ROW",
  SHOAL: "SHL",
  SHORE: "SHR",
  SKYWAY: "SKWY",
  SPRING: "SPG",
  SPRINGS: "SPGS",
  SQUARE: "SQ",
  STATION: "STA",
  STRAVENUE: "STRA",
  STREAM: "STRM",
  STREET: "ST",
  STREETS: "STS",
  SUMMIT: "SMT",
  TERRACE: "TER",
  THROUGHWAY: "TRWY",
  TRACE: "TRCE",
  TRACK: "TRAK",
  TRAFFICWAY: "TRFY",
  TRAIL: "TRL",
  TUNNEL: "TUNL",
  TURNPIKE: "TPKE",
  UNION: "UN",
  VALLEY: "VLY",
  VIADUCT: "VIA",
  VIEW: "VW",
  VILLAGE: "VLG",
  VILLE: "VL",
  VISTA: "VIS",
  WALK: "WALK",
  WALL: "WALL",
  WAY: "WAY",
  WELL: "WL",
  WELLS: "WLS",
};
const directions: Record<string, string> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
};
const unit =
  /(?:^|[\s,])(?:(?:SUITE|STE|UNIT|FLOOR|FL|BUILDING|BLDG|ROOM|RM|APARTMENT|APT)\.?\s+|#\s*)([A-Z0-9][A-Z0-9 -]*)$/;
const canonical = (s: string | null) =>
  (s ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
export interface CleanAddress {
  version: string;
  original: Address;
  normalized: Address;
  request: Address;
  rules: string[];
  secondary: string[];
  changed: boolean;
  geocodable: boolean;
}
export function normalizeAddress(original: Address): CleanAddress {
  const rules = new Set<string>(),
    secondary: string[] = [];
  let street = canonical(original.line_1),
    line2 = canonical(original.line_2);
  const po = /\b(?:P\.?\s*O\.?\s*BOX|POST\s+OFFICE\s+BOX)\b/.test(
    `${street} ${line2}`,
  );
  if (po) rules.add("po_box");
  const split = street.match(unit);
  if (split && split.index !== undefined && split.index > 0) {
    secondary.push(street.slice(split.index).trim().replace(/^,\s*/, ""));
    street = street.slice(0, split.index).trim();
    rules.add("secondary_unit");
  }
  if (unit.test(line2)) {
    secondary.push(line2);
    line2 = "";
    rules.add("secondary_unit");
  }
  const punctuated = street
    .replace(/(?<!\d)\.|\.(?!\d)|,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (punctuated !== street) {
    street = punctuated;
    rules.add("punctuation");
  }
  let tokens = street.split(" ");
  const deduped = tokens.filter(
    (t, i) => !i || t !== tokens[i - 1] || /\d/.test(t),
  );
  if (deduped.length !== tokens.length) {
    rules.add("duplicate_token");
    tokens = deduped;
  }
  let end = tokens.length - 1;
  if (directions[tokens[end]!] || /^(N|S|E|W|NE|NW|SE|SW)$/.test(tokens[end]!))
    end--;
  if (
    end >= 2 &&
    suffixes[tokens[end]!] &&
    suffixes[tokens[end]!] !== tokens[end]
  ) {
    tokens[end] = suffixes[tokens[end]!]!;
    rules.add("street_suffix");
  }
  // A directional that is the whole street name, or precedes another directional, stays spelled out.
  if (tokens.length >= 4 && directions[tokens[1]!] && !directions[tokens[2]!]) {
    tokens[1] = directions[tokens[1]!]!;
    rules.add("directional");
  }
  if (end < tokens.length - 1 && directions[tokens.at(-1)!]) {
    tokens[tokens.length - 1] = directions[tokens.at(-1)!]!;
    rules.add("directional");
  }
  const zip = canonical(original.zip5),
    zip5 = /^\d{5}[- ]?\d{4}$/.test(zip) ? zip.slice(0, 5) : zip;
  if (zip !== zip5) rules.add("zip_plus4");
  const request = {
    ...original,
    line_1: tokens.join(" "),
    line_2: line2 || null,
    city: canonical(original.city),
    state: canonical(original.state),
    zip5: zip5 || null,
  };
  const normalized = {
    ...request,
    line_2: [line2, ...secondary].filter(Boolean).join(" ") || null,
  };
  return {
    version: normalizationVersion,
    original,
    normalized,
    request,
    rules: [...rules],
    secondary,
    changed:
      addressIdentity(request).normalized !==
      addressIdentity(original).normalized,
    geocodable: !po,
  };
}

/** House numbers, including hyphenated and fractional forms, must survive every cleanup rule. */
export function assertHouseNumber(original: Address, request: Address): void {
  const house = (text: string | null) =>
    canonical(text).match(
      /^\d+(?:\.\d+)?[A-Z]?(?:-[\dA-Z]+)?(?:\s+\d\/\d)?/,
    )?.[0];
  const number = house(original.line_1);
  if (number && house(request.line_1) !== number)
    throw new Error("Cleanup changed the house number");
}
