#!/usr/bin/env node
/**
 * Cache-only check of Part D plan-average drug prices (`price_basis: "cms_plan_average"`). It
 * reads the fixed sample in medicare-part-d-price-cases.json, takes the raw-file answers from
 * medicare-part-d-price-reference.py and compares them with the application's answers through
 * comparePriceAnswers.
 *
 * The application's answers come from the estimate service on a database that holds the year's
 * quarterly release with its pricing and dispensing-fee tables (DATABASE_URL). Each case is one
 * fill: the opening state has the plan deductible met and nothing else toward TrOOP, or TrOOP at
 * the threshold for a catastrophic case. Insulin and vaccine status are the case's own, and a
 * drug the plan's formulary flags as selected is priced as a selected drug, as the reference
 * reads it; other program facts stay as the files leave them. A bounded
 * answer matches the reference's `dispensing_fee_unknown` only when its ends equal the
 * reference's lowest-fee and highest-fee readings (compareApplicationAnswers).
 *
 * The report goes to reports/medicare-part-d-price-<year>.json under the data directory. A build
 * without the price path writes `app_not_ready` and exits 0; a missing database writes
 * `app_database_missing` and exits 1, so a check that could not run never passes as a match.
 *
 * Usage: DATABASE_URL=... node scripts/oracle/medicare-part-d-price.mjs [--cases FILE]
 *   [--reference FILE] [--archive SPUF_ZIP | --cached] [--optional] [--year 2026]
 * With --archive and no --reference, the Python reference runs on the archive first, with the
 * cached CMS maximum fair price file when the data directory holds it (without it, selected
 * drugs answer `maximum_fair_price_not_loaded` and differ from the application). --cached
 * takes the year's newest quarterly archive from the data directory instead, without network.
 * --optional (scripts/realdata.sh) prints SKIP and exits 0, writing no report, when there is no
 * database or no cached archive; it never turns a check that ran into a pass.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareApplicationAnswers,
  countApplicationAnswers,
  countPriceAnswers,
} from "./medicare-part-d-price-logic.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const here = fileURLToPath(new URL(".", import.meta.url));
const year = Number(option("--year") ?? 2026);
const casesFile =
  option("--cases") ?? join(here, "medicare-part-d-price-cases.json");
const dataDir =
  process.env.OPENPLANS_DATA_DIR ?? join(homedir(), ".local/share/openplans");
const reportFile = join(
  dataDir,
  "reports",
  `medicare-part-d-price-${year}.json`,
);

/** Whether the estimate service prices fills from plan averages, probed without a database. */
export async function applicationReady() {
  let service;
  try {
    service = await import("../../dist/services/medicare-drug-cost.js");
  } catch {
    return { ready: false, reason: "dist_not_built" };
  }
  const answer = await service.drugCostEstimate(
    null,
    { contractId: "S0000", planId: "000", segmentId: "0" },
    year,
    {
      scenario: "price-probe",
      price_basis: "cms_plan_average",
      channel: "preferred_retail",
      opening_state: { kind: "new_calendar_year" },
      fills: [],
    },
    {
      ...service.drugCostDeps,
      enabled: () => true,
      partD: () => true,
      pricing: () => true,
      readBundle: async () => ({
        status: "unknown",
        reason: "price_probe",
        release: null,
      }),
    },
  );
  return answer.reason === "price_basis_not_supported"
    ? { ready: false, reason: "price_basis_not_supported" }
    : { ready: true, reason: null };
}

// TrOOP at which a catastrophic case opens; the threshold of the year (Rate Announcement).
const THRESHOLD_CENTS = { 2026: 210000 };
const FIGURES = [
  "unit_cost_total",
  "total_lowest_fee",
  "total_highest_fee",
  "gross",
  "maximum_fair_price_total",
];

/**
 * The cached CMS Selected Drug List and Maximum Fair Price zip pinned in drug-lists.json, or
 * null. The reference reads it for drugs the formulary flags as selected.
 */
async function mfpFile() {
  const lists = JSON.parse(
    await readFile(
      join(here, "../../data/medicare-part-d/drug-lists.json"),
      "utf8",
    ),
  );
  const doc = lists.documents.find(
    (item) => item.id === lists.maximumFairPrices.document,
  );
  const path = join(dataDir, "raw", lists.cacheSource, doc.sha256, "payload");
  try {
    await readFile(path);
    return path;
  } catch {
    return null;
  }
}
const out = (figure) => {
  if (!figure) return { status: "unknown", reason: "no_figure" };
  if (figure.status === "value")
    return { status: "value", cents: figure.cents };
  if (figure.status === "bounded")
    return {
      status: "bounded",
      minimum_cents: figure.minimum_cents,
      maximum_cents: figure.maximum_cents,
      reason: figure.reason,
    };
  return { status: "unknown", reason: figure.reason };
};

/** The application's answers for the sample, in the reference's shape, or null without a database. */
async function applicationAnswers(cases) {
  if (!process.env.DATABASE_URL) return null;
  const { createDatabase } = await import("../../dist/db/database.js");
  const { parsePlanKey } = await import("../../dist/domain/medicare/ids.js");
  const service = await import("../../dist/services/medicare-drug-cost.js");
  const db = createDatabase(process.env.DATABASE_URL);
  const deps = {
    ...service.drugCostDeps,
    enabled: () => true,
    partD: () => true,
    pricing: () => true,
  };
  try {
    const answers = [];
    for (const item of cases) {
      const key = parsePlanKey(item.plan_key);
      const { rxcui, selected } = (await listingFor(db, item)) ?? {};
      const facts = {
        insulin: item.classification.insulin,
        acip_vaccine: item.classification.acip_vaccine,
        program: selected ? "selected" : "unknown",
      };
      const bundle = await deps.readBundle(db, {
        plan: key,
        year: item.contract_year,
        rxcuis: rxcui ? [rxcui] : [],
      });
      const deductible =
        bundle.status === "available" && bundle.deductible.status === "value"
          ? bundle.deductible.cents
          : null;
      const troop =
        item.phase === "catastrophic"
          ? THRESHOLD_CENTS[item.contract_year]
          : deductible;
      const answer = await service.drugCostEstimate(
        db,
        key,
        item.contract_year,
        service.parseDrugCostRequest({
          scenario: "non_lis_no_other_payer",
          price_basis: "cms_plan_average",
          channel: item.channel,
          opening_state:
            troop === null
              ? { kind: "new_calendar_year" }
              : {
                  kind: "provided",
                  as_of: `${item.contract_year}-01-01`,
                  gross_covered_drug_cost_cents: troop,
                  troop_cents: troop,
                  plan_deductible_met_cents: deductible ?? 0,
                },
          fills: [
            {
              fill_id: "f1",
              date: `${item.contract_year}-01-02`,
              rxcui: rxcui ?? "0",
              proxy_ndc: item.ndc,
              quantity: item.quantity,
              unit: item.unit,
              days_supply: item.days_supply,
            },
          ],
        }),
        { ...deps, drugFacts: () => facts },
      );
      const fill = answer.fills?.[0];
      const figures = {};
      for (const name of FIGURES)
        figures[name] = fill
          ? out(fill.price?.figures?.[name])
          : { status: "unknown", reason: answer.reason };
      figures.member_cost = fill
        ? out(fill.figures.patient_pay)
        : { status: "unknown", reason: answer.reason };
      answers.push({ case_id: item.case_id, figures });
    }
    return answers;
  } finally {
    await db.close();
  }
}

/**
 * The RxCUI and selected-drug flag the plan lists for the case's NDC, else the RxCUI any
 * formulary in the same release lists it under.
 */
async function listingFor(db, item) {
  const [contract, plan, segment] = item.plan_key.split("-");
  const snapshot = (
    await db.query(
      `SELECT r.snapshot_id FROM partd_release r JOIN snapshot s USING(snapshot_id)
       WHERE s.validation_state='ACTIVE' AND r.contract_year=$1 AND r.kind='quarterly'
       ORDER BY r.as_of DESC, r.snapshot_id LIMIT 1`,
      [item.contract_year],
    )
  ).rows[0]?.snapshot_id;
  if (!snapshot) return null;
  const own = (
    await db.query(
      `SELECT f.rxcui, f.cells->>'SELECTED_DRUG_YN' = 'Y' AS selected
       FROM partd_plan p JOIN partd_formulary_drug f
         ON f.snapshot_id=p.snapshot_id AND f.formulary_id=p.formulary_id
       WHERE p.snapshot_id=$1 AND p.contract_id=$2 AND p.plan_id=$3 AND p.segment_id::int=$4
         AND f.ndc=$5 ORDER BY f.rxcui LIMIT 1`,
      [snapshot, contract, plan, Number(segment), item.ndc],
    )
  ).rows[0];
  if (own) return own;
  const other = (
    await db.query(
      `SELECT rxcui FROM partd_formulary_drug WHERE snapshot_id=$1 AND ndc=$2 ORDER BY rxcui LIMIT 1`,
      [snapshot, item.ndc],
    )
  ).rows[0];
  return other ? { rxcui: other.rxcui, selected: false } : null;
}

async function write(report) {
  await mkdir(join(dataDir, "reports"), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 1)}\n`);
}

/** The year's newest cached quarterly archive, or null. Reads the cache only. */
async function cachedArchive() {
  const { cachedSpuf } = await import("../../dist/ingest/medicare/spuf.js");
  // Newest label first.
  const found = (await cachedSpuf("quarterly")).find(
    (item) => item.archive.year === year,
  );
  return found?.path ?? null;
}

async function referenceAnswers(cached) {
  let file = option("--reference");
  if (!file) {
    const archive = option("--archive") ?? cached;
    if (!archive)
      throw new Error(
        "pass --reference FILE, --archive SPUF_ZIP or --cached with the archive in the cache",
      );
    file = join(
      dataDir,
      "reports",
      `medicare-part-d-price-reference-${year}.json`,
    );
    const mfp = await mfpFile();
    const run = spawnSync(
      "python3",
      [
        "-I",
        join(here, "medicare-part-d-price-reference.py"),
        archive,
        "--cases",
        casesFile,
        "--output",
        file,
        ...(mfp ? ["--mfp-file", mfp] : []),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (run.status !== 0) throw new Error("the Python reference failed");
  }
  return JSON.parse(await readFile(file, "utf8")).answers;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { cases } = JSON.parse(await readFile(casesFile, "utf8"));
  const probe = await applicationReady();
  if (!probe.ready) {
    await write({
      status: "app_not_ready",
      reason: probe.reason,
      year,
      cases: cases.length,
    });
    console.log(
      `SKIP medicare part d price ${year}: app_not_ready (${probe.reason})`,
    );
    process.exit(0);
  }
  let cached = null;
  if (args.includes("--cached") && !option("--reference")) {
    cached = await cachedArchive();
    if (!cached && args.includes("--optional")) {
      console.log(
        `SKIP medicare part d price ${year}: no quarterly Part D archive in the cache`,
      );
      process.exit(0);
    }
  }
  if (!process.env.DATABASE_URL && args.includes("--optional")) {
    console.log(
      `SKIP medicare part d price ${year}: no database with the release's prices (set OPENPLANS_PRICE_CHECK_DATABASE_URL)`,
    );
    process.exit(0);
  }
  const reference = await referenceAnswers(cached);
  const application = await applicationAnswers(cases);
  if (!application) {
    await write({
      status: "app_database_missing",
      year,
      cases: cases.length,
      reference: countPriceAnswers(reference),
    });
    console.error(
      "FAIL medicare part d price: app_database_missing; set DATABASE_URL to a database with the release loaded",
    );
    process.exit(1);
  }
  const { differences, notCompared } = compareApplicationAnswers(
    reference,
    application,
  );
  await write({
    status: differences.length ? "fail" : "pass",
    year,
    cases: cases.length,
    reference: countPriceAnswers(reference),
    application: countApplicationAnswers(application),
    differences,
    not_compared: notCompared,
    answers: application,
  });
  if (differences.length) {
    console.error(differences.slice(0, 50).join("\n"));
    process.exit(1);
  }
  console.log(
    `PASS medicare part d price ${year}: ${cases.length} cases, 0 differences, ${notCompared.length} figures the reference does not model`,
  );
}
