// The SBC feed source (kind `sbc-pdf`), run through the core feed runner against SYNTHETIC
// documents: SBCs drawn by the carrier-document test writer (tests/ingest/carrier-documents/
// synthetic_pdf.py, invented plans and values, labelled synthetic on every page), an invented
// discovery page and an invented catalog with invented cost sharing, served by an injected
// transport on a synthetic host. Nothing reaches a real publisher. Tests that read PDFs need
// Poppler's pdftotext and skip without it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../src/db/database.js";
import { runFeedSource } from "../../../src/plugins/sources/feed.js";
import {
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import plugin, {
  checkItem,
  createSbcSource,
  fileHiosIds,
  mapSbcPlan,
  pufCost,
  pythonSbcExtractor,
  resolveSharedSbcClaims,
  SBC_REFUSAL,
  SBC_UNKNOWN_REASON,
  sbcCost,
  sbcCostSharingEvidence,
  sbcRefusal,
  selectSbcLinks,
} from "../src/index.js";
import type {
  CatalogVariant,
  SbcCostSharingAnswer,
  SbcItemAnswer,
} from "../src/index.js";

vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const packageRoot = here("../");
const writer = here("../../../tests/ingest/carrier-documents/synthetic_pdf.py");
const operatorFixture = here(
  "../../../tests/fixtures/access/carrier-documents.json",
);
const sourceFile = (name: string) => new URL(`../src/${name}`, import.meta.url);
const poppler = !spawnSync(process.env.OPENPLANS_PDFTOTEXT || "pdftotext", [
  "-v",
]).error;

const HOST = "docs.synthetic.test";
const BASE = `https://${HOST}`;
const DISCOVERY = `${BASE}/plans/documents`;
const ISSUER = "10001";
const ROBOTS = "User-agent: *\nAllow: /\n";
const TERMS = "Synthetic operator-reviewed terms";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Invented SBC file names: four in scope, three `plan` must leave out. */
const SBC_FILES = {
  bronze: "2026/TX_SBC/10001_SBC_Synthetic_Bronze_2026.pdf",
  gold: "2026/TX_SBC/10001_SBC_Synthetic_Gold_2026.pdf",
  shared: "2026/TX_SBC/10001_SBC_Synthetic_Shared_2026.pdf",
  wrongYear: "2026/TX_SBC/10001_SBC_Synthetic_Silver_2026.pdf",
};
const OUT_OF_SCOPE = [
  "2026/TX_SBC/Spanish/10001_SBC_Synthetic_Bronze_2026_SPA.pdf",
  "2024/TX_SBC/10001_SBC_Synthetic_Bronze_2024.pdf",
  "2026/TX/Synthetic_Brochure_2026.pdf",
];
const discoveryPage = (paths: readonly string[]) =>
  "<html><body>" +
  paths.map((path) => `<a href="/plans/${path}">${path}</a>`).join("") +
  `<a href="https://elsewhere.synthetic.test/plans/${SBC_FILES.bronze}">mirror</a>` +
  "</body></html>";

// Invented catalog, TX 2026, issuer 10001. Bronze has full federal cost sharing; Gold has
// variants but no cost-sharing rows (an SBE-like scope); two plans share a variant name.
interface SeedVariant {
  id: string;
  name: string;
}
const PLANS: { base: string; name: string; variants: SeedVariant[] }[] = [
  {
    base: "10001TX0010001",
    name: "Synthetic Bronze",
    variants: [
      { id: "10001TX0010001-00", name: "Synthetic Bronze" },
      { id: "10001TX0010001-01", name: "Synthetic Bronze" },
      { id: "10001TX0010001-03", name: "Synthetic Bronze Limited" },
    ],
  },
  {
    base: "10001TX0010002",
    name: "Synthetic Gold",
    variants: [
      { id: "10001TX0010002-00", name: "Synthetic Gold" },
      { id: "10001TX0010002-01", name: "Synthetic Gold" },
    ],
  },
  {
    base: "10001TX0010003",
    name: "Synthetic Silver One",
    variants: [
      { id: "10001TX0010003-01", name: "Synthetic Silver One" },
      { id: "10001TX0010003-02", name: "Synthetic Shared Name" },
    ],
  },
  {
    base: "10001TX0010004",
    name: "Synthetic Silver Two",
    variants: [
      { id: "10001TX0010004-01", name: "Synthetic Silver Two" },
      { id: "10001TX0010004-02", name: "Synthetic Shared Name" },
    ],
  },
];
const BRONZE_ATTRIBUTES = {
  TEHBDedInnTier1Individual: "$1,500 ",
  TEHBDedInnTier1FamilyPerGroup: "$3000 per group",
  TEHBInnTier1IndividualMOOP: "$6,000 ",
  TEHBInnTier1FamilyPerGroupMOOP: "$12000 per group",
};
/** Bronze's federal benefit rows: network copay and coinsurance as the PUF prints them. */
const BRONZE_BENEFITS: [string, string, string][] = [
  [
    "Primary Care Visit to Treat an Injury or Illness",
    "$30.00",
    "Not Applicable",
  ],
  ["Specialist Visit", "$60.00", "Not Applicable"],
  ["Preventive Care/Screening/Immunization", "No Charge", "Not Applicable"],
  ["Generic Drugs", "$10.00", "Not Applicable"],
  [
    "Emergency Room Services",
    "$350.00 Copay after deductible",
    "Not Applicable",
  ],
  ["Urgent Care Centers or Facilities", "$75.00", "Not Applicable"],
];

let scratch: string;
let manifest: string;
const pdfs = new Map<string, Buffer>();

function synthetic(args: string[]): Buffer {
  const out = join(
    scratch,
    `sbc-${pdfs.size}-${Math.random().toString(16).slice(2)}.pdf`,
  );
  execFileSync("python3", ["-B", writer, "feed-sbc", out, ...args]);
  return readFileSync(out);
}

async function seedCatalog(db: Database) {
  await db.query(
    "INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-catalog','Synthetic catalog','test')",
  );
  for (const id of ["synthetic-attributes-2026", "synthetic-benefits-2026"])
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
       VALUES ($1,'synthetic-catalog',$2,now(),0,0,'ACTIVE',now())`,
      [id, digest(id)],
    );
  await db.query(
    "INSERT INTO puf_import(import_id,state,plan_year) VALUES ('synthetic-attributes-2026','TX',2026)",
  );
  await db.query(
    `INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES
       ('synthetic-attributes-2026','plan-attributes','synthetic-attributes-2026'),
       ('synthetic-attributes-2026','benefits-and-cost-sharing','synthetic-benefits-2026')`,
  );
  await db.query(
    "INSERT INTO puf_active_catalog VALUES ('TX',2026,'synthetic-attributes-2026')",
  );
  let row = 0;
  for (const plan of PLANS) {
    await db.query(
      `INSERT INTO plan(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,market,metal,dental_only,
         network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange)
       VALUES ('synthetic-attributes-2026',$1,2026,'TX',$2,$3,'Individual','Bronze',false,'TXN001','TXS001',$4,'On Exchange',true,false)`,
      [++row, ISSUER, plan.base, plan.name],
    );
    for (const variant of plan.variants)
      await db.query(
        `INSERT INTO plan_variant(snapshot_id,source_row,plan_year,state,issuer_id,variant_plan_id,base_plan_id,csr_suffix,
           csr_variation_type,variant_name,exchange_status,raw)
         VALUES ('synthetic-attributes-2026',$1,2026,'TX',$2,$3,$4,right($3,2),'Synthetic variant',$5,'Both',$6::jsonb)`,
        [
          ++row,
          ISSUER,
          variant.id,
          plan.base,
          variant.name,
          JSON.stringify(
            plan.base === "10001TX0010001" ? BRONZE_ATTRIBUTES : {},
          ),
        ],
      );
  }
  for (const variant of ["10001TX0010001-00", "10001TX0010001-01"])
    for (const [benefit, copay, coins] of BRONZE_BENEFITS)
      await db.query(
        `INSERT INTO plan_benefit(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,published_plan_id,
           benefit_name,cost_sharing_raw,cost_sharing_parsed,raw)
         VALUES ('synthetic-benefits-2026',$1,2026,'TX',$2,'10001TX0010001',$3,$4,$5::jsonb,'{}'::jsonb,'{}'::jsonb)`,
        [
          ++row,
          ISSUER,
          variant,
          benefit,
          JSON.stringify({ CopayInnTier1: copay, CoinsInnTier1: coins }),
        ],
      );
}

async function freshDatabase() {
  const loaded = await loadForTest(plugin, { packageRoot });
  await seedCatalog(loaded.db as Database);
  return loaded;
}

function serve(files: Record<string, Buffer | string>) {
  const requests: string[] = [];
  const served: Record<string, Buffer | string> = {
    "/robots.txt": ROBOTS,
    "/terms": TERMS,
    ...files,
  };
  return {
    requests,
    transport: async (url: URL) => {
      const path = decodeURIComponent(url.pathname);
      requests.push(path);
      const body = served[path];
      return {
        status: body === undefined ? 404 : 200,
        headers: {},
        body: Readable.from([Buffer.from(body ?? "")]),
      };
    },
  };
}

async function runFeed(db: Database, files: Record<string, Buffer | string>) {
  const { requests, transport } = serve(files);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFeedSource(
    createSbcSource({ extractor: pythonSbcExtractor(), hosts: [HOST] }),
    ["--discovery", DISCOVERY, "--issuer", `TX:${ISSUER}`, "--years", "2026"],
    db,
    {
      declaredHosts: [HOST],
      dataDir: await mkdtemp(join(scratch, "data-")),
      manifestPaths: [manifest],
      transport,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      sleep: async () => {},
      maxAttempts: 1,
      output: {
        out: (line) => out.push(line),
        error: (line) => err.push(line),
      },
    },
  );
  const logs = err.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out, logs, requests };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-carrier-sbc-"));
  manifest = join(scratch, "operator.json");
  const template = (
    JSON.parse(await readFile(operatorFixture, "utf8")) as {
      publishers: Record<string, unknown>[];
    }
  ).publishers.find((entry) => entry.host === "chppayment.christushealth.org")!;
  const now = Date.now();
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      publishers: [
        {
          ...template,
          host: HOST,
          evidence: [
            {
              url: `${BASE}/robots.txt`,
              observedAt: new Date(now - 1000).toISOString(),
              status: 200,
            },
          ],
          scope: {
            products: ["Synthetic SBC documents"],
            states: ["TX"],
            years: [2026],
          },
          discoveryUrls: [DISCOVERY],
          permittedPaths: ["/plans/"],
          attribution: "Synthetic publisher for tests.",
          jobCaps: { maxRequests: 50, maxTransferBytes: 64 * 1024 ** 2 },
          robots: {
            url: `${BASE}/robots.txt`,
            status: 200,
            sha256: digest(ROBOTS),
            checkedAt: new Date(now - 1000).toISOString(),
          },
          terms: {
            url: `${BASE}/terms`,
            disposition: "allowed",
            sha256: digest(TERMS),
            reviewedAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now + 86_400_000).toISOString(),
          },
        },
      ],
    }),
  );
  if (poppler) {
    // Bronze: carrier labels, and a specialist copay that disagrees with the federal table.
    pdfs.set(
      "bronze",
      synthetic([
        "--plan",
        "Synthetic Bronze (Two Free Visits)",
        "--carrier-labels",
        "--value",
        "Specialist visit=$90 copay/visit",
      ]),
    );
    pdfs.set("gold", synthetic(["--plan", "Synthetic Gold"]));
    pdfs.set("shared", synthetic(["--plan", "Synthetic Shared Name"]));
    // Linked under 2026, printed with a 2025 coverage period.
    pdfs.set(
      "wrong-year",
      synthetic(["--plan", "Synthetic Silver One", "--period-year", "2025"]),
    );
  }
}, 60_000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("plan: SBC discovery", () => {
  const scope = { years: [2026], states: ["TX"], hosts: [HOST] };

  it("lists SBC PDFs on the source hosts for the run's years, never translated editions", () => {
    const links = selectSbcLinks(
      discoveryPage([...Object.values(SBC_FILES), ...OUT_OF_SCOPE]),
      DISCOVERY,
      scope,
    );
    expect(links.map((link) => link.url)).toEqual(
      Object.values(SBC_FILES)
        .map((path) => `${BASE}/plans/${path}`)
        .sort(),
    );
    expect(links.every((link) => link.urlYear === 2026)).toBe(true);
    expect(links.every((link) => link.states.join() === "TX")).toBe(true);
  });

  it("reads HIOS ids from file names and the year from the path when the name has none", () => {
    expect(fileHiosIds("71837TX001000100.pdf")).toEqual(["71837TX0010001-00"]);
    expect(fileHiosIds("10001TX0010001-01_SBC.pdf")).toEqual([
      "10001TX0010001-01",
    ]);
    expect(fileHiosIds("10001_SBC_Bronze_2026.pdf")).toEqual([]);
    const links = selectSbcLinks(
      '<a href="/files/2025/10001TX001000100.pdf">a</a><a href="/files/2026/10001TX001000200.pdf">b</a>',
      `${BASE}/plans/`,
      scope,
    );
    expect(links).toEqual([
      {
        url: `${BASE}/files/2026/10001TX001000200.pdf`,
        urlYear: 2026,
        hiosIds: ["10001TX0010002-00"],
        states: ["TX"],
      },
    ]);
  });
});

describe("plan mapping", () => {
  const catalog: CatalogVariant[] = PLANS.flatMap((plan) =>
    plan.variants.map((variant) => ({
      variantPlanId: variant.id,
      basePlanId: plan.base,
      name: variant.name,
    })),
  );

  it("attaches by printed marketing name the variants of one base plan that share it", () => {
    expect(
      mapSbcPlan([], "Synthetic Bronze (Two Free Visits)", catalog),
    ).toEqual({
      method: "marketing_name",
      status: "attached",
      variantPlanIds: ["10001TX0010001-00", "10001TX0010001-01"],
      candidates: 1,
    });
    expect(mapSbcPlan([], "Bronze Limited", catalog).variantPlanIds).toEqual([
      "10001TX0010001-03",
    ]);
  });

  const expectAmbiguous = (map: typeof mapSbcPlan) =>
    expect(map([], "Synthetic Shared Name", catalog)).toEqual({
      method: "marketing_name",
      status: "plan_mapping_ambiguous",
      variantPlanIds: [],
      candidates: 2,
    });

  it("a name two base plans share attaches nothing", () => {
    expectAmbiguous(mapSbcPlan);
    expect(mapSbcPlan([], "Synthetic Platinum", catalog).status).toBe(
      "plan_not_in_catalog",
    );
  });

  it("a HIOS id in the file name decides, and must be in the catalog; the name is not tried instead", () => {
    expect(
      mapSbcPlan(["10001TX0010002-01"], "Synthetic Bronze", catalog),
    ).toMatchObject({
      method: "hios_file_name",
      status: "attached",
      variantPlanIds: ["10001TX0010002-01"],
    });
    expect(
      mapSbcPlan(["10001TX0010002"], null, catalog).variantPlanIds,
    ).toEqual(["10001TX0010002-00", "10001TX0010002-01"]);
    expect(
      mapSbcPlan(["10001TX0019999-01"], "Synthetic Bronze", catalog),
    ).toEqual({
      method: "hios_file_name",
      status: "plan_not_in_catalog",
      variantPlanIds: [],
      candidates: 0,
    });
  });

  it("a variant two documents claim is ambiguous for both", () => {
    const one = mapSbcPlan([], "Synthetic Gold", catalog);
    const two = mapSbcPlan(["10001TX0010002-01"], null, catalog);
    resolveSharedSbcClaims([
      { key: "a", planYear: 2026, link: one },
      { key: "b", planYear: 2026, link: two },
    ]);
    expect([one.status, two.status]).toEqual([
      "plan_mapping_ambiguous",
      "plan_mapping_ambiguous",
    ]);
  });

  it("planted mutant: an ambiguous plan mapping attached", async () => {
    const mutant = await plantMutant(
      sourceFile("sbc-match.ts"),
      "if (bases.size === 1)",
      "if (bases.size >= 1)",
    );
    try {
      const { mapSbcPlan: mutated } = (await import(mutant.path)) as {
        mapSbcPlan: typeof mapSbcPlan;
      };
      expect(() => expectAmbiguous(mutated)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("coverage period", () => {
  const facts = { planYear: 2026, urlYear: 2026, matchedRows: 8 };
  const expectWrongYearRefused = (refusal: typeof sbcRefusal) => {
    expect(refusal({ ...facts, planYear: 2025 }, [2026])).toBe(
      SBC_REFUSAL.periodMismatch,
    );
    expect(refusal({ ...facts, planYear: 2025, urlYear: 2025 }, [2026])).toBe(
      SBC_REFUSAL.periodMismatch,
    );
    // Both years in the run: a 2025 SBC linked as the 2026 one is still refused.
    expect(refusal({ ...facts, planYear: 2025 }, [2025, 2026])).toBe(
      SBC_REFUSAL.periodMismatch,
    );
  };

  it("the printed coverage period must be the linked year and a run year", () => {
    expect(sbcRefusal(facts, [2026])).toBeUndefined();
    expectWrongYearRefused(sbcRefusal);
    expect(sbcRefusal({ ...facts, planYear: null }, [2026])).toBe(
      SBC_REFUSAL.periodUnresolved,
    );
    expect(sbcRefusal({ ...facts, matchedRows: 0 }, [2026])).toBe(
      SBC_REFUSAL.empty,
    );
  });

  it("planted mutant: a wrong-year SBC admitted", async () => {
    const mutant = await plantMutant(
      sourceFile("sbc-source.ts"),
      "facts.planYear !== facts.urlYear || !runYears.includes(facts.planYear)",
      "!runYears.includes(facts.planYear)",
    );
    try {
      const { sbcRefusal: mutated } = (await import(mutant.path)) as {
        sbcRefusal: typeof sbcRefusal;
      };
      expect(() => expectWrongYearRefused(mutated)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("cross-check readings", () => {
  it("reads one plain network cost from each side, or nothing", () => {
    expect(sbcCost("$50 copayment/visit; deductible does not apply")).toEqual({
      copay: 50,
      coinsurance: 0,
    });
    expect(sbcCost("50% coinsurance")).toEqual({ copay: 0, coinsurance: 50 });
    expect(sbcCost("No charge; deductible does not apply")).toEqual({
      copay: 0,
      coinsurance: 0,
    });
    expect(
      sbcCost("X-ray: 50% coinsurance Laboratory tests: $80 copayment"),
    ).toBeNull();
    expect(sbcCost("$0 first 3 visits, then $40 copay")).toBeNull();
    expect(sbcCost("Not covered")).toBeNull();
    expect(pufCost("$950.00 Copay after deductible", "Not Applicable")).toEqual(
      {
        copay: 950,
        coinsurance: 0,
      },
    );
    expect(
      pufCost("Not Applicable", "50.00% Coinsurance after deductible"),
    ).toEqual({
      copay: 0,
      coinsurance: 50,
    });
    expect(pufCost("No Charge after deductible", "Not Applicable")).toEqual({
      copay: 0,
      coinsurance: 0,
    });
    expect(pufCost("Not Applicable", "Not Applicable")).toBeNull();
  });

  it("compares deductibles and mapped chart rows; sub-rows and unmapped rows are not compared", () => {
    const puf = {
      attributes: true,
      columns: {
        TEHBDedInnTier1Individual: "$1,500",
        TEHBDedInnTier1FamilyPerGroup: "$3000 per group",
      },
      benefits: new Map([
        ["Specialist Visit", { copay: "$60.00", coins: "Not Applicable" }],
      ]),
    };
    const question = (network: string) =>
      checkItem(
        {
          section: "question",
          label: "What is the overall deductible?",
          subLabel: null,
          network,
        },
        puf,
      ).status;
    expect(question("$1,500/individual or $3,000/family")).toBe("agrees");
    expect(question("$1,750/individual or $3,500/family")).toBe("conflicting");
    const chart = (
      label: string,
      network: string,
      subLabel: string | null = null,
    ) => checkItem({ section: "chart", label, subLabel, network }, puf).status;
    expect(chart("Specialist visit", "$60 copay/visit")).toBe("agrees");
    expect(chart("Specialist visit", "$90 copay/visit")).toBe("conflicting");
    expect(chart("Urgent care", "$75 copay/visit")).toBe("puf_absent");
    expect(chart("Generic drugs", "$0 copay", "Preferred generic")).toBe(
      "no_puf_counterpart",
    );
    expect(chart("Physician/surgeon fees", "50% coinsurance")).toBe(
      "no_puf_counterpart",
    );
  });
});

const byItem = (answer: SbcCostSharingAnswer) => {
  expect(answer.status).toBe("available");
  return new Map(
    (
      answer as Extract<SbcCostSharingAnswer, { status: "available" }>
    ).items.map((item) => [item.item, item]),
  );
};

/** Bronze has federal values for every compared item: nothing may be served from its SBC. */
const expectPufWins = (items: Map<string, SbcItemAnswer>) => {
  expect(items.get("Specialist visit")).toMatchObject({
    status: "conflicting",
    puf: { benefit: "Specialist Visit", value: "copay $60, coinsurance 0%" },
    sbc: { value: "$90 copay/visit" },
  });
  expect(items.get("Primary care visit to treat an injury or illness")).toEqual(
    {
      item: "Primary care visit to treat an injury or illness",
      status: "puf_value",
      agrees: true,
    },
  );
  expect(items.get("What is the overall deductible?")).toMatchObject({
    status: "puf_value",
    agrees: true,
  });
  expect(items.get("Generic drugs: Preferred generic")).toMatchObject({
    status: "unknown",
    reason: SBC_UNKNOWN_REASON.pufCoversPlan,
  });
  expect(
    [...items.values()].filter((item) => item.status === "served"),
  ).toEqual([]);
};

describe.skipIf(!poppler)(
  "feed run on synthetic SBCs (needs pdftotext)",
  () => {
    const files = () => ({
      "/plans/documents": discoveryPage([
        ...Object.values(SBC_FILES),
        ...OUT_OF_SCOPE,
      ]),
      [`/plans/${SBC_FILES.bronze}`]: pdfs.get("bronze")!,
      [`/plans/${SBC_FILES.gold}`]: pdfs.get("gold")!,
      [`/plans/${SBC_FILES.shared}`]: pdfs.get("shared")!,
      [`/plans/${SBC_FILES.wrongYear}`]: pdfs.get("wrong-year")!,
    });
    let loaded: Awaited<ReturnType<typeof freshDatabase>>;
    let db: Database;
    let run: Awaited<ReturnType<typeof runFeed>>;

    beforeAll(async () => {
      loaded = await freshDatabase();
      db = loaded.db as Database;
      run = await runFeed(db, files());
    }, 120_000);
    afterAll(async () => {
      await loaded?.close();
    });

    it("refuses the wrong-year SBC and admits the rest with provenance", async () => {
      expect(run.code, JSON.stringify(run.logs)).toBe(0);
      expect(
        run.requests.filter((path) => path.endsWith(".pdf")).sort(),
      ).toEqual(
        Object.values(SBC_FILES)
          .map((path) => `/plans/${path}`)
          .sort(),
      );
      expect(
        run.logs.find((log) => log.code === "carrier_sbc_refused"),
      ).toMatchObject({
        url: `${BASE}/plans/${SBC_FILES.wrongYear}`,
        reason: SBC_REFUSAL.periodMismatch,
        printed_year: 2025,
      });
      const { rows: documents } = await db.query<Record<string, unknown>>(
        `SELECT url, plan_year, coverage_start::text AS start, printed_plan_name, document_sha256
       FROM plg_carrierdoc_sbc_document ORDER BY url`,
      );
      expect(documents.map((d) => d.url)).toEqual(
        [SBC_FILES.bronze, SBC_FILES.gold, SBC_FILES.shared].map(
          (p) => `${BASE}/plans/${p}`,
        ),
      );
      expect(documents[0]).toMatchObject({
        plan_year: 2026,
        start: "2026-01-01",
        printed_plan_name: "Synthetic Bronze (Two Free Visits)",
        document_sha256: digest(pdfs.get("bronze")!),
      });
      const { rows: states } = await db.query<{
        validation_state: string;
        n: number;
      }>(
        `SELECT validation_state, count(*)::int AS n FROM snapshot WHERE source_id = 'carrier-sbc-pdf'
       AND snapshot_id IN (SELECT snapshot_id FROM snapshot WHERE source_id = 'carrier-sbc-pdf')
       GROUP BY 1 ORDER BY 1`,
      );
      expect(states.find((s) => s.validation_state === "QUARANTINED")?.n).toBe(
        1,
      );
    });

    it("keeps the carrier's sub-rows and (Tier n) labels under the template label", async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT r.item, r.label_match, r.page, r.confidence FROM plg_carrierdoc_sbc_row r
       JOIN plg_carrierdoc_sbc_document d USING (snapshot_id)
       WHERE d.url LIKE '%Bronze%' AND r.label = ANY($1::text[]) ORDER BY r.ordinal`,
        [["Generic drugs", "Preferred brand drugs", "Specialty drugs"]],
      );
      expect(rows).toEqual([
        {
          item: "Generic drugs: Preferred generic",
          label_match: "sub_row",
          page: 1,
          confidence: "high",
        },
        {
          item: "Generic drugs: Non-preferred generic",
          label_match: "sub_row",
          page: 1,
          confidence: "high",
        },
        {
          item: "Preferred brand drugs",
          label_match: "tier_suffix",
          page: 1,
          confidence: "high",
        },
        {
          item: "Specialty drugs",
          label_match: "tier_suffix",
          page: 1,
          confidence: "high",
        },
      ]);
    });

    it("attaches by name, leaves the shared name unattached, and records the cross-check", async () => {
      const { rows: links } = await db.query<Record<string, unknown>>(
        `SELECT d.printed_plan_name, l.method, l.status, l.variant_plan_id FROM plg_carrierdoc_sbc_link l
       JOIN plg_carrierdoc_sbc_document d USING (snapshot_id) ORDER BY 1, 4`,
      );
      expect(links).toEqual([
        {
          printed_plan_name: "Synthetic Bronze (Two Free Visits)",
          method: "marketing_name",
          status: "attached",
          variant_plan_id: "10001TX0010001-00",
        },
        {
          printed_plan_name: "Synthetic Bronze (Two Free Visits)",
          method: "marketing_name",
          status: "attached",
          variant_plan_id: "10001TX0010001-01",
        },
        {
          printed_plan_name: "Synthetic Gold",
          method: "marketing_name",
          status: "attached",
          variant_plan_id: "10001TX0010002-00",
        },
        {
          printed_plan_name: "Synthetic Gold",
          method: "marketing_name",
          status: "attached",
          variant_plan_id: "10001TX0010002-01",
        },
        {
          printed_plan_name: "Synthetic Shared Name",
          method: "marketing_name",
          status: "plan_mapping_ambiguous",
          variant_plan_id: null,
        },
      ]);
      const { rows: checks } = await db.query<Record<string, unknown>>(
        `SELECT item, status, puf_value FROM plg_carrierdoc_sbc_check
       WHERE variant_plan_id = '10001TX0010001-01' AND status IN ('agrees', 'conflicting') ORDER BY ordinal`,
      );
      expect(checks).toEqual([
        {
          item: "What is the overall deductible?",
          status: "agrees",
          puf_value: "$1,500 | $3000 per group",
        },
        {
          item: "What is the out-of-pocket limit for this plan?",
          status: "agrees",
          puf_value: "$6,000 | $12000 per group",
        },
        {
          item: "Primary care visit to treat an injury or illness",
          status: "agrees",
          puf_value: "copay $30, coinsurance 0%",
        },
        {
          item: "Specialist visit",
          status: "conflicting",
          puf_value: "copay $60, coinsurance 0%",
        },
        {
          item: "Preventive care/screening/immunization",
          status: "agrees",
          puf_value: "copay $0, coinsurance 0%",
        },
        {
          item: "Emergency room care",
          status: "agrees",
          puf_value: "copay $350, coinsurance 0%",
        },
        {
          item: "Urgent care",
          status: "agrees",
          puf_value: "copay $75, coinsurance 0%",
        },
      ]);
    });

    it("where the federal tables have values they win, and a disagreement is conflicting", async () => {
      expectPufWins(
        byItem(
          await sbcCostSharingEvidence(db, {
            planId: "10001TX0010001-01",
            planYear: 2026,
          }),
        ),
      );
    });

    it("serves SBC values, labelled, only where the federal tables have none", async () => {
      const items = byItem(
        await sbcCostSharingEvidence(db, {
          planId: "10001TX0010002-01",
          planYear: 2026,
        }),
      );
      expect(items.get("Specialist visit")).toEqual({
        item: "Specialist visit",
        status: "served",
        source: "sbc_document",
        value: "$60 copay/visit",
        evidence: {
          url: `${BASE}/plans/${SBC_FILES.gold}`,
          sha256: digest(pdfs.get("gold")!),
          plan_year: 2026,
          coverage_period: { start: "2026-01-01", end: "2026-12-31" },
          printed_plan_name: "Synthetic Gold",
          page: 1,
        },
      });
      expect(items.get("What is the overall deductible?")).toMatchObject({
        status: "served",
        value: "$1,500/individual or $3,000/family",
      });
      expect(
        [...items.values()].every((item) => item.status === "served"),
      ).toBe(true);
    });

    it("answers unknown for an ambiguous mapping, an unmapped variant and a base id", async () => {
      const ask = (planId: string) =>
        sbcCostSharingEvidence(db, { planId, planYear: 2026 });
      expect(await ask("10001TX0010003-02")).toEqual({
        status: "unknown",
        reason: SBC_UNKNOWN_REASON.ambiguous,
      });
      expect(await ask("10001TX0010001-03")).toMatchObject({
        status: "unknown",
      });
      expect(await ask("10001TX0010001")).toEqual({
        status: "unknown",
        reason: SBC_UNKNOWN_REASON.variantRequired,
      });
      expect(
        await sbcCostSharingEvidence(db, {
          planId: "10001TX0010001-01",
          planYear: 2025,
        }),
      ).toEqual({ status: "unknown", reason: SBC_UNKNOWN_REASON.noDocument });
    });

    it("planted mutant: an SBC value served where the PUF has one", async () => {
      const mutant = await plantMutant(
        sourceFile("sbc-evidence.ts"),
        'return { item: row.item, status: "puf_value", agrees: true };',
        "break;",
      );
      try {
        const { sbcCostSharingEvidence: mutated } = (await import(
          mutant.path
        )) as {
          sbcCostSharingEvidence: typeof sbcCostSharingEvidence;
        };
        const answer = await mutated(db, {
          planId: "10001TX0010001-01",
          planYear: 2026,
        });
        expect(() => expectPufWins(byItem(answer))).toThrow();
      } finally {
        await mutant.cleanup();
      }
    });

    it("planted mutant: a conflicting row served", async () => {
      const mutant = await plantMutant(
        sourceFile("sbc-evidence.ts"),
        'case "conflicting":',
        'case "conflicting":\n        break;',
      );
      try {
        const { sbcCostSharingEvidence: mutated } = (await import(
          mutant.path
        )) as {
          sbcCostSharingEvidence: typeof sbcCostSharingEvidence;
        };
        const answer = await mutated(db, {
          planId: "10001TX0010001-01",
          planYear: 2026,
        });
        expect(byItem(answer).get("Specialist visit")).toMatchObject({
          status: "served",
        });
        expect(() => expectPufWins(byItem(answer))).toThrow();
      } finally {
        await mutant.cleanup();
      }
    });
  },
);
