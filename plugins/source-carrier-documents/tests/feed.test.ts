// The formulary-PDF feed source, run through the core feed runner against SYNTHETIC documents:
// drug lists drawn by the carrier-document test writer (tests/ingest/carrier-documents/
// synthetic_pdf.py, invented plans and values, labelled synthetic on every page), an invented
// discovery page and an invented catalog, served by an injected transport on a synthetic host.
// Nothing reaches a real publisher. Tests that read PDFs need Poppler's pdftotext and skip without it.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../src/db/database.js";
import type { Transport } from "../../../src/fetch/index.js";
import { runFeedSource } from "../../../src/plugins/sources/feed.js";
import {
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { loadWorkerPlugins } from "../../../src/plugins/worker.js";
import { approvedTestEnvironment } from "../../../tests/plugins/approval-helpers.js";
import packageJson from "../package.json" with { type: "json" };
import plugin, {
  admittedTiers,
  baseNameKey,
  createFormularySource,
  documentRefusal,
  DOCUMENT_HOSTS,
  formularyDocumentEvidence,
  FORMULARY_ARGV,
  IDENTITY_JOIN_ARGV,
  matchCoverPlans,
  MAX_UNDEFINED_TIER_SHARE,
  pythonExtractor,
  REFUSAL,
  resolveSharedClaims,
  SBC_ARGV,
  SBC_SOURCE_ID,
  selectFormularyLinks,
  UNKNOWN_REASON,
} from "../src/index.js";
import type { CatalogPlan, StagedDocument } from "../src/index.js";

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
const DISCOVERY = `${BASE}/plans/formularies`;
const ISSUER = "10001";
const NOW = new Date("2026-11-20T12:00:00Z");
const ROBOTS = "User-agent: *\nAllow: /\n";
const TERMS = "Synthetic operator-reviewed terms";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Discovery page: two documents in scope and five that `plan` must leave out. */
const discoveryPage = (names: readonly string[]) =>
  "<html><body>" +
  names
    .map(
      (name) =>
        `<a href="/plans/formulary/${encodeURIComponent(name)}">${name}</a>`,
    )
    .join("") +
  '<a href="https://elsewhere.synthetic.test/plans/formulary/TXSyntheticFormulary2026.pdf">mirror</a>' +
  "</body></html>";
const IN_SCOPE = [
  "TXSyntheticFormulary2026.pdf",
  "TXSyntheticFormulary2027.pdf",
];
const OUT_OF_SCOPE = [
  "TXSyntheticFormulary2024.pdf",
  "TXSyntheticFormulary2026 SPA.pdf",
  "LASyntheticFormulary2026.pdf",
  "TXSyntheticBrochure2026.pdf",
];

/** Catalog for issuer 10001, TX 2026. All names invented. */
const CATALOG_2026: CatalogPlan[] = [
  {
    basePlanId: "10001TX0010001",
    planName: "Synthetic Bronze (Two Free Visits)",
  },
  { basePlanId: "10001TX0010002", planName: "Synthetic Bronze Plus" },
  { basePlanId: "10001TX0010003", planName: "Synthetic Bronze Plus" },
  { basePlanId: "10001TX0010004", planName: "Synthetic Silver 73" },
  {
    basePlanId: "10001TX0010005",
    planName: "Synthetic Silver Essential Plus Limited",
  },
  { basePlanId: "10001TX0010006", planName: "Synthetic Gold" },
  { basePlanId: "10001TX0010007", planName: "Synthetic Platinum" },
];

let scratch: string;
let manifest: string;
const pdfs = new Map<string, Buffer>();

function synthetic(args: string[]): Buffer {
  const out = join(
    scratch,
    `pdf-${pdfs.size}-${Math.random().toString(16).slice(2)}.pdf`,
  );
  execFileSync("python3", ["-B", writer, "feed-formulary", out, ...args]);
  return readFileSync(out);
}

async function seedCatalog(db: Database) {
  await db.query(
    "INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-catalog','Synthetic catalog','test')",
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
     VALUES ('synthetic-catalog-2026','synthetic-catalog',$1,now(),0,0,'ACTIVE',now())`,
    ["a".repeat(64)],
  );
  await db.query(
    "INSERT INTO puf_import(import_id,state,plan_year) VALUES ('synthetic-catalog-2026','TX',2026)",
  );
  await db.query(
    "INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES ('synthetic-catalog-2026','plan-attributes','synthetic-catalog-2026')",
  );
  await db.query(
    "INSERT INTO puf_active_catalog VALUES ('TX',2026,'synthetic-catalog-2026')",
  );
  for (const [index, plan] of CATALOG_2026.entries())
    await db.query(
      `INSERT INTO plan(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,market,metal,dental_only,
         network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange)
       VALUES ('synthetic-catalog-2026',$1,2026,'TX',$2,$3,'Individual','Bronze',false,'TXN001','TXS001',$4,'On Exchange',true,false)`,
      [index + 1, ISSUER, plan.basePlanId, plan.planName],
    );
  await db.query(
    `INSERT INTO data_availability(state,plan_year,market,issuer_id,catalog_status,snapshot_id)
     VALUES ('TX',2026,'Individual',$1,'available','synthetic-catalog-2026')`,
    [ISSUER],
  );
}

async function freshDatabase() {
  const loaded = await loadForTest(plugin, { packageRoot });
  await seedCatalog(loaded.db as Database);
  return loaded;
}

interface Served {
  requests: string[];
  transport: Transport;
}
function serve(files: Record<string, Buffer | string>): Served {
  const requests: string[] = [];
  const served: Record<string, Buffer | string> = {
    "/robots.txt": ROBOTS,
    "/terms": TERMS,
    ...files,
  };
  return {
    requests,
    transport: async (url) => {
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

async function runFeed(
  db: Database,
  files: Record<string, Buffer | string>,
  years = "2026,2027",
  manifestPath = manifest,
) {
  const { requests, transport } = serve(files);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFeedSource(
    createFormularySource({ extractor: pythonExtractor(), hosts: [HOST] }),
    ["--discovery", DISCOVERY, "--issuer", `TX:${ISSUER}`, "--years", years],
    db,
    {
      declaredHosts: [HOST],
      dataDir: await mkdtemp(join(scratch, "data-")),
      manifestPaths: [manifestPath],
      transport,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      sleep: async () => {},
      maxAttempts: 1,
      now: () => NOW,
      output: {
        out: (line) => out.push(line),
        error: (line) => err.push(line),
      },
    },
  );
  const logs = err.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out, logs, requests };
}

const count = async (db: Database, table: string) =>
  Number(
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
      .rows[0]!.n,
  );

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-carrier-formulary-"));
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
            products: ["Synthetic formulary documents"],
            states: ["TX"],
            years: [2026, 2027],
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
    pdfs.set("2026", synthetic(["--year", "2026"]));
    pdfs.set("2027", synthetic(["--year", "2027"]));
    pdfs.set("no-legend", synthetic(["--year", "2026", "--no-legend"]));
    pdfs.set("printed-2025", synthetic(["--year", "2025"]));
    pdfs.set(
      "tier0-undocumented",
      synthetic([
        "--year",
        "2027",
        "--tier0",
        "undocumented",
        "--tier0-rows",
        "6",
      ]),
    );
    pdfs.set(
      "tier0-few",
      synthetic(["--year", "2027", "--tier0", "undocumented"]),
    );
    pdfs.set(
      "tier0-stated",
      synthetic(["--year", "2027", "--tier0", "stated"]),
    );
  }
}, 60_000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("plan: discovery", () => {
  const scope = { years: [2026, 2027], states: ["TX"], hosts: [HOST] };
  const body = discoveryPage([...IN_SCOPE, ...OUT_OF_SCOPE]);

  it("lists only formulary PDFs on the source hosts for the run's years and states", () => {
    expect(selectFormularyLinks(body, DISCOVERY, scope)).toEqual(
      IN_SCOPE.map((name, index) => ({
        url: `${BASE}/plans/formulary/${name}`,
        urlYear: 2026 + index,
        states: ["TX"],
      })),
    );
  });

  it("reads sitemap entries as well as links", () => {
    const sitemap = `<urlset><url><loc>${BASE}/plans/formulary/TXSyntheticFormulary2026.pdf</loc></url></urlset>`;
    expect(
      selectFormularyLinks(sitemap, DISCOVERY, scope).map((l) => l.urlYear),
    ).toEqual([2026]);
  });

  it("matches a document without a state code against every run state", () => {
    const links = selectFormularyLinks(
      discoveryPage(["Synthetic-Formulary-2026.pdf"]),
      DISCOVERY,
      { ...scope, states: ["LA", "TX"] },
    );
    expect(links.map((link) => link.states)).toEqual([["LA", "TX"]]);
  });

  it("planted mutant: a document outside the window is planned", async () => {
    const mutant = await plantMutant(
      sourceFile("discover.ts"),
      "!scope.years.includes(years[0]!)",
      "false",
    );
    try {
      const { selectFormularyLinks: mutated } = (await import(mutant.path)) as {
        selectFormularyLinks: typeof selectFormularyLinks;
      };
      const urls = mutated(body, DISCOVERY, scope).map((link) => link.url);
      expect(urls).toContain(
        `${BASE}/plans/formulary/TXSyntheticFormulary2024.pdf`,
      );
      expect(urls).not.toEqual(
        selectFormularyLinks(body, DISCOVERY, scope).map((l) => l.url),
      );
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("cover plan matching", () => {
  const cover = [
    "Synthetic Bronze",
    "Synthetic Bronze Plus",
    "Synthetic Silver 73",
    "Synthetic Gold Plus",
  ];
  const expectAmbiguousUnattached = (match: typeof matchCoverPlans) =>
    expect(match(cover, CATALOG_2026)).toEqual([
      {
        coverName: "Synthetic Bronze",
        status: "attached",
        basePlanId: "10001TX0010001",
        candidates: 1,
      },
      {
        coverName: "Synthetic Bronze Plus",
        status: "plan_mapping_ambiguous",
        basePlanId: null,
        candidates: 2,
      },
      {
        coverName: "Synthetic Silver 73",
        status: "attached",
        basePlanId: "10001TX0010004",
        candidates: 1,
      },
      {
        coverName: "Synthetic Gold Plus",
        status: "plan_not_in_catalog",
        basePlanId: null,
        candidates: 0,
      },
    ]);

  it("attaches a name only when exactly one catalog plan has it", () => {
    expectAmbiguousUnattached(matchCoverPlans);
  });

  it("never rewrites words: Plus is not +, and nothing is dropped", () => {
    const catalog = [
      {
        basePlanId: "10001TX0020001",
        planName: "Example Bronze + Dental & Vision (2 Free Visits)",
      },
      { basePlanId: "10001TX0020002", planName: "Example Gold" },
    ];
    expect(
      matchCoverPlans(["Bronze Plus", "Gold"], catalog).map((l) => l.status),
    ).toEqual(["plan_not_in_catalog", "attached"]);
  });

  it("drops trailing notes and fixed add-on suffixes, and only a join word stays", () => {
    expect(
      [
        "Example  Bronze + Dental & Vision (2 Free Visits, $0 Rx)",
        "Example Bronze Plus Dental & Vision",
        "Example Gold + Dental & Vision + Fitness ($0 Deductible)",
        "Example Gold Plus Dental & Vision & Fitness",
        "Example Gold with Fitness",
        "EXAMPLE SILVER 70 + DENTAL",
        "Example Bronze Plus",
        "Example (Value) Bronze",
      ].map(baseNameKey),
    ).toEqual([
      "example bronze",
      "example bronze",
      "example gold",
      "example gold",
      "example gold",
      "example silver 70",
      "example bronze plus",
      "example (value) bronze",
    ]);
  });

  /** Catalog where an add-on variant and the plain plan share a base name. */
  const ADD_ON_CATALOG: CatalogPlan[] = [
    {
      basePlanId: "10001TX0030001",
      planName: "Example Bronze (2 Free Visits)",
    },
    {
      basePlanId: "10001TX0030002",
      planName: "Example Bronze + Dental & Vision (2 Free Visits)",
    },
    { basePlanId: "10001TX0030003", planName: "Example Gold + Fitness" },
    {
      basePlanId: "10001TX0030004",
      planName: "Example Gold + Dental & Vision + Fitness",
    },
    { basePlanId: "10001TX0030005", planName: "Example Silver 70 + Fitness" },
  ];
  const expectAddOnMatches = (match: typeof matchCoverPlans) =>
    expect(
      match(["Bronze", "Gold", "Silver 70", "Bronze Plus"], ADD_ON_CATALOG).map(
        (l) => [l.coverName, l.status, l.basePlanId, l.candidates],
      ),
    ).toEqual([
      // The exact name wins; the add-on variant is not a second candidate.
      ["Bronze", "attached", "10001TX0030001", 1],
      // No exact name; two plans share the base name, so it stays unattached.
      ["Gold", "plan_mapping_ambiguous", null, 2],
      // No exact name; exactly one plan has the base name.
      ["Silver 70", "attached", "10001TX0030005", 1],
      ["Bronze Plus", "plan_not_in_catalog", null, 0],
    ]);

  it("matches by base name only when no exact name exists, and only when unique", () => {
    expectAddOnMatches(matchCoverPlans);
  });

  it("planted mutant: a normalised name matching two plans is attached", async () => {
    const mutant = await plantMutant(
      sourceFile("match.ts"),
      "candidates = base.lookup(coverName);",
      "candidates = base.lookup(coverName).slice(0, 1);",
    );
    try {
      const { matchCoverPlans: mutated } = (await import(mutant.path)) as {
        matchCoverPlans: typeof matchCoverPlans;
      };
      expect(() => expectAddOnMatches(mutated)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("a plan two documents of one year both claim is ambiguous for both", () => {
    const one = matchCoverPlans(["Synthetic Gold"], CATALOG_2026);
    const two = matchCoverPlans(["Synthetic Gold"], CATALOG_2026);
    const nextYear = matchCoverPlans(["Synthetic Gold"], CATALOG_2026);
    resolveSharedClaims([
      { key: "a", planYear: 2026, links: one },
      { key: "b", planYear: 2026, links: two },
      { key: "c", planYear: 2027, links: nextYear },
    ]);
    expect([one[0]!.status, two[0]!.status, nextYear[0]!.status]).toEqual([
      "plan_mapping_ambiguous",
      "plan_mapping_ambiguous",
      "attached",
    ]);
  });

  it("planted mutant: an ambiguous plan match is attached", async () => {
    const mutant = await plantMutant(
      sourceFile("match.ts"),
      "candidates.length === 1",
      "candidates.length >= 1",
    );
    try {
      const { matchCoverPlans: mutated } = (await import(mutant.path)) as {
        matchCoverPlans: typeof matchCoverPlans;
      };
      expect(() => expectAmbiguousUnattached(mutated)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

/** A synthetic footnote stating tier 0, as the extractor records it. */
const STATED_TIER_0 = {
  label: "Tier 0 drugs are synthetic preventive drugs at $0.",
  page: 2,
  line: 40,
  raw: "Tier 0 drugs are synthetic preventive drugs at $0.",
};

describe("validate: round trips", () => {
  const good: StagedDocument = {
    rows: 10,
    legendTiers: [1, 2, 3, 4, 5],
    statedTiers: {},
    rowTiers: [1, 2, 5],
    undefinedTierRows: 0,
    qlFlagRows: 3,
    qlTextRows: 3,
    planYear: 2026,
  };
  const cases: [string, Partial<StagedDocument>, string | undefined][] = [
    ["passes", {}, undefined],
    ["no rows", { rows: 0 }, REFUSAL.empty],
    ["no legend", { legendTiers: [] }, REFUSAL.legendMissing],
    ["a tier outside the legend", { rowTiers: [0, 1] }, REFUSAL.histogram],
    [
      "a tier the document's text states, with its line",
      { rowTiers: [0, 1], statedTiers: { "0": STATED_TIER_0 } },
      undefined,
    ],
    [
      "a stated tier without page, line and raw text",
      { rowTiers: [0, 1], statedTiers: { "0": { label: "$0 drugs" } } },
      REFUSAL.histogram,
    ],
    [
      "a different tier stated than the rows use",
      { rowTiers: [0, 1], statedTiers: { "6": STATED_TIER_0 } },
      REFUSAL.histogram,
    ],
    [
      "undefined-tier rows at the threshold",
      { undefinedTierRows: 1 },
      undefined,
    ],
    [
      "undefined-tier rows over the threshold",
      { undefinedTierRows: 2 },
      REFUSAL.histogram,
    ],
    ["QL text without QL flags", { qlFlagRows: 1 }, REFUSAL.quantityLimit],
    ["no printed year", { planYear: null }, REFUSAL.yearUnresolved],
    [
      "a printed year outside the run",
      { planYear: 2025 },
      REFUSAL.yearOutsideRun,
    ],
  ];
  it.each(cases)("%s", (_name, change, reason) => {
    expect(documentRefusal({ ...good, ...change }, [2026, 2027])).toBe(reason);
  });

  it("planted mutant: a legend failure is not refused as one", async () => {
    const mutant = await plantMutant(
      sourceFile("checks.ts"),
      "if (!document.legendTiers.length) return REFUSAL.legendMissing;",
      "",
    );
    try {
      const { documentRefusal: mutated } = (await import(mutant.path)) as {
        documentRefusal: typeof documentRefusal;
      };
      const noLegend = { ...good, legendTiers: [] };
      expect(documentRefusal(noLegend, [2026])).toBe(REFUSAL.legendMissing);
      expect(mutated(noLegend, [2026])).not.toBe(REFUSAL.legendMissing);
    } finally {
      await mutant.cleanup();
    }
  });

  it("admits the legend's tiers and stated tiers with evidence only", () => {
    expect(
      admittedTiers({
        ...good,
        statedTiers: { "0": STATED_TIER_0, "7": { label: "x" } },
      }).sort(),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the threshold at one tenth", () => {
    expect(MAX_UNDEFINED_TIER_SHARE).toBe(0.1);
    // The CHRISTUS TX 2026 and 2027 documents: 224 of 3856 and 191 of 1882.
    const big = { ...good, planYear: 2026, rows: 3856, undefinedTierRows: 224 };
    expect(documentRefusal(big, [2026])).toBeUndefined();
    const over = { ...good, rows: 1882, undefinedTierRows: 191 };
    expect(documentRefusal(over, [2026])).toBe(REFUSAL.histogram);
  });

  it("planted mutant: a document over the threshold is admitted", async () => {
    const mutant = await plantMutant(
      sourceFile("checks.ts"),
      "document.undefinedTierRows > document.rows * MAX_UNDEFINED_TIER_SHARE",
      "false",
    );
    try {
      const { documentRefusal: mutated } = (await import(mutant.path)) as {
        documentRefusal: typeof documentRefusal;
      };
      const over = { ...good, undefinedTierRows: 5 };
      expect(documentRefusal(over, [2026])).toBe(REFUSAL.histogram);
      expect(mutated(over, [2026])).toBeUndefined();
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: an undocumented tier is admitted", async () => {
    const mutant = await plantMutant(
      sourceFile("checks.ts"),
      "const admitted = admittedTiers(document);",
      "const admitted = [...admittedTiers(document), ...document.rowTiers];",
    );
    try {
      const { documentRefusal: mutated } = (await import(mutant.path)) as {
        documentRefusal: typeof documentRefusal;
      };
      const undocumented = { ...good, rowTiers: [0, 1] };
      expect(documentRefusal(undocumented, [2026])).toBe(REFUSAL.histogram);
      expect(mutated(undocumented, [2026])).toBeUndefined();
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("serving: text evidence at high confidence only", () => {
  /** One attached plan with one high row and one low row, written straight to the tables. */
  async function seeded() {
    const loaded = await freshDatabase();
    const db = loaded.db as Database;
    await db.query(
      "INSERT INTO source(source_id,publisher,source_kind) VALUES ('carrier-formulary-pdf','Synthetic','feed')",
    );
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
       VALUES ('synthetic-doc','carrier-formulary-pdf',$1,now(),1,1,'ACTIVE',now())`,
      ["b".repeat(64)],
    );
    await db.query(
      `INSERT INTO plg_carrierdoc_document(snapshot_id,document_sha256,url,url_year,plan_year,states,pages,legend_tiers,
         legend_flags,tier_histogram,confidence_counts,ql_flag_rows,ql_text_rows,cover_plan_names)
       VALUES ('synthetic-doc',$1,$2,2026,2026,'{TX}',3,'{"1":"Preferred generic"}','{}','{"1":2}','{}',0,0,'[]')`,
      ["b".repeat(64), `${BASE}/plans/formulary/TXSyntheticFormulary2026.pdf`],
    );
    for (const [line, name, confidence, unknown] of [
      [3, "atorvastatin calcium tab 10 mg", "high", null],
      [4, "sps", "low", null],
      [
        5,
        "synthetic folic acid tab 0.4 mg",
        "high",
        "tier_not_defined_in_document",
      ],
    ] as const)
      await db.query(
        `INSERT INTO plg_carrierdoc_formulary_row(snapshot_id,page,line,category,drug_name,name_key,tier,tier_label,
           flags,ql_text,raw_text,confidence,reasons,unknown_reason)
         VALUES ('synthetic-doc',2,$1,NULL,$2,$2,$4,'Preferred generic','[]','',$2,$3,'[]',$5)`,
        [line, name, confidence, unknown ? 0 : 1, unknown],
      );
    await db.query(
      `INSERT INTO plg_carrierdoc_plan_link(snapshot_id,state,issuer_id,plan_year,cover_name,base_plan_id,status,candidates)
       VALUES ('synthetic-doc','TX',$1,2026,'Synthetic Gold','10001TX0010006','attached',1)`,
      [ISSUER],
    );
    return loaded;
  }
  const ask = (
    db: Database,
    drugName: string,
    evidence = formularyDocumentEvidence,
  ) => evidence(db, { planId: "10001TX0010006-01", planYear: 2026, drugName });

  it("serves a high row as text evidence and a low row as unknown", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      expect(await ask(db, "Atorvastatin  Calcium tab 10 mg")).toMatchObject({
        status: "listed",
        evidence: [
          {
            kind: "issuer_formulary_document_text",
            tier: 1,
            tier_label: "Preferred generic",
            identity: "not_resolved",
            document: { page: 2, line: 3, plan_year: 2026 },
          },
        ],
      });
      expect(await ask(db, "sps")).toEqual({
        status: "unknown",
        reason: UNKNOWN_REASON.lowConfidence,
      });
      expect(await ask(db, "not a listed name")).toEqual({
        status: "unknown",
        reason: UNKNOWN_REASON.notListed,
      });
    } finally {
      await loaded.close();
    }
  });

  it("answers unknown, with page evidence, for a row whose tier the document never defines", async () => {
    const loaded = await seeded();
    try {
      expect(
        await ask(loaded.db as Database, "synthetic folic acid tab 0.4 mg"),
      ).toEqual({
        status: "unknown",
        reason: UNKNOWN_REASON.tierNotDefined,
        evidence: [
          {
            url: `${BASE}/plans/formulary/TXSyntheticFormulary2026.pdf`,
            sha256: "b".repeat(64),
            plan_year: 2026,
            page: 2,
            line: 5,
          },
        ],
      });
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: an undefined-tier row is served", async () => {
    const loaded = await seeded();
    const mutant = await plantMutant(
      sourceFile("evidence.ts"),
      "row.confidence === SERVED_CONFIDENCE && !row.unknown_reason",
      "row.confidence === SERVED_CONFIDENCE",
    );
    try {
      const { formularyDocumentEvidence: mutated } = (await import(
        mutant.path
      )) as {
        formularyDocumentEvidence: typeof formularyDocumentEvidence;
      };
      const db = loaded.db as Database;
      const name = "synthetic folic acid tab 0.4 mg";
      expect((await ask(db, name)).status).toBe("unknown");
      expect((await ask(db, name, mutated)).status).toBe("listed");
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });

  it("planted mutant: a low-confidence row is served", async () => {
    const loaded = await seeded();
    const mutant = await plantMutant(
      sourceFile("evidence.ts"),
      "row.confidence === SERVED_CONFIDENCE",
      "true",
    );
    try {
      const { formularyDocumentEvidence: mutated } = (await import(
        mutant.path
      )) as {
        formularyDocumentEvidence: typeof formularyDocumentEvidence;
      };
      const db = loaded.db as Database;
      expect((await ask(db, "sps")).status).toBe("unknown");
      expect((await ask(db, "sps", mutated)).status).toBe("listed");
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });
});

describe.skipIf(!poppler)(
  "feed run on synthetic PDFs (needs pdftotext)",
  () => {
    const files = () => ({
      "/plans/formularies": discoveryPage([...IN_SCOPE, ...OUT_OF_SCOPE]),
      "/plans/formulary/TXSyntheticFormulary2026.pdf": pdfs.get("2026")!,
      "/plans/formulary/TXSyntheticFormulary2027.pdf": pdfs.get("2027")!,
    });

    it("stages rows with provenance, attaches unambiguous plans and serves high rows only", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(db, files());
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        expect(
          run.requests.filter((path) => path.endsWith(".pdf")).sort(),
        ).toEqual(IN_SCOPE.map((name) => `/plans/formulary/${name}`));
        const { rows: documents } = await db.query<Record<string, unknown>>(
          "SELECT url_year, plan_year, document_sha256, pages FROM plg_carrierdoc_document ORDER BY url_year",
        );
        expect(documents).toEqual([
          {
            url_year: 2026,
            plan_year: 2026,
            document_sha256: digest(pdfs.get("2026")!),
            pages: 3,
          },
          {
            url_year: 2027,
            plan_year: 2027,
            document_sha256: digest(pdfs.get("2027")!),
            pages: 3,
          },
        ]);
        expect(await count(db, "plg_carrierdoc_formulary_row")).toBe(22);
        const { rows: row } = await db.query<Record<string, unknown>>(
          `SELECT page, line, raw_text, confidence, tier, tier_label, flags, ql_text FROM plg_carrierdoc_formulary_row
         WHERE drug_name = 'insulin glargine-yfgn inj 100 unit/ml solution pen-injector 3 ml' ORDER BY snapshot_id LIMIT 1`,
        );
        expect(row[0]).toMatchObject({
          page: 2,
          confidence: "high",
          tier: 2,
          tier_label: "Generic",
          flags: ["QL"],
          ql_text: "15 ml per 30 days",
        });
        expect(String(row[0]!.raw_text).split("\n")).toHaveLength(2);
        const { rows: links } = await db.query<Record<string, unknown>>(
          "SELECT cover_name, status, base_plan_id FROM plg_carrierdoc_plan_link WHERE plan_year = 2026 ORDER BY cover_name",
        );
        expect(links).toEqual([
          {
            cover_name: "Synthetic Bronze",
            status: "attached",
            base_plan_id: "10001TX0010001",
          },
          {
            cover_name: "Synthetic Bronze Plus",
            status: "plan_mapping_ambiguous",
            base_plan_id: null,
          },
          {
            cover_name: "Synthetic Gold",
            status: "attached",
            base_plan_id: "10001TX0010006",
          },
          {
            cover_name: "Synthetic Gold Plus",
            status: "plan_not_in_catalog",
            base_plan_id: null,
          },
          {
            cover_name: "Synthetic Silver 73",
            status: "attached",
            base_plan_id: "10001TX0010004",
          },
          {
            cover_name: "Synthetic Silver Essential Plus Limited",
            status: "attached",
            base_plan_id: "10001TX0010005",
          },
        ]);
        const { rows: availability } = await db.query<{
          formulary_document_status: string;
        }>(
          "SELECT formulary_document_status FROM data_availability WHERE issuer_id = $1 AND plan_year = 2026",
          [ISSUER],
        );
        expect(availability).toEqual([
          { formulary_document_status: "partial" },
        ]);

        const ask = (planId: string, drugName: string) =>
          formularyDocumentEvidence(db, { planId, planYear: 2026, drugName });
        expect(
          (await ask("10001TX0010006", "lisinopril tab 20 mg")).status,
        ).toBe("listed");
        expect(await ask("10001TX0010006", "sps")).toEqual({
          status: "unknown",
          reason: UNKNOWN_REASON.lowConfidence,
        });
        expect(await ask("10001TX0010006", "oseltamivir cap 75 mg")).toEqual({
          status: "unknown",
          reason: UNKNOWN_REASON.lowConfidence,
        });
        expect(await ask("10001TX0010002", "lisinopril tab 20 mg")).toEqual({
          status: "unknown",
          reason: UNKNOWN_REASON.ambiguous,
        });
        expect(
          await formularyDocumentEvidence(db, {
            planId: "10001TX0010006",
            planYear: 2025,
            drugName: "lisinopril tab 20 mg",
          }),
        ).toEqual({ status: "unknown", reason: UNKNOWN_REASON.noDocument });
      } finally {
        await loaded.close();
      }
    });

    it("records the operator's approval of a restricted host beside each document and in served evidence", async () => {
      // The same synthetic publisher, now terms-restricted with an owner-env approval.
      const owner = join(scratch, "owner-env.json");
      const base = JSON.parse(await readFile(manifest, "utf8")) as {
        publishers: Record<string, unknown>[];
      };
      const entry = base.publishers[0]!;
      await writeFile(
        owner,
        JSON.stringify({
          version: 1,
          publishers: [
            {
              ...entry,
              state: "terms-restricted",
              approval: {
                kind: "owner-env",
                env: "OPENPLANS_SITE_APPROVE_SYNTHETIC_FEED",
              },
              terms: {
                ...(entry.terms as Record<string, unknown>),
                disposition: "restricted",
              },
            },
          ],
        }),
      );
      for (const name of [
        "OPENPLANS_PUBLIC_QUOTING",
        "OPENPLANS_PUBLIC_HOUSEHOLD",
        "OPENPLANS_PUBLIC_COMPAT",
      ])
        vi.stubEnv(name, "off");
      vi.stubEnv("OPENPLANS_SITE_APPROVE_SYNTHETIC_FEED", "");
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const held = await runFeed(db, files(), "2026,2027", owner);
        expect(held.code).not.toBe(0);
        expect(held.requests).toEqual([]);
        expect(await count(db, "plg_carrierdoc_document")).toBe(0);
        vi.stubEnv("OPENPLANS_SITE_APPROVE_SYNTHETIC_FEED", "approved");
        const run = await runFeed(db, files(), "2026,2027", owner);
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        const { rows: documents } = await db.query<{ approval_basis: string }>(
          "SELECT approval_basis FROM plg_carrierdoc_document",
        );
        expect(documents).toEqual([
          { approval_basis: "owner-env:SYNTHETIC_FEED" },
          { approval_basis: "owner-env:SYNTHETIC_FEED" },
        ]);
        const answer = await formularyDocumentEvidence(db, {
          planId: "10001TX0010006",
          planYear: 2026,
          drugName: "lisinopril tab 20 mg",
        });
        expect(answer.status).toBe("listed");
        if (answer.status !== "listed") throw new Error("unreachable");
        expect(answer.evidence[0]?.document).toMatchObject({
          approval_basis: "owner-env:SYNTHETIC_FEED",
        });
        // A document from a host whose terms allow collection carries no approval field.
        const plain = await runFeed(db, files());
        expect(plain.code, JSON.stringify(plain.logs)).toBe(0);
        const again = await formularyDocumentEvidence(db, {
          planId: "10001TX0010006",
          planYear: 2026,
          drugName: "lisinopril tab 20 mg",
        });
        if (again.status !== "listed") throw new Error("unreachable");
        expect(again.evidence[0]?.document).not.toHaveProperty(
          "approval_basis",
        );
      } finally {
        vi.unstubAllEnvs();
        await loaded.close();
      }
    });

    it("refuses a run whose only document has no legend, and keeps nothing from it", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(
          db,
          {
            ...files(),
            "/plans/formulary/TXSyntheticFormulary2027.pdf":
              pdfs.get("no-legend")!,
          },
          "2027",
        );
        expect(run.code).toBe(1);
        expect(run.logs.at(-1)).toMatchObject({
          code: "feed_run_failed",
          reason: REFUSAL.legendMissing,
        });
        expect(await count(db, "plg_carrierdoc_document")).toBe(0);
        expect(await count(db, "plg_carrierdoc_formulary_row")).toBe(0);
        expect(await count(db, "plg_carrierdoc_plan_link")).toBe(0);
        const { rows } = await db.query<{ validation_state: string }>(
          "SELECT DISTINCT validation_state FROM snapshot WHERE source_id = 'carrier-formulary-pdf'",
        );
        expect(rows).toEqual([{ validation_state: "QUARANTINED" }]);
        const { rows: availability } = await db.query<{
          formulary_document_status: string;
        }>(
          "SELECT formulary_document_status FROM data_availability WHERE issuer_id = $1",
          [ISSUER],
        );
        expect(availability).toEqual([
          { formulary_document_status: "not_yet_verified" },
        ]);
      } finally {
        await loaded.close();
      }
    });

    it("refuses a document whose undefined-tier rows pass the threshold", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(
          db,
          {
            ...files(),
            "/plans/formulary/TXSyntheticFormulary2027.pdf":
              pdfs.get("tier0-undocumented")!,
          },
          "2027",
        );
        expect(run.code).toBe(1);
        expect(run.logs.at(-1)).toMatchObject({
          code: "feed_run_failed",
          reason: REFUSAL.histogram,
        });
        expect(await count(db, "plg_carrierdoc_formulary_row")).toBe(0);
      } finally {
        await loaded.close();
      }
    });

    it("keeps undefined-tier rows as unknown while they stay under the threshold", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(db, {
          ...files(),
          "/plans/formulary/TXSyntheticFormulary2027.pdf":
            pdfs.get("tier0-few")!,
        });
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        const { rows } = await db.query<Record<string, unknown>>(
          "SELECT page, tier, unknown_reason FROM plg_carrierdoc_formulary_row WHERE tier = 0",
        );
        expect(rows).toEqual([
          { page: 3, tier: 0, unknown_reason: UNKNOWN_REASON.tierNotDefined },
        ]);
        const { rows: served } = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM plg_carrierdoc_formulary_row WHERE unknown_reason IS NULL AND tier = 0",
        );
        expect(served[0]!.n).toBe(0);
      } finally {
        await loaded.close();
      }
    });

    it("admits a tier the document states, keeping the stating line as evidence", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(db, {
          ...files(),
          "/plans/formulary/TXSyntheticFormulary2027.pdf":
            pdfs.get("tier0-stated")!,
        });
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        const note = "Tier 0 - $0 synthetic preventive drugs, no cost share.";
        const { rows: documents } = await db.query<Record<string, unknown>>(
          "SELECT plan_year, stated_tiers FROM plg_carrierdoc_document ORDER BY plan_year",
        );
        expect(documents).toEqual([
          { plan_year: 2026, stated_tiers: {} },
          {
            plan_year: 2027,
            stated_tiers: {
              "0": {
                label: note,
                page: 3,
                line: 20,
                raw: note,
              },
            },
          },
        ]);
        const { rows } = await db.query<Record<string, unknown>>(
          "SELECT page, tier, tier_label, confidence FROM plg_carrierdoc_formulary_row WHERE tier = 0",
        );
        expect(rows).toEqual([
          { page: 3, tier: 0, tier_label: note, confidence: "high" },
        ]);
      } finally {
        await loaded.close();
      }
    });

    const refusedSibling = () => ({
      ...files(),
      "/plans/formulary/TXSyntheticFormulary2027.pdf":
        pdfs.get("tier0-undocumented")!,
    });
    const states = async (db: Database) =>
      (
        await db.query<{ url: string; validation_state: string }>(
          "SELECT requested_url AS url, validation_state FROM snapshot WHERE source_id = 'carrier-formulary-pdf' ORDER BY requested_url",
        )
      ).rows.map((row) => [row.url.slice(-8), row.validation_state]);

    it("admits each document on its own: a refused 2027 document does not block 2026", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        const run = await runFeed(db, refusedSibling());
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        expect(await states(db)).toEqual([
          ["2026.pdf", "ACTIVE"],
          ["2027.pdf", "QUARANTINED"],
        ]);
        expect(JSON.parse(run.out[0]!)).toMatchObject({
          refused: [{ reason: REFUSAL.histogram }],
        });
        expect(run.logs).toContainEqual(
          expect.objectContaining({
            code: "feed_file_refused",
            reason: REFUSAL.histogram,
          }),
        );
        const { rows: documents } = await db.query<{ plan_year: number }>(
          "SELECT plan_year FROM plg_carrierdoc_document",
        );
        expect(documents).toEqual([{ plan_year: 2026 }]);
        expect(await count(db, "plg_carrierdoc_formulary_row")).toBeGreaterThan(
          0,
        );
        const { rows: issues } = await db.query<{ issue_code: string }>(
          "SELECT issue_code FROM quality_issue WHERE source_id = 'carrier-formulary-pdf'",
        );
        expect(issues).toEqual([{ issue_code: REFUSAL.histogram }]);
        const { rows: availability } = await db.query<{
          plan_year: number;
          formulary_document_status: string;
        }>(
          "SELECT plan_year, formulary_document_status FROM data_availability WHERE issuer_id = $1 ORDER BY plan_year",
          [ISSUER],
        );
        expect(availability).toEqual([
          { plan_year: 2026, formulary_document_status: "partial" },
        ]);
      } finally {
        await loaded.close();
      }
    });

    it("keeps the earlier reading of a document that is refused in a later run", async () => {
      const loaded = await freshDatabase();
      try {
        const db = loaded.db as Database;
        expect((await runFeed(db, files())).code).toBe(0);
        const before = await count(db, "plg_carrierdoc_formulary_row");
        const run = await runFeed(db, refusedSibling());
        expect(run.code, JSON.stringify(run.logs)).toBe(0);
        const { rows } = await db.query<{ n: number; years: number[] }>(
          "SELECT count(*)::int AS n, array_agg(DISTINCT d.plan_year) AS years FROM plg_carrierdoc_formulary_row r JOIN plg_carrierdoc_document d USING (snapshot_id)",
        );
        expect(rows[0]!.years.sort()).toEqual([2026, 2027]);
        expect(rows[0]!.n).toBeLessThan(before + 1);
      } finally {
        await loaded.close();
      }
    });

    it("planted mutant: a refused document blocks an admitted sibling", async () => {
      const mutant = await plantMutant(
        sourceFile("source.ts"),
        "return {\n        ok: true,\n        refused:",
        "if (refusals.length) return { ok: false, reasonCode: refusals[0]!.reasonCode };\n      return {\n        ok: true,\n        refused:",
      );
      const loaded = await freshDatabase();
      try {
        const { createFormularySource: mutated } = (await import(
          mutant.path
        )) as { createFormularySource: typeof createFormularySource };
        const db = loaded.db as Database;
        const { requests, transport } = serve(refusedSibling());
        const code = await runFeedSource(
          mutated({ extractor: pythonExtractor(), hosts: [HOST] }),
          [
            "--discovery",
            DISCOVERY,
            "--issuer",
            `TX:${ISSUER}`,
            "--years",
            "2026,2027",
          ],
          db,
          {
            declaredHosts: [HOST],
            dataDir: await mkdtemp(join(scratch, "data-")),
            manifestPaths: [manifest],
            transport,
            lookup: async () => [{ address: "8.8.8.8", family: 4 }],
            sleep: async () => {},
            maxAttempts: 1,
            now: () => NOW,
            output: { out: () => {}, error: () => {} },
          },
        );
        expect(requests.length).toBeGreaterThan(0);
        // The real source admits the sibling (see above); the mutant refuses the whole run.
        expect(code).toBe(1);
        expect(await count(db, "plg_carrierdoc_document")).toBe(0);
      } finally {
        await mutant.cleanup();
        await loaded.close();
      }
    });

    it("refuses a document whose cover prints a year its file name does not", async () => {
      const loaded = await freshDatabase();
      try {
        const run = await runFeed(
          loaded.db as Database,
          {
            ...files(),
            "/plans/formulary/TXSyntheticFormulary2026.pdf":
              pdfs.get("printed-2025")!,
          },
          "2026",
        );
        expect(run.code).toBe(1);
        expect(run.logs.at(-1)).toMatchObject({
          reason: REFUSAL.yearOutsideRun,
        });
      } finally {
        await loaded.close();
      }
    });
  },
);

describe("data window and loading", () => {
  it("refuses years outside the window before any request", async () => {
    const loaded = await freshDatabase();
    try {
      const run = await runFeed(loaded.db as Database, {}, "2023,2026");
      expect(run.code).toBe(1);
      expect(run.requests).toEqual([]);
      expect(run.logs.at(-1)).toMatchObject({ reason: "outside_data_window" });
    } finally {
      await loaded.close();
    }
  });

  it("declares the reviewed hosts, and each is allowed in the operator manifest fixture", async () => {
    expect(plugin.manifest.capabilities?.network).toEqual([...DOCUMENT_HOSTS]);
    expect(packageJson.openplansPlugin.capabilities.network).toEqual([
      ...DOCUMENT_HOSTS,
    ]);
    const fixture = JSON.parse(await readFile(operatorFixture, "utf8")) as {
      publishers: { host: string; state: string }[];
    };
    for (const host of DOCUMENT_HOSTS)
      expect(
        fixture.publishers.find((entry) => entry.host === host)?.state,
      ).toBe("allowed");
  });

  it("loads with its migrations and registers the formulary and SBC feed sources", async () => {
    const loaded = await loadForTest(plugin, { packageRoot });
    try {
      expect(loaded.registrations.sources).toHaveLength(2);
      expect(loaded.registrations.sources[0]).toMatchObject({
        kind: "feed",
        id: "carrier-formulary-pdf",
        dataScope: { kind: "annual", domain: "individual" },
      });
      expect(loaded.registrations.sources[1]).toMatchObject({
        kind: "feed",
        id: SBC_SOURCE_ID,
        dataScope: { kind: "annual", domain: "individual" },
      });
    } finally {
      await loaded.close();
    }
  });

  it("loads through the worker with an approved lock and adds its ingest command", async () => {
    const env = await approvedTestEnvironment({
      OPENPLANS_PLUGINS: "@openplans/source-carrier-documents",
      OPENPLANS_ACCESS_MANIFEST: operatorFixture,
    });
    const plugins = await loadWorkerPlugins({
      env,
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });
    try {
      expect(plugins.plugins).toEqual([
        {
          name: "@openplans/source-carrier-documents",
          version: packageJson.version,
        },
      ]);
      // The core adds the package-input form of every feed command.
      expect(
        plugins.commands.map((command) => command.spec.argv.join(" ")),
      ).toEqual([
        IDENTITY_JOIN_ARGV.join(" "),
        FORMULARY_ARGV.join(" "),
        "ingest package carrier-formulary-pdf",
        SBC_ARGV.join(" "),
        "ingest package carrier-sbc-pdf",
      ]);
      expect(plugins.migrations.map((source) => source.tablePrefix)).toEqual([
        "carrierdoc",
      ]);
    } finally {
      await plugins.teardown();
    }
  });
});
