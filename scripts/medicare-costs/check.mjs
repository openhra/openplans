#!/usr/bin/env node
// Checks the pinned CMS Part D rule documents and the annual parameters taken from them.
//
//   node scripts/medicare-costs/check.mjs                 # structure, citations, table cells
//   node scripts/medicare-costs/check.mjs --data-dir DIR  # also rehash every cached document
//
// The cached bytes live under <data dir>/raw/<cacheSource>/<sha256>/payload, written by the
// admitted fetcher (src/fetch). This script reads files only; it never fetches. The PBP archives
// (pbp-documents.json) are pinned with the dictionary members inside them; cost-bounds.json cites
// dictionary rows and the LIS copay table that the cost engine's bound rules rest on.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const documentsFile = join(root, "data/medicare-part-d/documents.json");
export const parametersFile = join(
  root,
  "data/medicare-part-d/parameters.json",
);
export const pbpDocumentsFile = join(
  root,
  "data/medicare-part-d/pbp-documents.json",
);
export const boundsFile = join(root, "data/medicare-part-d/cost-bounds.json");
export const oraclesFile = join(
  root,
  "tests/fixtures/medicare-costs/oracles.json",
);

export const YEARS = ["2026", "2027"];
export const PARAMETERS = [
  "standardDeductibleCents",
  "outOfPocketThresholdCents",
  "deductibleCostSharingBasisPoints",
  "initialCoverageCostSharingBasisPoints",
  "catastrophicCostSharingBasisPoints",
];
const CELLS = {
  standardDeductibleCents: "Deductible",
  outOfPocketThresholdCents: "Out-of-Pocket Threshold",
};
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CMS_HOSTS = new Set(["www.cms.gov", "data.cms.gov"]);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

/** Problems with the document pin manifest; an empty list passes. */
export function documentErrors(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1)
    return ["documents: schemaVersion must be 1"];
  if (!text(manifest.cacheSource) || !/^[a-z0-9-]+$/.test(manifest.cacheSource))
    return ["documents: cacheSource must be a source directory name"];
  if (!Array.isArray(manifest.documents) || !manifest.documents.length)
    return ["documents: list is empty"];
  const errors = [];
  const ids = new Set();
  const hashes = new Set();
  for (const [index, doc] of manifest.documents.entries()) {
    const name = isObject(doc) && text(doc.id) ? doc.id : `#${index}`;
    if (!isObject(doc)) {
      errors.push(`${name}: not an object`);
      continue;
    }
    if (!/^C\d+$/.test(doc.id ?? "")) errors.push(`${name}: id must be C<n>`);
    if (ids.has(doc.id)) errors.push(`${name}: duplicate id`);
    ids.add(doc.id);
    for (const field of ["title", "use", "publisher", "contentType"])
      if (!text(doc[field])) errors.push(`${name}: ${field} is missing`);
    let url;
    try {
      url = new URL(doc.url);
    } catch {
      errors.push(`${name}: url is invalid`);
    }
    if (
      url &&
      (url.protocol !== "https:" ||
        !CMS_HOSTS.has(url.hostname) ||
        url.search ||
        url.hash)
    )
      errors.push(`${name}: url must be a plain https CMS address`);
    if (!SHA256.test(doc.sha256 ?? ""))
      errors.push(`${name}: sha256 must be 64 lowercase hex digits`);
    else if (hashes.has(doc.sha256)) errors.push(`${name}: duplicate sha256`);
    hashes.add(doc.sha256);
    if (!Number.isSafeInteger(doc.bytes) || doc.bytes <= 0)
      errors.push(`${name}: bytes must be a positive integer`);
    if (
      !DATE.test(doc.retrievedOn ?? "") ||
      Number.isNaN(Date.parse(doc.retrievedOn))
    )
      errors.push(`${name}: retrievedOn must be YYYY-MM-DD`);
  }
  return errors;
}

function citationErrors(where, citations, documents) {
  if (!Array.isArray(citations) || !citations.length)
    return [`${where}: needs at least one citation`];
  const errors = [];
  for (const [index, citation] of citations.entries()) {
    const at = `${where}: citation ${index + 1}`;
    if (!isObject(citation)) {
      errors.push(`${at} is not an object`);
      continue;
    }
    if (!documents.has(citation.document))
      errors.push(`${at} names unknown document ${citation.document}`);
    if (!text(citation.section)) errors.push(`${at} has no section`);
    if (!text(citation.quote)) errors.push(`${at} has no quoted text`);
    if (
      citation.page !== undefined &&
      (!Number.isSafeInteger(citation.page) || citation.page < 1)
    )
      errors.push(`${at} has an invalid page`);
    if (
      documents.get(citation.document)?.contentType === "application/pdf" &&
      citation.page === undefined
    )
      errors.push(`${at} cites a PDF without a page`);
  }
  return errors;
}

/** Problems with the annual parameters; every value needs a citation to a pinned document. */
export function parameterErrors(parameters, manifest) {
  const documents = new Map(
    (manifest?.documents ?? []).map((doc) => [doc.id, doc]),
  );
  if (!isObject(parameters) || parameters.schemaVersion !== 1)
    return ["parameters: schemaVersion must be 1"];
  if (!isObject(parameters.years)) return ["parameters: years is missing"];
  const errors = [];
  const years = Object.keys(parameters.years).sort();
  if (years.join() !== YEARS.join())
    errors.push(
      `parameters: years must be exactly ${YEARS.join(", ")}, found ${years.join(", ") || "none"}`,
    );
  for (const year of years) {
    const entry = parameters.years[year];
    if (!isObject(entry)) {
      errors.push(`${year}: not an object`);
      continue;
    }
    const names = Object.keys(entry).sort();
    if (names.join() !== [...PARAMETERS].sort().join())
      errors.push(`${year}: parameters must be ${PARAMETERS.join(", ")}`);
    for (const name of names) {
      const item = entry[name];
      const where = `${year}.${name}`;
      if (!isObject(item)) {
        errors.push(`${where}: not an object`);
        continue;
      }
      if (!Number.isSafeInteger(item.value) || item.value < 0)
        errors.push(`${where}: value must be a nonnegative integer`);
      if (
        name.endsWith("BasisPoints") &&
        Number.isSafeInteger(item.value) &&
        item.value > 10000
      )
        errors.push(`${where}: basis points above 10000`);
      errors.push(...citationErrors(where, item.citations, documents));
      for (const citation of item.citations ?? [])
        if (
          isObject(citation) &&
          /\b20\d\d column\b/.test(citation.section ?? "") &&
          !citation.section.includes(`${year} column`)
        )
          errors.push(`${where}: cites another year's column`);
    }
  }
  return errors;
}

/** Parses "$2,100" or "$615" into integer cents. */
export function dollarsToCents(cell) {
  const match = /^\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(cell ?? "");
  if (!match) return null;
  return Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? 0);
}

/** Compares the dollar parameters with the hand-transcribed table cells. */
export function oracleErrors(parameters, oracles, manifest) {
  const errors = [];
  const table = oracles?.annualRuleCells;
  if (!isObject(table) || !isObject(table.cells))
    return ["oracles: annualRuleCells is missing"];
  const ids = new Set((manifest?.documents ?? []).map((doc) => doc.id));
  if (!ids.has(table.document))
    errors.push(`oracles: annualRuleCells cites unknown ${table.document}`);
  for (const year of YEARS)
    for (const [name, cell] of Object.entries(CELLS)) {
      const expected = dollarsToCents(table.cells[year]?.[cell]);
      const actual = parameters?.years?.[year]?.[name]?.value;
      if (expected === null)
        errors.push(`oracles: ${year} ${cell} cell is unreadable`);
      else if (actual !== expected)
        errors.push(
          `${year}.${name}: ${actual} does not match ${table.document} ${cell} ${table.cells[year][cell]}`,
        );
    }
  for (const example of oracles?.workedExamples ?? []) {
    if (!ids.has(example?.document))
      errors.push(`oracles: ${example?.id} cites unknown ${example?.document}`);
    if (!text(example?.section) || !isObject(example?.expected))
      errors.push(`oracles: ${example?.id} needs a section and expectations`);
  }
  return errors;
}

/** Rehashes each pinned document in the cache. Missing, resized or altered bytes fail. */
export async function pinErrors(manifest, dataDir) {
  const errors = [];
  for (const doc of manifest.documents) {
    const base = join(dataDir, "raw", manifest.cacheSource, doc.sha256);
    let bytes;
    try {
      bytes = await readFile(join(base, "payload"));
    } catch {
      errors.push(`${doc.id}: not cached at ${base}`);
      continue;
    }
    if (bytes.length !== doc.bytes)
      errors.push(
        `${doc.id}: size ${bytes.length} differs from pin ${doc.bytes}`,
      );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== doc.sha256)
      errors.push(`${doc.id}: sha256 ${digest} differs from pin`);
    let meta;
    try {
      meta = JSON.parse(await readFile(`${base}.meta.json`, "utf8"));
    } catch {
      errors.push(`${doc.id}: cache metadata is missing`);
      continue;
    }
    if (meta.sha256 !== doc.sha256 || meta.bytes !== doc.bytes)
      errors.push(`${doc.id}: cache metadata disagrees with the pin`);
    if (meta.url !== doc.url && meta.final_url !== doc.url)
      errors.push(`${doc.id}: cached copy came from ${meta.url}`);
    if (!isObject(meta.access_policy))
      errors.push(`${doc.id}: cached copy has no admission receipt`);
  }
  return errors;
}

/** Zip pins name the contract year and pin each cited member by hash, size and sheet. */
export function memberErrors(manifest) {
  const errors = [];
  for (const doc of manifest?.documents ?? []) {
    if (doc?.contentType !== "application/zip") continue;
    if (!YEARS.includes(String(doc.contractYear)))
      errors.push(`${doc.id}: contractYear must be one of ${YEARS.join(", ")}`);
    if (!Array.isArray(doc.members) || !doc.members.length) {
      errors.push(`${doc.id}: a zip pin needs its cited members`);
      continue;
    }
    for (const member of doc.members) {
      const at = `${doc.id} ${member?.name ?? "member"}`;
      if (!text(member?.name) || member.name.includes(".."))
        errors.push(`${at}: name is missing or unsafe`);
      if (!SHA256.test(member?.sha256 ?? ""))
        errors.push(`${at}: sha256 must be 64 lowercase hex digits`);
      if (!Number.isSafeInteger(member?.bytes) || member.bytes <= 0)
        errors.push(`${at}: bytes must be a positive integer`);
      if (!text(member?.sheet)) errors.push(`${at}: sheet is missing`);
    }
  }
  return errors;
}

/** Document ids must be unique across every manifest that citations draw from. */
export function crossManifestErrors(manifests) {
  const seen = new Set();
  const errors = [];
  for (const manifest of manifests)
    for (const doc of manifest?.documents ?? []) {
      if (seen.has(doc.id)) errors.push(`${doc.id}: id used by two manifests`);
      seen.add(doc.id);
    }
  return errors;
}

const BOUND_SECTIONS = [
  "greaterOf",
  "lesserOf",
  "definedStandard",
  "specialNeedsPlan",
  "lisMaximumCopays",
];
const LIS_FIGURES = [
  "genericUpTo100FplCents",
  "otherUpTo100FplCents",
  "genericAbove100FplCents",
  "otherAbove100FplCents",
];

/**
 * Problems with the cost-sharing bound rules. Dictionary citations must name a pinned member,
 * its sheet and a row of that year's PBP archive; PDF citations need a page.
 */
export function boundErrors(bounds, manifests) {
  const documents = new Map(
    manifests.flatMap((manifest) =>
      (manifest?.documents ?? []).map((doc) => [doc.id, doc]),
    ),
  );
  if (!isObject(bounds) || bounds.schemaVersion !== 1)
    return ["bounds: schemaVersion must be 1"];
  if (!isObject(bounds.years)) return ["bounds: years is missing"];
  const errors = [];
  const years = Object.keys(bounds.years).sort();
  if (years.join() !== YEARS.join())
    errors.push(`bounds: years must be exactly ${YEARS.join(", ")}`);
  for (const year of years) {
    const entry = bounds.years[year];
    if (!isObject(entry)) {
      errors.push(`bounds ${year}: not an object`);
      continue;
    }
    if (Object.keys(entry).sort().join() !== [...BOUND_SECTIONS].sort().join())
      errors.push(
        `bounds ${year}: sections must be ${BOUND_SECTIONS.join(", ")}`,
      );
    for (const name of BOUND_SECTIONS) {
      const item = entry[name];
      const where = `bounds ${year}.${name}`;
      if (!isObject(item)) continue;
      errors.push(...citationErrors(where, item.citations, documents));
      for (const [index, citation] of (item.citations ?? []).entries()) {
        const doc = documents.get(citation?.document);
        const at = `${where}: citation ${index + 1}`;
        if (
          /\b20\d\d column\b/.test(citation?.section ?? "") &&
          !citation.section.includes(`${year} column`)
        )
          errors.push(`${at} cites another year's column`);
        if (doc?.contentType !== "application/zip") continue;
        if (String(doc.contractYear) !== year)
          errors.push(`${at} cites the ${doc.contractYear} archive`);
        const member = (doc.members ?? []).find(
          (item) => item.name === citation.member,
        );
        if (!member) errors.push(`${at} names an unpinned member`);
        else if (citation.sheet !== member.sheet)
          errors.push(`${at} names another sheet`);
        if (!Number.isSafeInteger(citation.row) || citation.row < 2)
          errors.push(`${at} needs a data row`);
      }
    }
    for (const name of ["greaterOf", "lesserOf", "definedStandard"])
      if (isObject(entry[name]) && !/^\d$/.test(entry[name].code ?? ""))
        errors.push(`bounds ${year}.${name}: code must be one digit`);
    const lis = entry.lisMaximumCopays;
    if (isObject(lis)) {
      for (const name of LIS_FIGURES)
        if (!Number.isSafeInteger(lis[name]) || lis[name] <= 0)
          errors.push(
            `bounds ${year}.lisMaximumCopays.${name}: positive cents`,
          );
      if (
        !(lis.genericUpTo100FplCents < lis.genericAbove100FplCents) ||
        !(lis.otherUpTo100FplCents < lis.otherAbove100FplCents)
      )
        errors.push(
          `bounds ${year}.lisMaximumCopays: the lower income level must have the lower copay`,
        );
    }
  }
  return errors;
}

/** Reads one stored or deflated member from a cached zip (no zip64, no encryption). */
export function zipMember(bytes, name) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("zip end record not found");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error("zip central directory is damaged");
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const entry = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (entry !== name) continue;
    if ([compressed, size, local].includes(0xffffffff))
      throw new Error(`${name}: zip64 members are not read`);
    if (bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`${name}: local header is damaged`);
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`${name}: compression method ${method} is not read`);
  }
  return null;
}

/** Rehashes each pinned member inside the cached archives. */
export async function memberPinErrors(manifest, dataDir) {
  const errors = [];
  for (const doc of manifest.documents) {
    if (!Array.isArray(doc.members)) continue;
    let bytes;
    try {
      bytes = await readFile(
        join(dataDir, "raw", manifest.cacheSource, doc.sha256, "payload"),
      );
    } catch {
      errors.push(`${doc.id}: archive not cached`);
      continue;
    }
    for (const member of doc.members) {
      let content;
      try {
        content = zipMember(bytes, member.name);
      } catch (error) {
        errors.push(`${doc.id} ${member.name}: ${error.message}`);
        continue;
      }
      if (!content) {
        errors.push(`${doc.id} ${member.name}: not in the archive`);
        continue;
      }
      if (content.length !== member.bytes)
        errors.push(
          `${doc.id} ${member.name}: size ${content.length} differs from pin ${member.bytes}`,
        );
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== member.sha256)
        errors.push(
          `${doc.id} ${member.name}: sha256 ${digest} differs from pin`,
        );
    }
  }
  return errors;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main(argv) {
  const at = argv.indexOf("--data-dir");
  const dataDir = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && !dataDir) throw new Error("--data-dir needs a directory");
  const manifest = await readJson(documentsFile);
  const parameters = await readJson(parametersFile);
  const oracles = await readJson(oraclesFile);
  const pbp = await readJson(pbpDocumentsFile);
  const bounds = await readJson(boundsFile);
  const errors = [
    ...documentErrors(manifest),
    ...documentErrors(pbp),
    ...memberErrors(pbp),
    ...crossManifestErrors([manifest, pbp]),
    ...parameterErrors(parameters, manifest),
    ...oracleErrors(parameters, oracles, manifest),
    ...boundErrors(bounds, [manifest, pbp]),
  ];
  if (dataDir) {
    await stat(dataDir);
    errors.push(...(await pinErrors(manifest, resolve(dataDir))));
    errors.push(...(await pinErrors(pbp, resolve(dataDir))));
    errors.push(...(await memberPinErrors(pbp, resolve(dataDir))));
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `medicare part d rules: PASS (${manifest.documents.length + pbp.documents.length} documents, years ${YEARS.join(", ")}${dataDir ? ", cache verified" : ""})`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `medicare part d rules: FAIL\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
