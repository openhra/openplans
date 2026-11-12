#!/usr/bin/env node
// Checks the pinned CMS drug lists behind the Part D cost engine's drug classes, and builds the
// per-year selected-drug NDC lists from the cached CMS file.
//
//   node scripts/medicare-costs/drug-lists.mjs                         # structure and citations
//   node scripts/medicare-costs/drug-lists.mjs --data-dir DIR          # also rehash the cache and
//                                                                      # rebuild the NDC lists
//   node scripts/medicare-costs/drug-lists.mjs --data-dir DIR --write  # rewrite the NDC lists
//
// The cached bytes live under <data dir>/raw/<cacheSource>/<sha256>/payload, written by the
// admitted fetcher (src/fetch). This script reads files only; it never fetches.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  YEARS,
  crossManifestErrors,
  documentErrors,
  documentsFile,
  memberPinErrors,
  pbpDocumentsFile,
  pinErrors,
  readJson,
  zipMember,
} from "./check.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const drugListsFile = join(root, "data/medicare-part-d/drug-lists.json");

const NDC11 = /^\d{11}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Columns of the selected-drug file that the lists are built from. */
export const SELECTED_COLUMNS = [
  "IPAY",
  "Selected Drug Name",
  "NDC-11",
  "MFP Effective Date",
  "MFP End Date",
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

/** Parses RFC 4180 CSV. A quoted line break is refused, so record numbers are line numbers. */
export function parseCsv(source) {
  const input = source.replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else if (char === "\n" || char === "\r")
        throw new Error(
          `line break inside a quoted cell (record ${records.length + 1})`,
        );
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("unterminated quoted cell");
  if (cell !== "" || record.length) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** MM/DD/YYYY as an ISO date, or null. */
export function usDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((value ?? "").trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== iso
    ? null
    : iso;
}

const nextDay = (iso) => {
  const day = new Date(`${iso}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

/**
 * Builds the selected-drug NDC list of each year from the CMS file. A row applies from its
 * maximum fair price effective date to its end date (open when blank). A row whose end date is
 * before its effective date never applies; CMS uses such rows to record a deselection. An NDC is
 * on a year's list when its rows cover every day of that year, and partly listed when they cover
 * only some days.
 */
export function buildSelectedLists(csv, years = YEARS) {
  const [header, ...rows] = parseCsv(csv);
  const columns = Object.fromEntries(
    SELECTED_COLUMNS.map((name) => [name, header.indexOf(name)]),
  );
  for (const [name, at] of Object.entries(columns))
    if (at < 0) throw new Error(`selected-drug file has no ${name} column`);
  const periods = new Map();
  for (const [index, cells] of rows.entries()) {
    if (cells.length === 1 && cells[0] === "") continue;
    const row = index + 2;
    const cell = (name) => (cells[columns[name]] ?? "").trim();
    const ndc = cell("NDC-11").replaceAll("-", "");
    if (!NDC11.test(ndc))
      throw new Error(`row ${row}: NDC-11 ${cell("NDC-11")}`);
    const from = usDate(cell("MFP Effective Date"));
    if (!from) throw new Error(`row ${row}: effective date unreadable`);
    const end = cell("MFP End Date");
    const to = end ? usDate(end) : "9999-12-31";
    if (!to) throw new Error(`row ${row}: end date unreadable`);
    if (to < from) continue;
    const list = periods.get(ndc) ?? [];
    list.push({
      from,
      to,
      row,
      drug: cell("Selected Drug Name"),
      ipay: Number(cell("IPAY")),
    });
    periods.set(ndc, list);
  }
  const out = {};
  for (const year of years) {
    const start = `${year}-01-01`;
    const last = `${year}-12-31`;
    const listed = [];
    const partial = [];
    for (const [ndc, list] of [...periods].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const inYear = list
        .filter((item) => item.from <= last && item.to >= start)
        .sort((a, b) => a.from.localeCompare(b.from) || a.row - b.row);
      if (!inYear.length) continue;
      let covered = start;
      for (const item of inYear) {
        if (item.from > covered) break;
        const reach = item.to >= last ? nextDay(last) : nextDay(item.to);
        if (reach > covered) covered = reach;
      }
      const drugs = [...new Set(inYear.map((item) => item.drug))];
      const ipays = [...new Set(inYear.map((item) => item.ipay))];
      if (drugs.length !== 1 || ipays.length !== 1)
        throw new Error(`${ndc}: rows name more than one drug or year`);
      const entry = {
        ndc11: ndc,
        drug: drugs[0],
        ipay: ipays[0],
        rows: inYear.map((item) => item.row),
      };
      (covered > last ? listed : partial).push(entry);
    }
    out[year] = { listed, partial };
  }
  return out;
}

const REASONS = {
  nameOnly: "name_only_list_needs_rxnorm",
};

function citationErrors(where, citations, documents) {
  if (!Array.isArray(citations) || !citations.length)
    return [`${where}: needs at least one citation`];
  const errors = [];
  for (const [index, citation] of citations.entries()) {
    const at = `${where}: citation ${index + 1}`;
    const doc = documents.get(citation?.document);
    if (!doc) {
      errors.push(`${at} names unknown document ${citation?.document}`);
      continue;
    }
    if (!text(citation.section)) errors.push(`${at} has no section`);
    if (!text(citation.quote)) errors.push(`${at} has no quoted text`);
    const pdf =
      doc.contentType === "application/pdf" ||
      (citation.member ?? "").toLowerCase().endsWith(".pdf");
    if (pdf && !Number.isSafeInteger(citation.page))
      errors.push(`${at} cites a PDF without a page`);
    if (
      citation.member !== undefined &&
      !doc.members?.some((m) => m.name === citation.member)
    )
      errors.push(`${at} cites an unpinned member`);
  }
  return errors;
}

/** Problems with the drug-list file; an empty list passes. */
export function drugListErrors(lists, otherManifests = []) {
  if (!isObject(lists) || lists.schemaVersion !== 1)
    return ["drug lists: schemaVersion must be 1"];
  const errors = [
    ...documentErrors(lists),
    ...crossManifestErrors([...otherManifests, lists]),
  ];
  const documents = new Map(
    (lists.documents ?? []).map((doc) => [doc.id, doc]),
  );
  for (const doc of lists.documents ?? []) {
    if (doc.contentType !== "application/zip") {
      if (doc.members !== undefined)
        errors.push(`${doc.id}: members on a non-zip pin`);
      continue;
    }
    for (const member of doc.members ?? []) {
      if (!text(member?.name) || member.name.includes(".."))
        errors.push(`${doc.id}: member name is missing or unsafe`);
      if (!SHA256.test(member?.sha256 ?? ""))
        errors.push(
          `${doc.id} ${member?.name}: sha256 must be 64 lowercase hex digits`,
        );
      if (!Number.isSafeInteger(member?.bytes) || member.bytes <= 0)
        errors.push(
          `${doc.id} ${member?.name}: bytes must be a positive integer`,
        );
    }
  }
  const selected = lists.selectedDrugs;
  if (!isObject(selected)) return [...errors, "selectedDrugs is missing"];
  const source = documents.get(selected.document);
  if (!source?.members?.some((member) => member.name === selected.member))
    errors.push(
      "selectedDrugs: document and member must be a pinned zip member",
    );
  errors.push(
    ...citationErrors("selectedDrugs", selected.citations, documents),
  );
  const years = Object.keys(selected.years ?? {}).sort();
  if (years.join() !== YEARS.join())
    errors.push(
      `selectedDrugs: years must be ${YEARS.join(", ")}, not ${years.join(", ")}`,
    );
  for (const year of years) {
    const entry = selected.years[year];
    const seen = new Set();
    for (const part of ["listed", "partial"]) {
      if (!Array.isArray(entry?.[part])) {
        errors.push(`selectedDrugs ${year}: ${part} must be a list`);
        continue;
      }
      let previous = "";
      for (const item of entry[part]) {
        const at = `selectedDrugs ${year} ${item?.ndc11}`;
        if (!NDC11.test(item?.ndc11 ?? ""))
          errors.push(`${at}: ndc11 must be 11 digits`);
        if (seen.has(item?.ndc11)) errors.push(`${at}: listed twice`);
        seen.add(item?.ndc11);
        if (item?.ndc11 <= previous) errors.push(`${at}: out of order`);
        previous = item?.ndc11 ?? "";
        if (!Number.isSafeInteger(item?.ipay) || item.ipay > Number(year))
          errors.push(`${at}: ipay must be a year no later than ${year}`);
        if (!text(item?.drug)) errors.push(`${at}: drug name is missing`);
        if (
          !Array.isArray(item?.rows) ||
          !item.rows.length ||
          !item.rows.every((row) => Number.isSafeInteger(row) && row > 1)
        )
          errors.push(`${at}: rows must be data row numbers`);
      }
    }
    if (part(entry, "listed") === 0)
      errors.push(`selectedDrugs ${year}: no NDCs listed`);
  }
  for (const [index, list] of (lists.nameOnlyLists ?? []).entries()) {
    const at = `nameOnlyLists ${index + 1}`;
    if (!documents.has(list?.document)) errors.push(`${at}: unknown document`);
    if (!YEARS.includes(String(list?.year))) errors.push(`${at}: year`);
    if (list?.reason !== REASONS.nameOnly)
      errors.push(`${at}: reason must be ${REASONS.nameOnly}`);
    if (
      !Array.isArray(list?.names) ||
      !list.names.length ||
      !list.names.every(text)
    )
      errors.push(`${at}: names`);
    errors.push(...citationErrors(at, list?.citations, documents));
  }
  for (const key of ["manufacturerDiscount", "insulin"]) {
    const entry = lists[key];
    if (
      !isObject(entry) ||
      entry.status !== "unknown" ||
      !/^[a-z0-9_]+$/.test(entry.reason ?? "")
    )
      errors.push(`${key}: needs status unknown and a reason code`);
    if (!text(entry?.note)) errors.push(`${key}: note is missing`);
    for (const id of entry?.checked ?? [])
      if (!documents.has(id))
        errors.push(`${key}: checked names unknown document ${id}`);
    if (entry?.citations !== undefined)
      errors.push(...citationErrors(key, entry.citations, documents));
  }
  return errors;
}
const part = (entry, name) =>
  Array.isArray(entry?.[name]) ? entry[name].length : 0;

/** Reads the pinned selected-drug member from the cache. */
export async function selectedCsv(lists, dataDir) {
  const doc = lists.documents.find(
    (item) => item.id === lists.selectedDrugs.document,
  );
  const bytes = await readFile(
    join(dataDir, "raw", lists.cacheSource, doc.sha256, "payload"),
  );
  const member = zipMember(bytes, lists.selectedDrugs.member);
  if (!member)
    throw new Error(
      `${doc.id}: ${lists.selectedDrugs.member} not in the archive`,
    );
  return member.toString("utf8");
}

/** Cache checks: hashes, member hashes and a rebuild of the per-year NDC lists. */
export async function drugListCacheErrors(lists, dataDir) {
  const errors = [
    ...(await pinErrors(lists, dataDir)),
    ...(await memberPinErrors(lists, dataDir)),
  ];
  if (errors.length) return errors;
  const rebuilt = buildSelectedLists(await selectedCsv(lists, dataDir));
  for (const year of YEARS)
    if (
      JSON.stringify(rebuilt[year]) !==
      JSON.stringify(lists.selectedDrugs.years[year])
    )
      errors.push(
        `selectedDrugs ${year}: differs from a rebuild of the cached file`,
      );
  return errors;
}

async function main(argv) {
  const at = argv.indexOf("--data-dir");
  const dataDir = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && !dataDir) throw new Error("--data-dir needs a directory");
  const lists = await readJson(drugListsFile);
  if (argv.includes("--write")) {
    if (!dataDir) throw new Error("--write needs --data-dir");
    lists.selectedDrugs.years = buildSelectedLists(
      await selectedCsv(lists, resolve(dataDir)),
    );
    await writeFile(drugListsFile, `${JSON.stringify(lists, null, 2)}\n`);
  }
  const others = [
    await readJson(documentsFile),
    await readJson(pbpDocumentsFile),
  ];
  const errors = drugListErrors(lists, others);
  if (dataDir) {
    await stat(dataDir);
    errors.push(...(await drugListCacheErrors(lists, resolve(dataDir))));
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const counts = YEARS.map(
    (year) => `${year}: ${lists.selectedDrugs.years[year].listed.length} NDCs`,
  ).join(", ");
  console.log(
    `medicare part d drug lists: PASS (${lists.documents.length} documents; selected ${counts}${dataDir ? "; cache verified" : ""})`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `medicare part d drug lists: FAIL\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
