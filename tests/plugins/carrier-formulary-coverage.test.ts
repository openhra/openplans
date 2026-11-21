// Carrier formulary documents in drug answers: the document layer between the issuer's
// machine-readable files and the pass-through sources, in /v1 drug coverage, quotes, the
// compatibility quote and MCP, and an end-to-end `worker ingest carrier-formulary-identity` run
// with the real RxNav source. The formulary document, its plan and rows are SYNTHETIC (invented
// document URL, plan from the synthetic QHP fixtures); "albendazole tab 200 mg" is a generic
// printed name written for this test. RxNav's name search for albendazole is the RECORDED fixture
// tests/fixtures/rxnav/drugs-albendazole.json; its properties body is synthetic
// (synthetic-properties-199672.json). CMS answers, terms pages and the key are synthetic. An
// injected transport serves everything; no network.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FeedSource, PluginContext } from "@openplans/plugin-sdk";
import * as RxnavPackage from "@openplans/source-rxnav-identity";
import carrierPlugin, {
  createFormularySource,
  DEFAULT_EXTRACTOR,
  identityJoinCommand,
  pythonExtractor,
  SOURCE_ID,
} from "@openplans/source-carrier-documents";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { Database } from "../../src/db/database.js";
import {
  AdmissionSession,
  admissionManifestSchema,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import {
  applyCmsFallback,
  cmsFallbackContext,
} from "../../src/ingest/cms-api/fallback.js";
import { importFormulary } from "../../src/ingest/qhp/formulary.js";
import { callTool } from "../../src/mcp/tools.js";
import { assertHonest } from "../../src/mcp/schemas.js";
import {
  activateRegistries,
  emptyRegistries,
  freezeRegistries,
} from "../../src/plugins/registries.js";
import {
  configurePassThrough,
  passThrough,
} from "../../src/plugins/sources/passthrough.js";
import { loadForTest, plantMutant } from "../../src/plugins/testing/index.js";
import { withDocumentCoverage } from "../../src/domain/drugs/documents.js";
import { runPluginCommand } from "../../src/plugins/worker.js";
import { checkDrugCoverage } from "../../src/services/drugs.js";
import { readQuoteCoverage } from "../../src/services/quote-coverage.js";
import {
  consultPassThrough,
  upstreamSources,
  withUpstreamDisclosure,
} from "../../src/services/upstream-disclosure.js";
import type { DrugCoverage } from "../../src/domain/drugs/index.js";
import {
  fixture,
  scope as formularyScope,
  setup,
} from "../ingest/qhp/formulary-helpers.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const RXNAV = RxnavPackage.RXNAV_HOST;
const CMS = "marketplace.api.healthcare.gov";
const fixtures = new URL("../fixtures/rxnav/", import.meta.url);
const shippedFederal = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const shippedCms = fileURLToPath(
  new URL("../../data/access/cms-marketplace-api.json", import.meta.url),
);
const carrierRoot = fileURLToPath(
  new URL("../../plugins/source-carrier-documents/", import.meta.url),
);
const syntheticTerms = (url: string) =>
  `Synthetic stand-in for the reviewed terms document ${url}`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const plantedKey = "PLANTED-carrier-doc-test-key-9x8w7v";

const DOC = "synthetic-carrier-doc";
const DOC_URL =
  "https://docs.synthetic.test/plans/formulary/TXSyntheticFormulary2026.pdf";
/** Albendazole 200 MG Oral Tablet in the recorded name search. */
const ALBENDAZOLE = "199672";

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
/** A synthetic release concept the synthetic machine-readable formulary also lists. */
let LISTED: string;
let scratch: string;
let manifestPath: string;
let recordedSearch: string;
let syntheticProperties: string;
let rxnavCalls: string[];
let cmsCalls: string[];

const transport: Transport = async (url) => {
  let status = 200;
  let body = "";
  if (url.pathname === "/robots.txt") {
    if (url.hostname === RXNAV) status = 404;
    else if (url.hostname === CMS) status = 401;
    else body = "User-agent: *\nDisallow: /*.txt$\n";
  } else if (url.hostname === RXNAV) {
    rxnavCalls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/REST/drugs.json")
      body =
        url.searchParams.get("name") === "albendazole"
          ? recordedSearch
          : JSON.stringify({ drugGroup: { name: null } });
    else if (url.pathname === `/REST/rxcui/${ALBENDAZOLE}/properties.json`)
      body = syntheticProperties;
    else body = "{}";
  } else if (url.hostname === CMS) {
    cmsCalls.push(url.pathname);
    const plans = url.searchParams.get("planids")!.split(",");
    const drugs = url.searchParams.get("drugs")!.split(",");
    body = JSON.stringify({
      coverage: plans.flatMap((plan_id) =>
        drugs.map((rxcui) => ({ rxcui, plan_id, coverage: "NotCovered" })),
      ),
    });
  } else body = syntheticTerms(`${url.origin}${url.pathname}`);
  return { status, headers: {}, body: Readable.from([body]) };
};
const session = () =>
  new AdmissionSession([manifestPath], {
    maxRequests: 100,
    maxTransferBytes: 1024 ** 2,
  });
const fetchOptions = () => ({
  transport,
  dataDir: scratch,
  lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
});
const context = () =>
  cmsFallbackContext(h.db, h.db, {
    admission: session(),
    fetchOptions: fetchOptions(),
  });

async function setRelease(active: boolean) {
  await h.db.query(
    `UPDATE snapshot SET validation_state=$1 WHERE snapshot_id='rx'`,
    [active ? "ACTIVE" : "QUARANTINED"],
  );
}
async function unspaced() {
  await h.db.exec(
    `UPDATE passthrough_budget SET next_request_at='epoch',daily_requests=0,blocked_until='epoch',
       failure_count=0,half_open=false;
     UPDATE cms_api_budget SET next_request_at='epoch',daily_requests=0,blocked_until='epoch',
       failure_count=0,half_open=false`,
  );
}

/** The carrier feed source as the plugin's setup registers it, with its `identityJoin` switch. */
function documents(identityJoin: boolean): FeedSource {
  return createFormularySource({
    extractor: pythonExtractor(DEFAULT_EXTRACTOR, "python3"),
    identityJoin,
  });
}
function register(source: FeedSource | null) {
  const staging = emptyRegistries();
  if (source)
    staging.sources.push({
      plugin: carrierPlugin.manifest.name,
      spec: source,
      network: [],
    });
  activateRegistries(freezeRegistries(staging));
}

/** A SYNTHETIC active formulary document attached to the first synthetic catalog plan. */
async function seedDocument() {
  await h.db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ($1,'Issuer-published formulary documents','feed')
     ON CONFLICT DO NOTHING`,
    [SOURCE_ID],
  );
  await h.db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at,final_url)
     VALUES ($1,$2,$3,now(),1,1,'ACTIVE',now(),$4)`,
    [DOC, SOURCE_ID, "c".repeat(64), DOC_URL],
  );
  await h.db.query(
    `INSERT INTO plg_carrierdoc_document(snapshot_id,document_sha256,url,url_year,plan_year,states,pages,legend_tiers,
       legend_flags,tier_histogram,confidence_counts,ql_flag_rows,ql_text_rows,cover_plan_names)
     VALUES ($1,$2,$3,2026,2026,'{TX}',3,'{"1":"Preferred generic","2":"Generic"}','{}','{}','{}',0,0,'[]')`,
    [DOC, "c".repeat(64), DOC_URL],
  );
  const rows: [number, string, number, string, string[]][] = [
    [1, "synthetic lisinopril tab 5 mg", 1, "Preferred generic", []],
    [2, "albendazole tab 200 mg", 2, "Generic", ["PA"]],
  ];
  for (const [line, name, tier, label, flags] of rows)
    await h.db.query(
      `INSERT INTO plg_carrierdoc_formulary_row(snapshot_id,page,line,category,drug_name,name_key,tier,tier_label,
         flags,ql_text,raw_text,confidence,reasons,unknown_reason)
       VALUES ($1,2,$2,NULL,$3,lower($3),$4,$5,$6::jsonb,'',$7,'high','[]',NULL)`,
      [
        DOC,
        line,
        name,
        tier,
        label,
        JSON.stringify(flags),
        `  ${name}  ${tier}`,
      ],
    );
  await h.db.query(
    `INSERT INTO plg_carrierdoc_plan_link(snapshot_id,state,issuer_id,plan_year,cover_name,base_plan_id,status,candidates)
     VALUES ($1,'TX','00010',2026,'Synthetic Expanded Bronze',$2,'attached',1)`,
    [DOC, plan],
  );
  // Line 1 was joined earlier against the synthetic release; line 2 waits for the worker run.
  await h.db.query(
    `INSERT INTO plg_carrierdoc_row_identity(snapshot_id,page,line,name_key,status,reason,query,matched,rxcui,
       concept_name,identity_source,evidence,joined_at,confirmed_at)
     VALUES ($1,2,1,'synthetic lisinopril tab 5 mg','resolved',NULL,'synthetic lisinopril',1,$2,
       'synthetic lisinopril 5 MG Oral Tablet','rxnorm-release','{"confirmation":{"source_id":"rxnorm-release"}}',now(),now())`,
    [DOC, LISTED],
  );
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0]!.base_plan_id as string;
  LISTED = (await fixture("drugs"))[0].rxnorm_id;
  scratch = await mkdtemp(join(tmpdir(), "openplans-carrier-coverage-"));
  const index = JSON.parse(
    await readFile(new URL("recorded.json", fixtures), "utf8"),
  ) as { files: { file: string; label: string; sha256: string }[] };
  const entry = index.files.find((f) => f.file === "drugs-albendazole.json")!;
  expect(entry.label).toBe("recorded");
  recordedSearch = await readFile(
    new URL("drugs-albendazole.json", fixtures),
    "utf8",
  );
  expect(digest(recordedSearch)).toBe(entry.sha256);
  const synthetic = JSON.parse(
    await readFile(
      new URL("synthetic-properties-199672.json", fixtures),
      "utf8",
    ),
  ) as { label: string; rxcui: string; body: string };
  expect(synthetic.label).toBe("synthetic");
  expect(synthetic.rxcui).toBe(ALBENDAZOLE);
  syntheticProperties = synthetic.body;
  const federal = admissionManifestSchema.parse(
    JSON.parse(await readFile(shippedFederal, "utf8")),
  );
  const keyed = admissionManifestSchema.parse(
    JSON.parse(await readFile(shippedCms, "utf8")),
  );
  const publishers: PublisherPolicy[] = [
    federal.publishers.find((p) => p.host === RXNAV)!,
    ...keyed.publishers,
  ].map((publisher) => ({
    ...publisher,
    terms: {
      ...publisher.terms!,
      sha256: digest(syntheticTerms(publisher.terms!.url)),
    },
  }));
  const manifest: AdmissionManifest = { version: 1, publishers };
  manifestPath = join(scratch, "access.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  // The plugin's migrations on the same database as the core's.
  await loadForTest(carrierPlugin, {
    packageRoot: carrierRoot,
    db: h.db,
    options: { identityJoin: "on" },
  });
  await seedDocument();
}, 120_000);
afterAll(async () => {
  register(null);
  configurePassThrough({});
  await h?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  rxnavCalls = [];
  cmsCalls = [];
  register(documents(true));
  await setRelease(true);
  await unspaced();
});
afterEach(() => {
  vi.unstubAllEnvs();
  configurePassThrough({});
});

const covered = (answer: DrugCoverage) =>
  expect(answer).toMatchObject({
    status: "listed_covered",
    reason: null,
    drug_tier: "Preferred generic",
    tier_status: "unresolved",
    prior_authorization: false,
    step_therapy: false,
    quantity_limit: false,
    snapshot_id: DOC,
    formulary_document: {
      source_id: SOURCE_ID,
      tier: 1,
      tier_label: "Preferred generic",
      evidence: [
        {
          kind: "issuer_formulary_document_row",
          snapshot_id: DOC,
          document: { url: DOC_URL, page: 2, line: 1 },
          identity: { rxcui: LISTED, source_id: "rxnorm-release" },
        },
      ],
    },
  });

describe("documents answer what the machine-readable files leave unknown", () => {
  it("/v1 drug coverage serves the document's printed tier with page-level evidence, disclosing nothing", async () => {
    const sources = await withUpstreamDisclosure(async () => {
      covered(
        (await checkDrugCoverage(h.db, plan, LISTED, "2026")) as DrugCoverage,
      );
      return upstreamSources();
    });
    expect(sources).toEqual([]);
  });

  it("a drug the document does not list stays unknown with the files' reason", async () => {
    const other = (
      await h.db.query<{ rxcui: string }>(
        `SELECT rxcui FROM rx_concept WHERE snapshot_id='rx' AND rxcui<>$1 AND suppress='N' LIMIT 1`,
        [LISTED],
      )
    ).rows[0]!.rxcui;
    expect(await checkDrugCoverage(h.db, plan, other, "2026")).toMatchObject({
      status: "unknown",
      reason: "source_set_not_available",
    });
    expect(
      await checkDrugCoverage(h.db, plan, other, "2026"),
    ).not.toHaveProperty("formulary_document");
  });

  it("with the plugin's identityJoin off, or no carrier plugin, nothing changes", async () => {
    for (const source of [documents(false), null]) {
      register(source);
      expect(await checkDrugCoverage(h.db, plan, LISTED, "2026")).toMatchObject(
        {
          status: "unknown",
          reason: "source_set_not_available",
        },
      );
    }
  });

  it("an identity confirmed more than 35 days ago is not served", async () => {
    await h.db.query(
      `UPDATE plg_carrierdoc_row_identity SET confirmed_at = now() - interval '36 days' WHERE line = 1`,
    );
    try {
      expect(await checkDrugCoverage(h.db, plan, LISTED, "2026")).toMatchObject(
        { status: "unknown", reason: "source_set_not_available" },
      );
    } finally {
      await h.db.query(
        `UPDATE plg_carrierdoc_row_identity SET confirmed_at = now() WHERE line = 1`,
      );
    }
  });

  it("quotes and the compatibility quote read the same answer", async () => {
    const quote = await readQuoteCoverage(h.db, plan, [], [LISTED], 2026);
    covered(quote.drugs[0]!);
  });

  it("the MCP honesty check accepts the document evidence, and refuses the claim without it", async () => {
    const result = await callTool({ db: h.db }, "check_drug_coverage", {
      plan_ids: [plan],
      rxcuis: [LISTED],
      year: 2026,
    });
    const output = result.structuredContent as {
      status: string;
      data: { results: Record<string, unknown>[] };
      provenance: { snapshot_id: string | null; publisher: string }[];
    };
    expect(output.status).not.toBe("error");
    const [record] = output.data.results;
    expect(record).toMatchObject({
      status: "listed_covered",
      tier: "Preferred generic",
      tier_status: "unresolved",
      evidence: [
        {
          status: "listed_covered",
          tier: "Preferred generic",
          evidence_refs: [DOC],
        },
      ],
    });
    expect(output.provenance).toContainEqual(
      expect.objectContaining({
        snapshot_id: DOC,
        publisher: "Issuer-published formulary documents",
      }),
    );
    // Negative control: the same positive claim with its document rows removed is refused.
    const stripped = structuredClone(output);
    stripped.data.results[0]!.evidence = [];
    expect(() => assertHonest("check_drug_coverage", stripped)).toThrow(
      "claim without explicit source record",
    );
  });
});

describe("precedence with the CMS fallback", () => {
  beforeEach(() => {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
    vi.stubEnv("CMS_API_KEY", plantedKey);
  });

  it("a stored CMS answer is only checked against the document's answer (cms_api_conflict)", async () => {
    await h.db.exec(
      "DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage",
    );
    // Absorb a CMS NotCovered for the question first, as if asked before the document loaded.
    register(null);
    const [before] = await applyCmsFallback(
      "drug",
      [await checkDrugCoverage(h.db, plan, LISTED, "2026")],
      context(),
    );
    expect(before).toMatchObject({
      status: "explicitly_not_covered",
      cms_api: { coverage: "NotCovered" },
    });
    expect(cmsCalls).toHaveLength(1);
    register(documents(true));
    await unspaced();
    const served = (await checkDrugCoverage(
      h.db,
      plan,
      LISTED,
      "2026",
      context(),
    )) as DrugCoverage;
    covered(served);
    expect(served.cms_api).toBeUndefined();
    expect(cmsCalls).toHaveLength(1);
    expect(
      (
        await h.db.query(
          `SELECT cms_coverage,authoritative_status,authoritative_snapshot_id,agrees FROM cms_api_conflict`,
        )
      ).rows,
    ).toEqual([
      {
        cms_coverage: "NotCovered",
        authoritative_status: "listed_covered",
        authoritative_snapshot_id: DOC,
        agrees: false,
      },
    ]);
  });
});

describe("the end-to-end worker run with the real RxNav source", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
    configurePassThrough({
      fetchOptions: fetchOptions(),
      admission: session,
      cacheStore: new MemoryCache(8 * 1024 ** 2),
    });
    await setRelease(false);
  });

  it("joins the row through recorded RxNav answers, then serves it, naming rxnav only when it was called", async () => {
    const logs: string[] = [];
    const db = h.db as Database;
    const code = await runPluginCommand(
      {
        plugin: carrierPlugin.manifest.name,
        // As the plugin's setup builds it, over the host's disclosed pass-through core; the pace
        // hook stands in for the 5 s wait by clearing the shared budget row's spacing.
        spec: identityJoinCommand(
          {
            apply: (kind, answers, scope) =>
              consultPassThrough(passThrough, kind, answers, scope),
          },
          true,
          { pace: unspaced },
        ),
        writer: true,
        config: {} as PluginContext["config"],
      },
      [],
      () => ({ ...db, close: async () => {} }) as Database,
      { out: (line) => logs.push(line), error: (line) => logs.push(line) },
    );
    expect(code).toBe(0);
    expect(rxnavCalls).toEqual([
      "/REST/drugs.json?name=albendazole",
      `/REST/rxcui/${ALBENDAZOLE}/properties.json`,
    ]);
    const summary = JSON.parse(
      logs.find((line) => line.includes('"carrier_formulary_identity"'))!,
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: "complete",
      identity_source: "rxnav",
      lookups: 2,
      resolved: 1,
      pending: 0,
    });
    const joined = (
      await h.db.query<Record<string, unknown>>(
        `SELECT status, rxcui, identity_source, concept_name, confirmed_at IS NOT NULL AS confirmed
         FROM plg_carrierdoc_row_identity WHERE line = 2`,
      )
    ).rows;
    expect(joined).toEqual([
      {
        status: "resolved",
        rxcui: ALBENDAZOLE,
        identity_source: "rxnav",
        concept_name: "albendazole 200 MG Oral Tablet",
        confirmed: true,
      },
    ]);

    // A request without an ACTIVE release: RxNav confirms the RxCUI live and is disclosed.
    configurePassThrough({
      fetchOptions: fetchOptions(),
      admission: session,
      cacheStore: new MemoryCache(8 * 1024 ** 2),
    });
    await unspaced();
    rxnavCalls = [];
    const live = await withUpstreamDisclosure(async () => ({
      answer: (await checkDrugCoverage(
        h.db,
        plan,
        ALBENDAZOLE,
        "2026",
        context(),
      )) as DrugCoverage,
      sources: upstreamSources(),
    }));
    expect(rxnavCalls).toEqual([`/REST/rxcui/${ALBENDAZOLE}/properties.json`]);
    expect(live.sources).toEqual(["rxnav"]);
    expect(live.answer).toMatchObject({
      status: "listed_covered",
      drug_tier: "Generic",
      prior_authorization: true,
      rxnorm_identity: { source_id: "rxnav" },
      formulary_document: {
        evidence: [
          {
            snapshot_id: DOC,
            document: { line: 2, raw_text: "  albendazole tab 200 mg  2" },
            identity: { rxcui: ALBENDAZOLE, source_id: "rxnav" },
          },
        ],
      },
    });

    // With the RxCUI in an ACTIVE release, RxNav is not asked and nothing is disclosed.
    await h.db.query(
      `INSERT INTO rx_concept(snapshot_id,rxcui,rxaui,name,tty,suppress,source_record)
       VALUES ('rx',$1,'synthetic-aui-199672','albendazole 200 MG Oral Tablet','SCD','N',9001)`,
      [ALBENDAZOLE],
    );
    await setRelease(true);
    rxnavCalls = [];
    const local = await withUpstreamDisclosure(async () => ({
      answer: (await checkDrugCoverage(
        h.db,
        plan,
        ALBENDAZOLE,
        "2026",
        context(),
      )) as DrugCoverage,
      sources: upstreamSources(),
    }));
    expect(rxnavCalls).toEqual([]);
    expect(local.sources).toEqual([]);
    expect(local.answer).toMatchObject({ status: "listed_covered" });
    expect(local.answer.rxnorm_identity).toBeUndefined();
  });
});

describe("loaded machine-readable files win", () => {
  it("the files' answer is served unchanged; passthrough_conflict records the document's agreement", async () => {
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
    await h.replace(await fixture("drugs"));
    await importFormulary(h.db, formularyScope);
    const files = (await checkDrugCoverage(
      h.db,
      plan,
      LISTED,
      "2026",
      context(),
    )) as DrugCoverage;
    expect(files.status).toBe("listed_covered");
    expect(files.drug_tier).toBe("PREFERRED-GENERIC");
    expect(files.formulary_document).toBeUndefined();
    expect(files.evidence.length).toBeGreaterThan(0);
    expect(
      (
        await h.db.query(
          `SELECT source_id,kind,plan_id,identity,plan_year,source_snapshot_id,source_outcome,local_status,agrees
           FROM passthrough_conflict WHERE source_id=$1`,
          [SOURCE_ID],
        )
      ).rows,
    ).toEqual([
      {
        source_id: SOURCE_ID,
        kind: "drug",
        plan_id: plan,
        identity: LISTED,
        plan_year: 2026,
        source_snapshot_id: DOC,
        source_outcome: "covered",
        local_status: "listed_covered",
        agrees: true,
      },
    ]);
    // Planted mutant: a document answer outranks the files.
    const mutant = await plantMutant(
      new URL("../../src/domain/drugs/documents.ts", import.meta.url),
      `const fillable =
    answer.status === "unknown" &&
    DOCUMENT_OPENING_REASONS.includes(answer.reason ?? "");`,
      'const fillable = answer.status !== "conflicting";',
    );
    try {
      const { withDocumentCoverage: mutated } = (await import(mutant.path)) as {
        withDocumentCoverage: typeof withDocumentCoverage;
      };
      expect(await withDocumentCoverage(h.db, files)).toEqual(files);
      expect((await mutated(h.db, files)).formulary_document).toBeDefined();
    } finally {
      await mutant.cleanup();
    }
  });
});
