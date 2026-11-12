// Benefit bundle read back from an imported archive and checked against a separate reading of the
// raw fixture tables (a cut of the Q3 2026 CMS file). Edited archives are planted errors.
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import type { Database } from "../../../src/db/database.js";
import { parsePlanKey } from "../../../src/domain/medicare/index.js";
import {
  bundleProvenanceProblems,
  readBenefitBundle,
} from "../../../src/domain/medicare/part-d-cost/repository.js";
import type { BenefitBundle } from "../../../src/domain/medicare/part-d-cost/repository.js";
import type { Transport } from "../../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../../src/ingest/medicare/spuf.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureDirectory, lookup, spufArchive, spufUrl } from "./helpers.js";

type Edit = Parameters<typeof spufArchive>[0];
type Raw = Record<string, string> & { line: number };
const monthly2027 =
  "https://data.cms.gov/sites/default/files/2026-10/73ce0d29-e440-4d9a-9608-93678a50e8c8/2027_20261008.zip";

// The record layouts' code tables (C1/C2), written out here apart from the reader.
const PHASE: Record<string, string> = {
  "0": "pre_deductible",
  "1": "initial_coverage",
  "3": "catastrophic",
};
const SUPPLY: Record<string, string> = {
  "1": "30_days",
  "2": "90_days",
  "3": "other",
  "4": "60_days",
};
const CHANNEL: [string, string][] = [
  ["preferred_retail", "PREF"],
  ["standard_retail", "NONPREF"],
  ["preferred_mail", "MAIL_PREF"],
  ["standard_mail", "MAIL_NONPREF"],
];

/** Raw fixture table: header on line 1, so the first data row is line 2. */
async function rawTable(prefix: string): Promise<Raw[]> {
  const root = join(fixtureDirectory, "partd");
  const outer = (await readdir(root)).find((name) =>
    name.toLowerCase().startsWith(prefix),
  )!;
  const inner = (await readdir(join(root, outer)))[0]!;
  const lines = (await readFile(join(root, outer, inner), "latin1"))
    .split(/\r?\n/)
    .filter((line) => line !== "");
  const header = lines[0]!.split("|").map((c) => c.trim().toUpperCase());
  return lines.slice(1).map((line, i) => {
    const cells = line.split("|");
    const row: Raw = { line: i + 2 } as Raw;
    header.forEach((name, j) => (row[name] = (cells[j] ?? "").trim()));
    return row;
  });
}
const cents = (text: string) => {
  const [whole, fraction = ""] = text.split(".");
  return Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
};
const basisPoints = (text: string) => {
  const [whole, fraction = ""] = text.split(".");
  return Number(whole || "0") * 10000 + Number(fraction.padEnd(4, "0"));
};
const planOf = (row: Raw) =>
  `${row.CONTRACT_ID}-${row.PLAN_ID}-${Number(row.SEGMENT_ID)}`;

interface RawFixture {
  plans: Raw[];
  costs: Raw[];
  insulin: Raw[];
  formulary: Raw[];
}

/** Every disagreement between a bundle and the raw rows of its plan. */
function compare(raw: RawFixture, bundle: BenefitBundle): string[] {
  const problems: string[] = [];
  if (bundle.status !== "available") return [`bundle ${bundle.reason}`];
  const key = bundle.plan_key;
  const plans = raw.plans.filter((row) => planOf(row) === key);
  const deductibles = new Set(plans.map((row) => row.DEDUCTIBLE));
  if (
    deductibles.size !== 1 ||
    bundle.deductible.status !== "value" ||
    bundle.deductible.cents !== cents([...deductibles][0]!)
  )
    problems.push("deductible");
  if (
    JSON.stringify(bundle.deductible_evidence.map((r) => r.source_row)) !==
    JSON.stringify(plans.map((row) => row.line))
  )
    problems.push("deductible rows");
  if (bundle.formulary_id !== plans[0]!.FORMULARY_ID)
    problems.push("formulary");
  const snp = bundle.special_needs_plan;
  if (
    snp.status !== "value" ||
    snp.code !== plans[0]!.SNP ||
    JSON.stringify(snp.evidence.map((r) => r.source_row)) !==
      JSON.stringify(plans.map((row) => row.line))
  )
    problems.push("special needs plan");
  const costs = raw.costs.filter((row) => planOf(row) === key);
  const cited = bundle.tiers.flatMap((tier) =>
    tier.evidence.map((ref) => [ref.source_row, tier] as const),
  );
  for (const row of costs) {
    const catastrophicCharge =
      row.COVERAGE_LEVEL === "3" &&
      CHANNEL.some(
        ([, s]) =>
          row[`COST_TYPE_${s}`] !== "0" && cents(row[`COST_AMT_${s}`]!) !== 0,
      );
    const found = cited.filter(([line]) => line === row.line);
    if (catastrophicCharge) {
      if (found.length)
        problems.push(`cost ${row.line}: stale catastrophic kept`);
      continue;
    }
    if (found.length !== 1) {
      problems.push(`cost ${row.line}: cited ${found.length} times`);
      continue;
    }
    const tier = found[0]![1];
    if (tier.tier !== Number(row.TIER)) problems.push(`cost ${row.line}: tier`);
    if (tier.phase !== PHASE[row.COVERAGE_LEVEL!])
      problems.push(`cost ${row.line}: phase`);
    if (tier.supply !== SUPPLY[row.DAYS_SUPPLY!])
      problems.push(`cost ${row.line}: supply`);
    if (tier.deductible_applies !== (row.DED_APPLIES_YN === "Y"))
      problems.push(`cost ${row.line}: deductible applies`);
    if (tier.specialty_tier !== (row.TIER_SPECIALTY_YN === "Y"))
      problems.push(`cost ${row.line}: specialty`);
    CHANNEL.forEach(([name, s], i) => {
      const channel = tier.channels[i]!;
      const type = row[`COST_TYPE_${s}`];
      const amount = row[`COST_AMT_${s}`]!;
      const expected = {
        "0": { status: "not_offered", amount: null },
        "1": { status: "copay", amount: cents(amount) },
        "2": { status: "coinsurance", amount: basisPoints(amount) },
      }[type!]!;
      let actual: number | string | null = null;
      if (channel.amount?.status === "value")
        actual =
          "cents" in channel.amount
            ? channel.amount.cents
            : channel.amount.basis_points;
      else if (channel.amount) actual = "unknown";
      if (
        channel.channel !== name ||
        channel.status !== expected.status ||
        actual !== expected.amount
      )
        problems.push(`cost ${row.line}: ${name}`);
    });
  }
  if (cited.length !== new Set(cited.map(([line]) => line)).size)
    problems.push("cost rows cited twice");
  const insulin = raw.insulin.filter((row) => planOf(row) === key);
  if (bundle.insulin.length !== insulin.length) problems.push("insulin count");
  for (const row of insulin) {
    const found = bundle.insulin.find((item) =>
      item.evidence.some((ref) => ref.source_row === row.line),
    );
    if (!found) {
      problems.push(`insulin ${row.line}: missing`);
      continue;
    }
    const tier = row.TIER === "." || row.TIER === "" ? null : Number(row.TIER);
    if (found.tier !== tier) problems.push(`insulin ${row.line}: tier`);
    if (found.supply !== SUPPLY[row.DAYS_SUPPLY!])
      problems.push(`insulin ${row.line}: supply`);
    CHANNEL.forEach(([name, s], i) => {
      const channel = found.channels[i]!;
      const copay = row[`COPAY_AMT_${s}_INSLN`]!;
      const coin = row[`COIN_AMT_${s}_INSLN`]!;
      if (copay === "" && coin === "") {
        if (channel.status === "filed")
          problems.push(`insulin ${row.line}: ${name} blank read as filed`);
        return;
      }
      if (
        channel.status !== "filed" ||
        channel.copay.status !== "value" ||
        channel.copay.cents !== cents(copay) ||
        channel.coinsurance.status !== "value" ||
        channel.coinsurance.basis_points !== basisPoints(coin)
      )
        problems.push(`insulin ${row.line}: ${name}`);
    });
  }
  const formulary = raw.formulary.filter(
    (row) => row.FORMULARY_ID === bundle.formulary_id,
  );
  for (const drug of bundle.drugs) {
    const rows = formulary.filter((row) => row.RXCUI === drug.rxcui);
    if (drug.status !== (rows.length ? "listed" : "not_listed"))
      problems.push(`drug ${drug.rxcui}: status`);
    if (drug.packages.length !== rows.length)
      problems.push(`drug ${drug.rxcui}: packages`);
    for (const row of rows) {
      const item = drug.packages.find(
        (p) => p.evidence.source_row === row.line,
      );
      if (
        !item ||
        item.proxy_ndc !== row.NDC ||
        item.tier !== Number(row.TIER_LEVEL_VALUE) ||
        item.prior_authorization !== (row.PRIOR_AUTHORIZATION_YN === "Y") ||
        item.quantity_limit !== (row.QUANTITY_LIMIT_YN === "Y") ||
        item.selected_drug !== (row.SELECTED_DRUG_YN === "Y")
      )
        problems.push(`drug ${drug.rxcui}: row ${row.line}`);
    }
  }
  problems.push(...bundleProvenanceProblems(bundle));
  return problems;
}

/** Replaces text in one table of the fixture archive before it is imported. */
const edit =
  (table: RegExp, from: RegExp | string, to: string): Edit =>
  (name, inner) => {
    if (!table.test(name)) return;
    const key = Object.keys(inner)[0]!;
    const before = inner[key]!.toString("latin1");
    const after = before.replace(from, to);
    if (after === before) throw new Error(`edit of ${name} changed nothing`);
    inner[key] = Buffer.from(after, "latin1");
  };
const both =
  (...edits: Edit[]): Edit =>
  (name, inner) => {
    for (const one of edits) one!(name, inner);
  };

describe("Part D benefit bundle from an imported archive", () => {
  let directory: string;
  let raw: RawFixture;
  const rxcuis = ["861007", "860975", "197361", "1"];
  const plans = [
    "H0028-032-0",
    "H0028-042-0",
    "H0504-015-0",
    "H6515-001-0",
    "S4802-013-0",
    "S4802-155-0",
  ];
  const opened: Database[] = [];

  async function imported(mutate?: Edit, url = spufUrl): Promise<Database> {
    const migrations = await coreMigrations();
    const dataDir = await mkdtemp(join(directory, "cache-"));
    const db = testDatabase(new PGlite());
    opened.push(db);
    try {
      await migrate(db, migrations.directory);
      const bytes = await spufArchive(mutate);
      const transport: Transport = async () => ({
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([bytes]),
      });
      const archive = parseSpufUrl(url)!;
      await acquireSpuf(archive, {
        dataDir,
        dependencies: { lookup, transport },
      });
      await importSpuf(db, (await cachedSpuf(archive.kind, dataDir))[0]!);
      return db;
    } finally {
      await migrations.cleanup();
    }
  }
  const read = (db: Database, plan: string, year = 2026, snapshotId?: string) =>
    readBenefitBundle(db, {
      plan: parsePlanKey(plan)!,
      year,
      rxcuis,
      snapshotId,
    });

  let clean: Database;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "part-d-bundle-"));
    raw = {
      plans: await rawTable("plan information"),
      costs: await rawTable("beneficiary cost"),
      insulin: await rawTable("insulin beneficiary"),
      formulary: await rawTable("basic drugs"),
    };
    clean = await imported();
  }, 180_000);
  afterAll(async () => {
    for (const db of opened) await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("matches the raw rows for every fixture plan, with a source row behind every value", async () => {
    for (const plan of plans) {
      const bundle = await read(clean, plan);
      expect(bundle.status, plan).toBe("available");
      expect(compare(raw, bundle), plan).toEqual([]);
      if (bundle.status !== "available") continue;
      expect(bundle.conflicts, plan).toEqual([]);
      expect(bundle.rules.status).toBe("value");
      expect(bundle.drugs.find((d) => d.rxcui === "1")).toMatchObject({
        status: "not_listed",
        product: "none",
      });
    }
    // Byte-stable: the same pinned release reads back identically.
    expect(JSON.stringify(await read(clean, plans[0]!))).toBe(
      JSON.stringify(await read(clean, plans[0]!)),
    );
  });

  it("covers the fixture's tiers, insulin rows and listed drugs", async () => {
    const bundle = await read(clean, "H0028-032-0");
    if (bundle.status !== "available") throw new Error(bundle.reason);
    expect(bundle.tiers.length).toBe(28);
    expect(bundle.insulin.length).toBe(9);
    expect(bundle.drugs.filter((d) => d.status === "listed")).toHaveLength(3);
    expect(bundle.release).toMatchObject({
      kind: "quarterly",
      contract_year: 2026,
    });
    expect(bundle.deductible).toMatchObject({ cents: 61500 });
  });

  describe("planted errors in the reading are caught", () => {
    const mutants: [
      string,
      (b: BenefitBundle & { status: "available" }) => void,
    ][] = [
      [
        "60- and 90-day supply swapped",
        (b) => {
          const t = b.tiers.find((x) => x.supply === "90_days")!;
          t.supply = "60_days";
        },
      ],
      [
        ".25 read as 0.25%",
        (b) => {
          for (const t of b.tiers)
            for (const c of t.channels)
              if (
                c.status === "coinsurance" &&
                c.amount?.status === "value" &&
                "basis_points" in c.amount
              )
                c.amount.basis_points = c.amount.basis_points / 100;
        },
      ],
      [
        "deductible-applies flag flipped",
        (b) => {
          b.tiers[0]!.deductible_applies = !b.tiers[0]!.deductible_applies;
        },
      ],
      [
        "a cost row cited from its neighbour",
        (b) => {
          b.tiers[0]!.evidence[0]!.source_row += 1;
        },
      ],
      [
        "a cost row dropped",
        (b) => {
          b.tiers.pop();
        },
      ],
      [
        "a blank insulin channel read as filed",
        (b) => {
          const channel = b.insulin
            .flatMap((i) => i.channels)
            .find((c) => c.status !== "filed")!;
          channel.status = "filed";
        },
      ],
      [
        "the deductible taken from another year's standard",
        (b) => {
          if (b.deductible.status === "value") b.deductible.cents = 70000;
        },
      ],
      [
        "the first proxy NDC dropped",
        (b) => {
          b.drugs[0]!.packages.shift();
        },
      ],
      [
        "a figure cited from another release",
        (b) => {
          b.insulin[0]!.evidence[0]!.snapshot_id =
            "cms-partd-spuf-monthly-2027";
        },
      ],
    ];
    it.each(mutants)("%s", async (_name, mutate) => {
      const bundle = await read(clean, "H0028-032-0");
      if (bundle.status !== "available") throw new Error(bundle.reason);
      expect(compare(raw, bundle)).toEqual([]);
      mutate(bundle);
      expect(compare(raw, bundle).length).toBeGreaterThan(0);
    });
  });

  it("pins one release by contract year and never borrows another year", async () => {
    expect(await read(clean, "H0028-032-0", 2027)).toMatchObject({
      status: "unknown",
      reason: "not_loaded",
    });
    const pinned = await read(clean, "H0028-032-0");
    if (pinned.status !== "available") throw new Error(pinned.reason);
    expect(
      await read(clean, "H0028-032-0", 2027, pinned.release.snapshot_id),
    ).toMatchObject({ status: "unknown", reason: "release_not_active" });
    expect(
      await read(clean, "H0028-032-0", 2026, pinned.release.snapshot_id),
    ).toEqual(pinned);
    expect(await read(clean, "H9999-001-0")).toMatchObject({
      status: "unknown",
      reason: "plan_not_in_part_d_files",
    });
    expect(
      await readBenefitBundle(clean, {
        plan: parsePlanKey("H0028-032-0")!,
        year: 2026,
        rxcuis: ["12a"],
      }),
    ).toMatchObject({ status: "unknown", reason: "invalid_rxcui" });
  });

  it("reads a 2027 monthly release with 2027 rules", async () => {
    const db = await imported(
      edit(/^basic drugs/, /\|2026\|/g, "|2027|"),
      monthly2027,
    );
    const bundle = await read(db, "H0028-032-0", 2027);
    if (bundle.status !== "available") throw new Error(bundle.reason);
    expect(bundle.release).toMatchObject({
      kind: "monthly",
      contract_year: 2027,
    });
    expect(bundle.rules).toMatchObject({
      standard_deductible: { cents: 70000 },
    });
    expect(compare(raw, bundle)).toEqual([]);
    expect(await read(db, "H0028-032-0", 2026)).toMatchObject({
      reason: "not_loaded",
    });
  }, 180_000);

  it("rejects a formulary file whose rows name another contract year", async () => {
    await expect(imported(undefined, monthly2027)).rejects.toThrow(
      /another contract year/,
    );
  }, 180_000);

  it("rejects a cost file that lacks a column the reader needs", async () => {
    await expect(
      imported(
        edit(
          /^beneficiary cost/,
          "|TIER_SPECIALTY_YN|DED_APPLIES_YN",
          "|TIER_SPECIALTY_YN|DED_APPLIES",
        ),
      ),
    ).rejects.toThrow(/lacks DED_APPLIES_YN/);
    await expect(
      imported(
        edit(
          /^insulin/,
          "coin_amt_mail_nonpref_insln",
          "coin_amt_mail_nonpref",
        ),
      ),
    ).rejects.toThrow(/lacks COIN_AMT_MAIL_NONPREF_INSLN/);
  }, 180_000);

  it("returns unknown for a plan CMS suppressed", async () => {
    const db = await imported(
      edit(
        /^plan information/,
        /(H0504\|015\|000\|[^\r\n]*)\|N(\r?\n)/,
        "$1|Y$2",
      ),
    );
    expect(await read(db, "H0504-015-0")).toMatchObject({
      status: "unknown",
      reason: "plan_suppressed_by_cms",
    });
  }, 180_000);

  it("keeps edge rows apart: blank insulin tier, duplicates, stale catastrophic cost and a second NDC", async () => {
    const db = await imported(
      both(
        // Blank tier, as defined standard plans file it.
        edit(/^insulin/, /\nH0504\|015\|000\|3\|1\|/, "\nH0504|015|000|.|1|"),
        // An identical duplicate and a disagreeing duplicate of H0028-042 rows.
        edit(
          /^beneficiary cost/,
          /\nH0028\|042\|000\|0\|1\|1\|([^\r\n]*)\r\n/,
          "\nH0028|042|000|0|1|1|$1\r\nH0028|042|000|0|1|1|$1\r\n",
        ),
        edit(
          /^beneficiary cost/,
          /\nH0028\|042\|000\|1\|2\|1\|([^\r\n]*)\r\n/,
          "\nH0028|042|000|1|2|1|$1\r\nH0028|042|000|1|2|1|1|99|0|0|1|99|0|0|1|99|0|0|1|99|0|0|N|N\r\n",
        ),
        // Catastrophic copay of $10 on S4802-155 tier 3, 30 days.
        edit(
          /^beneficiary cost/,
          /\nS4802\|155\|000\|3\|3\|1\|[^\r\n]*\r\n/,
          "\nS4802|155|000|3|3|1|1|10|0|0|1|10|0|0|1|10|0|0|1|10|0|0|N|N\r\n",
        ),
        // A second proxy NDC for one RxCUI on formulary 00026144 (H6515-001).
        edit(
          /^basic drugs/,
          /\n00026144\|15\|2026\|197361\|82009002710\|([^\r\n]*)\r\n/,
          "\n00026144|15|2026|197361|82009002710|$1\r\n00026144|15|2026|197361|82009002799|$1\r\n",
        ),
      ),
    );
    const standard = await read(db, "H0504-015-0");
    if (standard.status !== "available") throw new Error(standard.reason);
    expect(standard.insulin.filter((i) => i.tier === null)).toHaveLength(1);
    expect(
      standard.insulin
        .filter((i) => i.tier === null)[0]!
        .channels.some((c) => c.status === "filed"),
    ).toBe(true);
    expect(compare(raw, standard)).not.toEqual([]);

    const duplicated = await read(db, "H0028-042-0");
    if (duplicated.status !== "available") throw new Error(duplicated.reason);
    expect(duplicated.conflicts.map((c) => c.code)).toEqual([
      "duplicate_cost_rows_disagree",
    ]);
    const twice = duplicated.tiers.find(
      (t) =>
        t.phase === "pre_deductible" && t.tier === 1 && t.supply === "30_days",
    )!;
    expect(twice.evidence).toHaveLength(2);
    expect(
      duplicated.tiers.some(
        (t) =>
          t.phase === "initial_coverage" &&
          t.tier === 2 &&
          t.supply === "30_days",
      ),
    ).toBe(false);

    const stale = await read(db, "S4802-155-0");
    if (stale.status !== "available") throw new Error(stale.reason);
    expect(stale.conflicts.map((c) => c.code)).toEqual([
      "catastrophic_cost_sharing_conflicts_with_rules",
    ]);
    // The set-aside $10 stays visible as the filed amount.
    expect(stale.conflicts[0]!.filed).toEqual(
      CHANNEL.map(([channel]) => ({ channel, raw: "10" })),
    );
    expect(
      stale.tiers.some(
        (t) =>
          t.phase === "catastrophic" && t.tier === 3 && t.supply === "30_days",
      ),
    ).toBe(false);

    const ambiguous = await read(db, "H6515-001-0");
    if (ambiguous.status !== "available") throw new Error(ambiguous.reason);
    expect(ambiguous.drugs.find((d) => d.rxcui === "197361")).toMatchObject({
      status: "listed",
      product: "ambiguous",
      reason: "ambiguous_drug_product",
    });
    for (const bundle of [standard, duplicated, stale, ambiguous])
      expect(bundleProvenanceProblems(bundle)).toEqual([]);
  }, 180_000);
});
