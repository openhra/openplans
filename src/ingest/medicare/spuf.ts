import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database, SqlSession } from "../../db/database.js";
import {
  fetchToCache,
  inspectZip,
  payloadLocation,
  readCachedText,
  sidecarNames,
  streamZipMember,
} from "../../fetch/index.js";
import type { SnapshotMetadata, ZipLimits } from "../../fetch/index.js";
import { planKeyFromParts } from "../../domain/medicare/index.js";
import { dataDirectory } from "./acquire.js";
import type { AcquireContext } from "./acquire.js";
import { insertRows } from "./release.js";
import { memberText, tabTable } from "./tabular.js";

/** Part D public use files on data.cms.gov: quarterly (with pricing) and monthly. */
export const spufHost = "data.cms.gov";
export const spufTerms =
  "https://data.cms.gov/sites/default/files/2023-10/4eeb19e1-525b-4a4e-9766-b33ff084fc5c/AGREEMENT-FOR-USE.pdf";
export const spufSources = {
  quarterly: "cms-partd-spuf-quarterly",
  monthly: "cms-partd-spuf-monthly",
} as const;
export type SpufKind = keyof typeof spufSources;
export interface SpufArchive {
  kind: SpufKind;
  year: number;
  label: string;
  url: string;
}
const outerLimits: ZipLimits = {
  maxMembers: 64,
  maxCompressedBytes: 4 * 1024 ** 3,
  maxUncompressedBytes: 4 * 1024 ** 3,
};
const innerLimits: ZipLimits = {
  maxMembers: 8,
  maxCompressedBytes: 2 * 1024 ** 3,
  maxUncompressedBytes: 16 * 1024 ** 3,
};

/** `.../SPUF_2026_20261007.zip` (quarterly) or `.../2027_20261008.zip` (monthly). */
export function parseSpufUrl(value: string): SpufArchive | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== spufHost ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/sites/default/files/")
  )
    return null;
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const match = /^(SPUF_)?(\d{4})_(\d{8})\.zip$/.exec(name);
  if (!match) return null;
  return {
    kind: match[1] ? "quarterly" : "monthly",
    year: Number(match[2]),
    label: match[3]!,
    url: url.href,
  };
}

export async function acquireSpuf(
  archive: SpufArchive,
  context: AcquireContext = {},
) {
  const dataDir = context.dataDir ?? dataDirectory();
  const cached = (await cachedSpuf(archive.kind, dataDir)).find(
    (entry) => entry.metadata.url === archive.url,
  );
  return fetchToCache(archive.url, {
    ...context.dependencies,
    admission: context.admission,
    source: spufSources[archive.kind],
    dataDir,
    allowHosts: [spufHost],
    expectedContent: "zip",
    expectedSha256: cached?.metadata.sha256,
    maxBytes: 3 * 1024 ** 3,
    zipLimits: outerLimits,
  });
}

/**
 * Cached Part D archives of one kind, newest label first, read through the fetch cache's store.
 * With a remote store `path` is filled in by `ensureCachedPayload`, so listing downloads nothing.
 */
export async function cachedSpuf(kind: SpufKind, dataDir = dataDirectory()) {
  const source = spufSources[kind];
  const out: {
    archive: SpufArchive;
    path: string;
    metadata: SnapshotMetadata;
  }[] = [];
  for (const name of await sidecarNames(dataDir, source).catch(
    () => [] as string[],
  )) {
    const metadata = JSON.parse(
      await readCachedText(dataDir, source, name),
    ) as SnapshotMetadata;
    const archive = parseSpufUrl(metadata.url);
    if (
      !archive ||
      archive.kind !== kind ||
      metadata.source !== spufSources[kind]
    )
      continue;
    out.push({
      archive,
      metadata,
      path: payloadLocation(dataDir, source, metadata.snapshot_id),
    });
  }
  return out.sort((a, b) => b.archive.label.localeCompare(a.archive.label));
}

export const coreTables = [
  "plan",
  "formulary",
  "excluded_drug",
  "indication_coverage",
  "beneficiary_cost",
  "insulin_cost",
  "county",
] as const;
export const largeTables = ["pharmacy_network", "pricing"] as const;

/**
 * Codes of the Beneficiary Cost and Insulin Beneficiary Cost files, as the 2026 and 2027 record
 * layouts define them. A code missing here is unknown to the reader, never a default.
 */
export const spufCodes = {
  coverageLevel: {
    "0": "pre_deductible",
    "1": "initial_coverage",
    "3": "catastrophic",
  },
  daysSupply: { "1": "30_days", "2": "90_days", "3": "other", "4": "60_days" },
  costType: { "0": "not_offered", "1": "copay", "2": "coinsurance" },
} as const;
/** The four pharmacy channels and their column suffixes, in record-layout order. */
export const spufChannels = [
  { channel: "preferred_retail", suffix: "PREF" },
  { channel: "standard_retail", suffix: "NONPREF" },
  { channel: "preferred_mail", suffix: "MAIL_PREF" },
  { channel: "standard_mail", suffix: "MAIL_NONPREF" },
] as const;
export type SpufChannel = (typeof spufChannels)[number]["channel"];
export type SpufTable =
  (typeof coreTables)[number] | (typeof largeTables)[number];
const members: Record<SpufTable, RegExp> = {
  plan: /^plan information /i,
  formulary: /^basic drugs formulary file /i,
  excluded_drug: /^excluded drugs formulary file /i,
  indication_coverage: /^indication based coverage formulary file /i,
  beneficiary_cost: /^beneficiary cost file /i,
  insulin_cost: /^insulin beneficiary cost file /i,
  county: /^geographic locator file /i,
  pharmacy_network: /^pharmacy networks file /i,
  pricing: /^pricing file /i,
};
const required: Record<SpufTable, string[]> = {
  plan: [
    "CONTRACT_ID",
    "PLAN_ID",
    "SEGMENT_ID",
    "FORMULARY_ID",
    "PREMIUM",
    "DEDUCTIBLE",
    "PLAN_SUPPRESSED_YN",
  ],
  formulary: [
    "FORMULARY_ID",
    "RXCUI",
    "NDC",
    "TIER_LEVEL_VALUE",
    "PRIOR_AUTHORIZATION_YN",
    "STEP_THERAPY_YN",
    "QUANTITY_LIMIT_YN",
  ],
  excluded_drug: ["CONTRACT_ID", "PLAN_ID", "RXCUI", "TIER"],
  indication_coverage: ["CONTRACT_ID", "PLAN_ID", "RXCUI", "DISEASE"],
  // Every channel column is required: a missing one would otherwise read as an absent benefit.
  beneficiary_cost: [
    "CONTRACT_ID",
    "PLAN_ID",
    "SEGMENT_ID",
    "COVERAGE_LEVEL",
    "TIER",
    "DAYS_SUPPLY",
    ...spufChannels.flatMap((channel) =>
      ["COST_TYPE", "COST_AMT", "COST_MIN_AMT", "COST_MAX_AMT"].map(
        (field) => `${field}_${channel.suffix}`,
      ),
    ),
    "TIER_SPECIALTY_YN",
    "DED_APPLIES_YN",
  ],
  insulin_cost: [
    "CONTRACT_ID",
    "PLAN_ID",
    "SEGMENT_ID",
    "TIER",
    "DAYS_SUPPLY",
    ...spufChannels.flatMap((channel) => [
      `COPAY_AMT_${channel.suffix}_INSLN`,
      `COIN_AMT_${channel.suffix}_INSLN`,
    ]),
  ],
  county: ["COUNTY_CODE", "STATENAME", "COUNTY"],
  pharmacy_network: [
    "CONTRACT_ID",
    "PLAN_ID",
    "SEGMENT_ID",
    "PHARMACY_NUMBER",
    "PHARMACY_ZIPCODE",
    "IN_AREA_FLAG",
  ],
  pricing: [
    "CONTRACT_ID",
    "PLAN_ID",
    "SEGMENT_ID",
    "NDC",
    "DAYS_SUPPLY",
    "UNIT_COST",
  ],
};

/**
 * Rows of one table of a cached archive. The inner archives hold one pipe-delimited table each;
 * they are copied to a private temp file. Core tables must be a single member, because stored
 * rows cite their table and row number only.
 */
export async function* spufTableRows(path: string, table: SpufTable) {
  const outer = (await inspectZip(path, outerLimits)).members
    .map((entry) => entry.name)
    .filter((name) => members[table].test(name))
    .sort();
  if (!outer.length) throw new Error(`Part D archive has no ${table} file`);
  if (outer.length > 1 && table !== "pharmacy_network")
    throw new Error(`Part D ${table} file is split into several members`);
  for (const name of outer) {
    const directory = await mkdtemp(join(tmpdir(), "openplans-spuf-"));
    try {
      const inner = join(directory, "inner.zip");
      await pipeline(
        Readable.from(streamZipMember(path, name, outerLimits)),
        createWriteStream(inner, { flags: "wx" }),
      );
      const text = (await inspectZip(inner, innerLimits)).members.find(
        (entry) => entry.name.toLowerCase().endsWith(".txt"),
      );
      if (!text) throw new Error(`Part D ${table} archive has no text table`);
      const parsed = await tabTable(
        memberText(inner, text.name, innerLimits, "windows-1252"),
        "|",
        64 * 1024,
        true,
      );
      const header = parsed.header.map((cell) => cell.trim().toUpperCase());
      for (const column of required[table])
        if (!header.includes(column))
          throw new Error(`Part D ${table} header lacks ${column}`);
      for await (const row of parsed.rows) {
        const values: Record<string, string> = {};
        header.forEach(
          (column, i) => (values[column] = (row.fields[i] ?? "").trim()),
        );
        yield { part: name, rowNumber: row.rowNumber, values };
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function key(values: Record<string, string>, segment = true) {
  return planKeyFromParts(
    values.CONTRACT_ID,
    values.PLAN_ID,
    segment ? values.SEGMENT_ID : "0",
  );
}
function tier(value: string | undefined): number | null {
  return value && /^\d{1,2}$/.test(value) ? Number(value) : null;
}
function yn(value: string | undefined, name: string): boolean {
  if (value === "Y") return true;
  if (value === "N" || value === "") return false;
  throw new Error(`Part D ${name} is not Y/N`);
}

/** PHARMACY_NUMBER is the NPI with a leading "10". */
export function pharmacyNpi(value: string): string {
  const match = /^10([12]\d{9})$/.exec(value.trim());
  if (!match) throw new Error("Part D pharmacy number is not an NPI");
  return match[1]!;
}

async function loadTable(
  tx: SqlSession,
  snapshotId: string,
  archive: SpufArchive,
  path: string,
  table: SpufTable,
  counts: Record<string, number>,
) {
  const batch: unknown[][] = [];
  let rows = 0;
  const flush = async (
    name: string,
    columns: readonly string[],
    force = false,
  ) => {
    if (force || batch.length >= 1000)
      await insertRows(tx, name, columns, batch);
  };
  const planRow = [
    "snapshot_id",
    "table_name",
    "contract_id",
    "plan_id",
    "segment_id",
    "rxcui",
    "tier",
    "cells",
    "source_row",
  ];
  if (table === "pharmacy_network") {
    // Rows are grouped by plan; each plan's network is hashed and stored once per distinct hash.
    const seen = new Set<string>();
    let current: string | null = null,
      pharmacies: [string, string, Record<string, string>][] = [],
      firstRow = 0;
    const plans: unknown[][] = [];
    const finish = async () => {
      if (!current) return;
      pharmacies.sort((a, b) => a[0].localeCompare(b[0]));
      const id = createHash("sha256")
        .update(JSON.stringify(pharmacies))
        .digest("hex");
      if (!seen.has(id)) {
        seen.add(id);
        await tx.query(
          "INSERT INTO partd_network(snapshot_id,network_id,pharmacies) VALUES($1,$2,$3)",
          [snapshotId, id, pharmacies.length],
        );
        const rowsOut: unknown[][] = [];
        for (const [npi, zip, cells] of pharmacies) {
          rowsOut.push([snapshotId, id, npi, zip, JSON.stringify(cells)]);
          if (rowsOut.length >= 1000)
            await insertRows(
              tx,
              "partd_network_pharmacy",
              ["snapshot_id", "network_id", "npi", "zip", "cells"],
              rowsOut,
            );
        }
        await insertRows(
          tx,
          "partd_network_pharmacy",
          ["snapshot_id", "network_id", "npi", "zip", "cells"],
          rowsOut,
        );
        counts.pharmacy_network_rows_stored =
          (counts.pharmacy_network_rows_stored ?? 0) + pharmacies.length;
      }
      const [contract, plan, segment] = current.split("-");
      plans.push([snapshotId, contract, plan, segment, id, firstRow]);
      if (plans.length >= 1000)
        await insertRows(
          tx,
          "partd_plan_network",
          [
            "snapshot_id",
            "contract_id",
            "plan_id",
            "segment_id",
            "network_id",
            "first_source_row",
          ],
          plans,
        );
    };
    const done = new Set<string>();
    for await (const row of spufTableRows(path, table)) {
      rows++;
      const k = key(row.values);
      const id = `${k.contractId}-${k.planId}-${k.segmentId}`;
      if (id !== current) {
        await finish();
        if (done.has(id))
          throw new Error(
            "Part D pharmacy network rows are not grouped by plan",
          );
        done.add(id);
        current = id;
        pharmacies = [];
        firstRow = row.rowNumber;
      }
      const {
        CONTRACT_ID: _c,
        PLAN_ID: _p,
        SEGMENT_ID: _s,
        PHARMACY_NUMBER,
        PHARMACY_ZIPCODE,
        ...cells
      } = row.values;
      void _c;
      void _p;
      void _s;
      pharmacies.push([
        pharmacyNpi(PHARMACY_NUMBER ?? ""),
        PHARMACY_ZIPCODE ?? "",
        cells,
      ]);
    }
    await finish();
    await insertRows(
      tx,
      "partd_plan_network",
      [
        "snapshot_id",
        "contract_id",
        "plan_id",
        "segment_id",
        "network_id",
        "first_source_row",
      ],
      plans,
    );
    counts.pharmacy_network_rows = rows;
    counts.pharmacy_networks_distinct = seen.size;
    counts.pharmacy_network_plans = done.size;
    return;
  }
  for await (const row of spufTableRows(path, table)) {
    rows++;
    const v = row.values;
    if (table === "plan") {
      const k = key(v);
      batch.push([
        snapshotId,
        k.contractId,
        k.planId,
        k.segmentId,
        v.FORMULARY_ID,
        yn(v.PLAN_SUPPRESSED_YN, "PLAN_SUPPRESSED_YN"),
        JSON.stringify(v),
        row.rowNumber,
      ]);
      await flush("partd_plan", [
        "snapshot_id",
        "contract_id",
        "plan_id",
        "segment_id",
        "formulary_id",
        "suppressed",
        "cells",
        "source_row",
      ]);
    } else if (table === "formulary") {
      if (!/^\d+$/.test(v.RXCUI ?? "") || !/^\d{11}$/.test(v.NDC ?? ""))
        throw new Error("Part D formulary row has an invalid RxCUI or NDC");
      // The archive name gives the contract year; a formulary row for another year is rejected.
      if (
        v.CONTRACT_YEAR !== undefined &&
        v.CONTRACT_YEAR !== String(archive.year)
      )
        throw new Error("Part D formulary row is for another contract year");
      batch.push([
        snapshotId,
        v.FORMULARY_ID,
        v.RXCUI,
        v.NDC,
        tier(v.TIER_LEVEL_VALUE),
        JSON.stringify(v),
        row.rowNumber,
      ]);
      await flush("partd_formulary_drug", [
        "snapshot_id",
        "formulary_id",
        "rxcui",
        "ndc",
        "tier",
        "cells",
        "source_row",
      ]);
    } else if (table === "county") {
      if (!/^\d{5}$/.test(v.COUNTY_CODE ?? ""))
        throw new Error("Part D county code invalid");
      batch.push([snapshotId, v.COUNTY_CODE, JSON.stringify(v), row.rowNumber]);
      await flush("partd_county", [
        "snapshot_id",
        "ssa_county_code",
        "cells",
        "source_row",
      ]);
    } else if (table === "pricing") {
      const k = key(v);
      const cost = /^\d+(?:\.\d{1,4})?$/.test(v.UNIT_COST ?? "")
        ? v.UNIT_COST
        : null;
      if (
        !cost ||
        !/^\d{11}$/.test(v.NDC ?? "") ||
        !/^\d{1,3}$/.test(v.DAYS_SUPPLY ?? "")
      )
        throw new Error("Part D pricing row invalid");
      batch.push([
        snapshotId,
        k.contractId,
        k.planId,
        k.segmentId,
        v.NDC,
        Number(v.DAYS_SUPPLY),
        cost,
        row.rowNumber,
      ]);
      await flush("partd_unit_cost", [
        "snapshot_id",
        "contract_id",
        "plan_id",
        "segment_id",
        "ndc",
        "days_supply",
        "unit_cost",
        "source_row",
      ]);
    } else {
      const withSegment =
        table === "beneficiary_cost" || table === "insulin_cost";
      const k = key(v, withSegment);
      batch.push([
        snapshotId,
        table,
        k.contractId,
        k.planId,
        withSegment ? k.segmentId : null,
        v.RXCUI || null,
        tier(v.TIER),
        JSON.stringify(v),
        row.rowNumber,
      ]);
      await flush("partd_plan_row", planRow);
    }
  }
  const target = {
    plan: [
      "partd_plan",
      [
        "snapshot_id",
        "contract_id",
        "plan_id",
        "segment_id",
        "formulary_id",
        "suppressed",
        "cells",
        "source_row",
      ],
    ],
    formulary: [
      "partd_formulary_drug",
      [
        "snapshot_id",
        "formulary_id",
        "rxcui",
        "ndc",
        "tier",
        "cells",
        "source_row",
      ],
    ],
    county: [
      "partd_county",
      ["snapshot_id", "ssa_county_code", "cells", "source_row"],
    ],
    pricing: [
      "partd_unit_cost",
      [
        "snapshot_id",
        "contract_id",
        "plan_id",
        "segment_id",
        "ndc",
        "days_supply",
        "unit_cost",
        "source_row",
      ],
    ],
  } as Record<string, [string, string[]]>;
  const [name, columns] = target[table] ?? ["partd_plan_row", planRow];
  await flush(name, columns, true);
  counts[`${table}_rows`] = rows;
  // Excluded-drug and indication-based files can be empty for a plan set; the rest cannot.
  if (
    !rows &&
    ["plan", "formulary", "beneficiary_cost", "county"].includes(table)
  )
    throw new Error(`Empty Part D ${table} file`);
}

/** Imports one cached SPUF archive; `tables` defaults to every table except networks and pricing. */
export async function importSpuf(
  db: Database,
  cached: { archive: SpufArchive; path: string; metadata: SnapshotMetadata },
  tables: readonly SpufTable[] = coreTables,
) {
  const started = Date.now();
  const { archive, metadata } = cached;
  const source = spufSources[archive.kind];
  const snapshotId = `${source}-${archive.year}-${archive.label}-${metadata.sha256}`;
  const asOf = `${archive.label.slice(0, 4)}-${archive.label.slice(4, 6)}-${archive.label.slice(6, 8)}`;
  if (archive.kind === "monthly" && tables.includes("pricing"))
    throw new Error("Monthly Part D files have no pricing table");
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
     VALUES ($1,'Centers for Medicare & Medicaid Services','cms-partd-spuf',$2::jsonb,$3) ON CONFLICT DO NOTHING`,
    [
      source,
      JSON.stringify([
        { url: spufTerms, access: "free public use file; no registration" },
      ]),
      spufTerms,
    ],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
      publisher_updated_at,http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,
      schema_version,parser_version,terms_review_reference,expected_children)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,'cms-partd-spuf','1',$15,1) ON CONFLICT DO NOTHING`,
    [
      snapshotId,
      source,
      metadata.url,
      metadata.final_url,
      JSON.stringify(metadata.redirect_chain),
      metadata.fetched_at,
      asOf,
      metadata.status,
      metadata.etag,
      metadata.last_modified,
      metadata.content_type,
      metadata.bytes,
      metadata.sha256,
      cached.path,
      spufTerms,
    ],
  );
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(1885434980)");
      const existing = (
        await tx.query<{ snapshot_id: string; counts: Record<string, number> }>(
          "SELECT snapshot_id,counts FROM partd_release WHERE kind=$1 AND contract_year=$2 AND as_of_label=$3",
          [archive.kind, archive.year, archive.label],
        )
      ).rows[0];
      if (existing) {
        if (existing.snapshot_id !== snapshotId)
          throw new Error(
            "Part D release already imported with different bytes",
          );
        return {
          snapshot_id: snapshotId,
          outcome: "noop" as const,
          counts: existing.counts,
          elapsed_ms: Date.now() - started,
        };
      }
      await tx.query(
        "INSERT INTO partd_release(snapshot_id,kind,contract_year,as_of,as_of_label,tables) VALUES($1,$2,$3,$4::date,$5,$6)",
        [
          snapshotId,
          archive.kind,
          archive.year,
          asOf,
          archive.label,
          [...tables],
        ],
      );
      const counts: Record<string, number> = {};
      for (const table of tables)
        await loadTable(tx, snapshotId, archive, cached.path, table, counts);
      const suppressed = (
        await tx.query<{ n: number }>(
          "SELECT count(DISTINCT (contract_id,plan_id,segment_id))::int AS n FROM partd_plan WHERE snapshot_id=$1 AND suppressed",
          [snapshotId],
        )
      ).rows[0]!.n;
      counts.suppressed_plans = suppressed;
      await tx.query(
        "UPDATE partd_release SET counts=$2::jsonb WHERE snapshot_id=$1",
        [snapshotId, JSON.stringify(counts)],
      );
      await tx.query(
        "UPDATE snapshot SET validation_state='ACTIVE',fetched_children=1,activated_at=now() WHERE snapshot_id=$1",
        [snapshotId],
      );
      return {
        snapshot_id: snapshotId,
        outcome: "imported" as const,
        counts,
        elapsed_ms: Date.now() - started,
      };
    });
  } catch (error) {
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1 AND validation_state<>'ACTIVE'",
      [snapshotId],
    );
    throw error;
  }
}
