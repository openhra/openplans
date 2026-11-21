// The RxNav drug identity source end to end: the switch, the shipped manifest entry, the identity
// stage in drugCoverage and the services, and the CMS source accepting RxNav-confirmed RxCUIs.
// RxNav answers come from the recorded fixtures (tests/fixtures/rxnav, labelled `recorded`) or
// from synthetic variants (synthetic-unknown-rxcui.json, labelled `synthetic`); CMS answers, terms
// pages and the key are synthetic. An injected transport serves everything; no network.
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
import { DRUG_IDENTITY_KIND } from "@openplans/plugin-sdk";
import type {
  PassThroughApi,
  PassThroughScope,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import * as CmsPackage from "@openplans/source-cms-marketplace-api";
import * as RxnavPackage from "@openplans/source-rxnav-identity";
import { loadConfig } from "../../src/config/index.js";
import type * as ConfigModule from "../../src/config/index.js";
import { parse_hios } from "../../src/domain/hios/index.js";
import { drugCoverage } from "../../src/domain/drugs/repository.js";
import type * as RepositoryModule from "../../src/domain/drugs/repository.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import {
  AdmissionSession,
  admissionManifestSchema,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import { cmsFallbackContext } from "../../src/ingest/cms-api/fallback.js";
import { implicitPassThroughSources } from "../../src/plugins/core-plugin.js";
import {
  configurePassThrough,
  createPassThrough,
} from "../../src/plugins/sources/passthrough.js";
import type * as PassThroughModule from "../../src/plugins/sources/passthrough.js";
import { importFormulary } from "../../src/ingest/qhp/formulary.js";
import type { PassThroughDeps } from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { checkDrugCoverage } from "../../src/services/drugs.js";
import {
  applyQuoteFallback,
  readQuoteCoverage,
} from "../../src/services/quote-coverage.js";
import {
  consultPassThrough,
  upstreamSources,
  withUpstreamDisclosure,
} from "../../src/services/upstream-disclosure.js";
import { importMutant, plantMutantPackage } from "../mutant-file.js";
import {
  scope as formularyScope,
  fixture as formularyFixture,
  setup,
} from "../ingest/qhp/formulary-helpers.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

type Source = PassThroughSource<Question, unknown>;
type RxnavFactory = typeof RxnavPackage.createRxnavIdentitySource;
type CmsFactory = typeof CmsPackage.createCmsMarketplaceSource;

const RXNAV = RxnavPackage.RXNAV_HOST;
const CMS = CmsPackage.CMS_API_HOST;
/** The recorded fixtures' current, unsuppressed concept. */
const CURRENT = "860975";
/** Synthetic: no properties, a remapped history. */
const RETIRED = "999999901";
/** Synthetic: properties with a suppress flag other than N. */
const SUPPRESSED = "999999902";
/** Synthetic: an RxCUI that is no concept, answered as in synthetic-unknown-rxcui.json. */
let UNKNOWN: string;
/** A synthetic concept of the test RxNorm release that the synthetic formulary lists. */
let LISTED: string;
type UnknownCase = "empty-200" | "not-found-404";
let unknownCase: UnknownCase;
let unknownResponses: Record<
  UnknownCase,
  Record<string, { status: number; body: string }>
>;
const plantedKey = "PLANTED-rxnav-test-key-4k3j2h";
const fixtures = new URL("../fixtures/rxnav/", import.meta.url);
const shippedFederal = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const shippedCms = fileURLToPath(
  new URL("../../data/access/cms-marketplace-api.json", import.meta.url),
);
const syntheticTerms = (url: string) =>
  `Synthetic stand-in for the reviewed terms document ${url}`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
let scratch: string;
let manifestPath: string;
let recorded: Record<string, string>;
let rxnavCalls: string[];
let cmsCalls: string[];
let rxnavStatus: number;

const transport: Transport = async (url) => {
  let status = 200;
  let body = "";
  if (url.pathname === "/robots.txt") {
    // RxNav answers a direct 404; the CMS API answers 401 like every unauthenticated path.
    if (url.hostname === RXNAV) status = 404;
    else if (url.hostname === CMS) status = 401;
    else body = "User-agent: *\nDisallow: /*.txt$\n";
  } else if (url.hostname !== RXNAV && url.hostname !== CMS)
    body = syntheticTerms(`${url.origin}${url.pathname}`);
  else if (url.hostname === RXNAV) {
    rxnavCalls.push(url.pathname);
    status = rxnavStatus;
    const [, , , rxcui, file] = url.pathname.split("/");
    if (rxcui === UNKNOWN) {
      const synthetic = unknownResponses[unknownCase][file!]!;
      status = rxnavStatus === 200 ? synthetic.status : rxnavStatus;
      body = synthetic.body;
    } else if (rxcui === CURRENT) body = recorded[file!]!;
    else if (rxcui === LISTED && file === "properties.json")
      body = recorded["properties.json"]!.replaceAll(CURRENT, LISTED);
    else if (rxcui === SUPPRESSED && file === "properties.json")
      body = recorded["properties.json"]!.replaceAll(
        CURRENT,
        SUPPRESSED,
      ).replace('"suppress":"N"', '"suppress":"O"');
    else if (file === "properties.json") body = "{}";
    else
      body = JSON.stringify({
        rxcuiStatusHistory: {
          metaData: { status: "Remapped" },
          derivedConcepts: {
            remappedConcept: [{ remappedRxCui: CURRENT }],
          },
        },
      });
  } else {
    cmsCalls.push(url.pathname);
    const plans = url.searchParams.get("planids")!.split(",");
    const drugs = url.searchParams.get("drugs")!.split(",");
    body = JSON.stringify({
      coverage: plans.flatMap((plan_id) =>
        drugs.map((rxcui) => ({ rxcui, plan_id, coverage: "NotCovered" })),
      ),
    });
  }
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
const cmsHost = { planBase: (id: string) => parse_hios(id).base };
const rxnav = (
  factory: RxnavFactory = RxnavPackage.createRxnavIdentitySource,
) => factory() as unknown as Source;
const cms = (factory: CmsFactory = CmsPackage.createCmsMarketplaceSource) =>
  factory(cmsHost) as unknown as Source;

function core(sources: Source[], extra: Partial<PassThroughDeps> = {}) {
  return createPassThrough({
    sources: () => sources,
    fetchOptions: fetchOptions(),
    admission: session,
    ...extra,
  });
}
const scope = (): PassThroughScope => ({ reader: h.db, writer: h.db });

/** One request: the identity stage inside drugCoverage, then the coverage pass-through. */
async function request(
  api: PassThroughApi,
  rxcui: string,
  options: {
    coverage?: typeof drugCoverage;
    coverageScope?: PassThroughScope;
  } = {},
) {
  const requestScope = scope();
  const local = await (options.coverage ?? drugCoverage)(
    h.db,
    plan,
    rxcui,
    2026,
    { api, scope: requestScope },
  );
  const [served] = await api.apply(
    "drug",
    [local],
    options.coverageScope ?? requestScope,
  );
  return { local, served: served! };
}
interface IdentityQuestion {
  status: string;
  reason: string | null;
  identity: string;
  plan_year: number;
  rxnav?: Record<string, unknown>;
}
const identityQuestion = (identity: string): IdentityQuestion => ({
  status: "unknown",
  reason: "rxnorm_terminology_unavailable",
  identity,
  plan_year: 2026,
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
       failure_count=0,half_open=false;
     DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_attempt`,
  );
}

async function confirmCurrent(factory: RxnavFactory) {
  const [answer] = await core([rxnav(factory)]).apply(
    DRUG_IDENTITY_KIND,
    [identityQuestion(CURRENT)],
    scope(),
  );
  return answer!;
}
/** Contract: RxNav confirms the recorded concept, and its evidence carries NLM's statement. */
async function attributionContract(factory: RxnavFactory) {
  const answer = await confirmCurrent(factory);
  expect(answer).toMatchObject({ status: "confirmed", reason: null });
  expect(answer!.rxnav).toMatchObject({
    source_id: "rxnav",
    level: "memory",
    source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
    terms_url: RxnavPackage.RXNAV_TERMS_URL,
  });
}
/** Contract: a confirmation lets a CMS NotCovered become `covered: false`, labelled rxnav. */
async function confirmedNegativeContract(factory: RxnavFactory) {
  const { served } = await request(core([rxnav(factory), cms()]), CURRENT);
  expect(served).toMatchObject({
    status: "explicitly_not_covered",
    covered: false,
    cms_api: { coverage: "NotCovered", identity_source: "rxnav" },
  });
}
/** The coverage call made with a scope other than the one RxNav confirmed the RxCUI in. */
async function negativeFromAnotherRequest(cmsFactory: CmsFactory) {
  const { served } = await request(core([rxnav(), cms(cmsFactory)]), CURRENT, {
    coverageScope: scope(),
  });
  expect(cmsCalls).toEqual(["/api/v1/drugs/covered"]);
  return served;
}
/** Contract: a CMS NotCovered without a confirmation in this request stays unknown. */
async function unconfirmedNegativeContract(cmsFactory: CmsFactory) {
  const served = await negativeFromAnotherRequest(cmsFactory);
  expect(served).toMatchObject({
    status: "unknown",
    reason: "cms_api_reports_not_covered",
  });
  expect(served.covered).toBeUndefined();
}

/** Contract: an RxCUI that is no concept, in either response shape, is not confirmed. */
async function unknownRxcuiContract(
  shape: UnknownCase,
  factory: RxnavFactory = RxnavPackage.createRxnavIdentitySource,
) {
  unknownCase = shape;
  const { local, served } = await request(
    core([rxnav(factory), cms()]),
    UNKNOWN,
  );
  expect(rxnavCalls).toEqual([
    `/REST/rxcui/${UNKNOWN}/properties.json`,
    `/REST/rxcui/${UNKNOWN}/historystatus.json`,
  ]);
  expect(local.reason).toBe("rxcui_not_in_rxnorm");
  expect(local.rxnorm_identity).toBeUndefined();
  expect(served).toBe(local);
  expect(cmsCalls).toEqual([]);
}
/** Contract: a drug answer whose RxCUI RxNav confirmed carries NLM's statement. */
async function drugAttributionContract(coverage: typeof drugCoverage) {
  const { local, served } = await request(core([rxnav(), cms()]), CURRENT, {
    coverage,
  });
  const attribution = {
    source_id: "rxnav",
    source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
    terms_url: RxnavPackage.RXNAV_TERMS_URL,
  };
  expect(local.rxnorm_identity).toMatchObject(attribution);
  expect(served).toMatchObject({
    status: "explicitly_not_covered",
    rxnorm_identity: attribution,
    cms_api: { identity_source: "rxnav" },
  });
}
/** Contract: a live RxNav call that fails is still named for `x-openplans-upstream`. */
async function failedCallDisclosedContract(factory: typeof createPassThrough) {
  rxnavStatus = 503;
  const api = factory({
    sources: () => [rxnav()],
    fetchOptions: fetchOptions(),
    admission: session,
  });
  const sources = await withUpstreamDisclosure(async () => {
    const [answer] = await consultPassThrough(
      api,
      DRUG_IDENTITY_KIND,
      [identityQuestion(CURRENT)],
      scope(),
    );
    // The failed lookup leaves no evidence block for the host to find.
    expect(answer).toMatchObject({ status: "unknown" });
    expect(answer).not.toHaveProperty("rxnav");
    return upstreamSources();
  });
  expect(rxnavCalls).toEqual([`/REST/rxcui/${CURRENT}/properties.json`]);
  expect(sources).toEqual(["rxnav"]);
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0]!.base_plan_id as string;
  scratch = await mkdtemp(join(tmpdir(), "openplans-rxnav-identity-"));
  const synthetic = JSON.parse(
    await readFile(new URL("synthetic-unknown-rxcui.json", fixtures), "utf8"),
  ) as {
    label: string;
    rxcui: string;
    cases: typeof unknownResponses;
  };
  expect(synthetic.label).toBe("synthetic");
  UNKNOWN = synthetic.rxcui;
  unknownResponses = synthetic.cases;
  LISTED = (await formularyFixture("drugs"))[0].rxnorm_id;
  recorded = {
    "properties.json": await readFile(
      new URL("properties-860975.json", fixtures),
      "utf8",
    ),
    "historystatus.json": await readFile(
      new URL("historystatus-860975.json", fixtures),
      "utf8",
    ),
  };
  // The shipped entries with only the terms hashes replaced, since the real terms pages are not
  // committed. Hosts, paths, robots evidence, pacing and caps are the shipped values.
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
}, 120_000);
afterAll(async () => {
  await h?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  rxnavCalls = [];
  cmsCalls = [];
  rxnavStatus = 200;
  unknownCase = "empty-200";
  vi.stubEnv("CMS_API_KEY", plantedKey);
  await setRelease(false);
  await unspaced();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("switch", () => {
  it("is off by default, and on only with OPENPLANS_RXNAV_IDENTITY=on", () => {
    expect(loadConfig({}).rxnavIdentity).toBe(false);
    expect(loadConfig({ OPENPLANS_RXNAV_IDENTITY: "yes" }).rxnavIdentity).toBe(
      false,
    );
    expect(loadConfig({ OPENPLANS_RXNAV_IDENTITY: "on" }).rxnavIdentity).toBe(
      true,
    );
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "");
    expect(implicitPassThroughSources().map((s) => s.id)).not.toContain(
      "rxnav",
    );
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
    expect(implicitPassThroughSources().map((s) => s.id)).toContain("rxnav");
  });
});

describe("shipped manifest entry", () => {
  it("clears rxnav.nlm.nih.gov for the three API paths, on a robots 404 seen from a recorded country", async () => {
    const federal = admissionManifestSchema.parse(
      JSON.parse(await readFile(shippedFederal, "utf8")),
    );
    const entry = federal.publishers.find((p) => p.host === RXNAV)!;
    expect(entry.state).toBe("allowed");
    expect(entry.permittedPaths).toEqual([
      "/REST/rxcui/",
      "/REST/drugs.json",
      "/REST/version.json",
    ]);
    expect(entry.robots).toMatchObject({ status: 404, sha256: null });
    expect(entry.robots!.country).toMatch(/^[A-Z]{2}$/);
    expect(entry.delayMs).toBeGreaterThanOrEqual(5000);
    expect(entry.terms!.url).toBe(RxnavPackage.RXNAV_TERMS_URL);
    expect(entry.attribution).toContain(RxnavPackage.NLM_ACKNOWLEDGEMENT);
    // The source asks only paths the entry permits.
    for (const path of rxnav().manifest.permittedPaths)
      expect(entry.permittedPaths).toContain(path);
  });
});

describe("identity lookups", () => {
  it("asks properties.json only for a current concept and caches the confirmation for 24 hours", async () => {
    const store = new MemoryCache(8 * 1024 ** 2);
    const ttls: number[] = [];
    const set = store.setBounded.bind(store);
    store.setBounded = async (input) => {
      ttls.push(input.ttlSeconds);
      await set(input);
    };
    const api = core([rxnav()], { cacheStore: store });
    const [first] = await api.apply(
      DRUG_IDENTITY_KIND,
      [identityQuestion(CURRENT)],
      scope(),
    );
    expect(first!.status).toBe("confirmed");
    expect(rxnavCalls).toEqual([`/REST/rxcui/${CURRENT}/properties.json`]);
    expect(ttls).toEqual([24 * 60 * 60]);
    const [again] = await api.apply(
      DRUG_IDENTITY_KIND,
      [identityQuestion(CURRENT)],
      { reader: h.db },
    );
    expect(again!.status).toBe("confirmed");
    expect(again!.rxnav?.served_from).toBe("memory");
    expect(rxnavCalls).toHaveLength(1);
    // Memory only: nothing about the answer reaches the database.
    const stored = await h.db.query(
      `SELECT 1 FROM snapshot WHERE source_id='rxnav'`,
    );
    expect(stored.rows).toEqual([]);
  });

  it("follows an RxCUI without properties with historystatus.json, and keeps it unconfirmed for 1 hour", async () => {
    const store = new MemoryCache(8 * 1024 ** 2);
    const ttls: number[] = [];
    const set = store.setBounded.bind(store);
    store.setBounded = async (input) => {
      ttls.push(input.ttlSeconds);
      await set(input);
    };
    const [answer] = await core([rxnav()], { cacheStore: store }).apply(
      DRUG_IDENTITY_KIND,
      [identityQuestion(RETIRED)],
      scope(),
    );
    expect(rxnavCalls).toEqual([
      `/REST/rxcui/${RETIRED}/properties.json`,
      `/REST/rxcui/${RETIRED}/historystatus.json`,
    ]);
    expect(answer).toMatchObject({
      status: "unknown",
      reason: "passthrough_identity_not_confirmed",
      rxnav: {
        statement: `No current RxNorm properties; history status Remapped, remapped to ${CURRENT}`,
      },
    });
    expect(ttls).toEqual([60 * 60]);
  });

  it("a suppressed concept is not confirmed and needs no history lookup", async () => {
    const [answer] = await core([rxnav()]).apply(
      DRUG_IDENTITY_KIND,
      [identityQuestion(SUPPRESSED)],
      scope(),
    );
    expect(answer!.status).toBe("unknown");
    expect(rxnavCalls).toEqual([`/REST/rxcui/${SUPPRESSED}/properties.json`]);
  });

  it("spaces calls by the 5 s host floor: a second RxCUI right after is refused, not queued", async () => {
    const api = core([rxnav()]);
    await api.apply(DRUG_IDENTITY_KIND, [identityQuestion(CURRENT)], scope());
    const [second] = await api.apply(
      DRUG_IDENTITY_KIND,
      [identityQuestion(SUPPRESSED)],
      scope(),
    );
    expect(rxnavCalls).toHaveLength(1);
    expect(second!.status).toBe("unknown");
  });

  it.each(["empty-200", "not-found-404"] as const)(
    "an RxCUI that is no concept (synthetic %s) is rxcui_not_in_rxnorm, not terminology_unavailable",
    async (shape) => {
      await unknownRxcuiContract(shape);
    },
  );

  it("an RxNav outage leaves rxnorm_terminology_unavailable and opens no coverage call", async () => {
    rxnavStatus = 503;
    const { local } = await request(core([rxnav(), cms()]), CURRENT);
    expect(local.reason).toBe("rxnorm_terminology_unavailable");
    expect(cmsCalls).toEqual([]);
  });
});

describe("CMS source and RxNav-confirmed identities", () => {
  it("serves covered: false for an RxCUI RxNav confirmed in this request, labelled identity_source rxnav", async () => {
    await confirmedNegativeContract(RxnavPackage.createRxnavIdentitySource);
  });

  it("the drug answer carries NLM's acknowledgement, not only the identity evidence", async () => {
    await drugAttributionContract(drugCoverage);
  });

  it("a NotCovered for an RxCUI nobody confirmed stays unknown, without the label", async () => {
    unknownCase = "not-found-404";
    const { served } = await request(core([rxnav(), cms()]), UNKNOWN);
    expect(served).toMatchObject({
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
    });
    expect(served.covered).toBeUndefined();
    expect(served.cms_api).toBeUndefined();
  });

  it("keeps a NotCovered unknown when the confirmation came from another request", async () => {
    await unconfirmedNegativeContract(CmsPackage.createCmsMarketplaceSource);
  });

  it("a retired RxCUI stays rxcui_not_in_rxnorm and CMS is not asked", async () => {
    const { local, served } = await request(core([rxnav(), cms()]), RETIRED);
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
    expect(served).toBe(local);
    expect(cmsCalls).toEqual([]);
  });

  it("a loaded RxNorm release wins: RxNav is not asked", async () => {
    await setRelease(true);
    await request(core([rxnav(), cms()]), CURRENT);
    expect(rxnavCalls).toEqual([]);
  });
});

describe("services pass the identity stage with the request's scope", () => {
  beforeEach(() => {
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
    vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on");
    configurePassThrough({ fetchOptions: fetchOptions(), admission: session });
  });
  afterEach(() => configurePassThrough({}));
  const context = () =>
    cmsFallbackContext(h.db, h.db, {
      admission: session(),
      fetchOptions: fetchOptions(),
    })!;

  it("checkDrugCoverage", async () => {
    const served = await checkDrugCoverage(
      h.db,
      plan,
      CURRENT,
      "2026",
      context(),
    );
    expect(served).toMatchObject({
      status: "explicitly_not_covered",
      cms_api: { identity_source: "rxnav" },
      rxnorm_identity: { source: RxnavPackage.NLM_ACKNOWLEDGEMENT },
    });
  });

  it("names rxnav in the upstream disclosure next to the coverage source", async () => {
    const sources = await withUpstreamDisclosure(async () => {
      await checkDrugCoverage(h.db, plan, CURRENT, "2026", context());
      return upstreamSources();
    });
    expect(sources).toEqual(["cms-marketplace-api", "rxnav"]);
  });

  it("passthrough=off asks RxNav nothing and keeps rxcui_not_in_rxnorm", async () => {
    const served = await withUpstreamDisclosure(
      () => checkDrugCoverage(h.db, plan, CURRENT, "2026", context()),
      true,
    );
    expect(rxnavCalls).toEqual([]);
    expect(cmsCalls).toEqual([]);
    expect(served).toMatchObject({
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
    });
  });

  it("readQuoteCoverage then applyQuoteFallback", async () => {
    const quoteScope = context();
    const local = await readQuoteCoverage(
      h.db,
      plan,
      [],
      [CURRENT],
      2026,
      quoteScope,
    );
    const [quote] = await applyQuoteFallback([local], quoteScope);
    expect(quote!.drugs[0]).toMatchObject({
      status: "explicitly_not_covered",
      cms_api: { identity_source: "rxnav" },
      rxnorm_identity: { source: RxnavPackage.NLM_ACKNOWLEDGEMENT },
    });
  });
});

describe("the core discloses the live calls it starts", () => {
  it("a failed RxNav call is named in x-openplans-upstream", async () => {
    await failedCallDisclosedContract(createPassThrough);
  });

  it("so is a call RxNav refuses with 429", async () => {
    rxnavStatus = 429;
    const sources = await withUpstreamDisclosure(async () => {
      await consultPassThrough(
        core([rxnav()]),
        DRUG_IDENTITY_KIND,
        [identityQuestion(CURRENT)],
        scope(),
      );
      return upstreamSources();
    });
    expect(rxnavCalls).toHaveLength(1);
    expect(sources).toEqual(["rxnav"]);
  });

  it("a call the core refuses itself never left the host and is not named", async () => {
    const api = core([rxnav()]);
    await api.apply(DRUG_IDENTITY_KIND, [identityQuestion(CURRENT)], scope());
    const sources = await withUpstreamDisclosure(async () => {
      // Inside the 5 s host floor: refused before any request is made.
      await consultPassThrough(
        api,
        DRUG_IDENTITY_KIND,
        [identityQuestion(SUPPRESSED)],
        scope(),
      );
      return upstreamSources();
    });
    expect(rxnavCalls).toHaveLength(1);
    expect(sources).toEqual([]);
  });
});

describe("planted mutants", () => {
  /** A copy of the RxNav package source with one planted change. */
  async function plantedRxnav(file: string, anchor: string, after: string) {
    const planted = await plantMutantPackage(
      new URL("../../plugins/source-rxnav-identity/", import.meta.url),
      "src",
    );
    try {
      const text = await readFile(join(planted.path, file), "utf8");
      expect(text).toContain(anchor);
      await writeFile(join(planted.path, file), text.replace(anchor, after));
      const module = await importMutant<typeof RxnavPackage>(
        new URL(`file://${join(planted.path, "index.ts")}`),
        "createRxnavIdentitySource",
      );
      return { factory: module.createRxnavIdentitySource, ...planted };
    } catch (error) {
      await planted.cleanup();
      throw error;
    }
  }

  it("kills: attribution missing from the evidence block", async () => {
    await attributionContract(RxnavPackage.createRxnavIdentitySource);
    const mutant = await plantedRxnav(
      "source.ts",
      "source: NLM_ACKNOWLEDGEMENT,",
      "source: RXNAV_PUBLISHER,",
    );
    try {
      await unspaced();
      // Still confirmed, but the evidence no longer carries NLM's statement.
      const answer = await confirmCurrent(mutant.factory);
      expect(answer.status).toBe("confirmed");
      expect(answer.rxnav).not.toHaveProperty(
        "source",
        RxnavPackage.NLM_ACKNOWLEDGEMENT,
      );
      await expect(attributionContract(mutant.factory)).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: the cache level loosened to stored", async () => {
    const mutant = await plantedRxnav(
      "constants.ts",
      'level: "memory" as const,',
      'level: "stored" as const,',
    );
    try {
      await expect(confirmedNegativeContract(mutant.factory)).rejects.toThrow();
      // A stored identity source is never asked, so nothing is confirmed.
      expect(rxnavCalls).toEqual([]);
      expect(cmsCalls).toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: a CMS negative served without a confirmation", async () => {
    const planted = await plantMutantPackage(
      new URL("../../plugins/source-cms-marketplace-api/", import.meta.url),
      "src",
    );
    try {
      const file = join(planted.path, "source.ts");
      const anchor = "if (request?.confirmed.has(id)) known.add(id);";
      const text = await readFile(file, "utf8");
      expect(text).toContain(anchor);
      await writeFile(file, text.replace(anchor, "known.add(id);"));
      const module = await importMutant<typeof CmsPackage>(
        new URL(`file://${join(planted.path, "index.ts")}`),
        "createCmsMarketplaceSource",
      );
      // The mutant serves the unconfirmed negative as "not covered".
      const served = await negativeFromAnotherRequest(
        module.createCmsMarketplaceSource,
      );
      expect(served).toMatchObject({
        status: "explicitly_not_covered",
        covered: false,
      });
    } finally {
      await planted.cleanup();
    }
  });

  it("kills: RxNav asked while an RxNorm release is ACTIVE", async () => {
    await setRelease(true);
    const mutant = await plantMutant(
      new URL("../../src/domain/drugs/repository.ts", import.meta.url),
      `if (!identity || (await rxnorm.activeRelease()))`,
      `if (!identity)`,
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RepositoryModule;
      await request(core([rxnav(), cms()]), CURRENT, {
        coverage: module.drugCoverage,
      });
      expect(() => expect(rxnavCalls).toEqual([])).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: a 404 for an unknown RxCUI read as an outage", async () => {
    const mutant = await plantedRxnav(
      "source.ts",
      "absentStatuses: ABSENT_STATUSES,",
      "",
    );
    try {
      unknownCase = "not-found-404";
      const { local } = await request(
        core([rxnav(mutant.factory), cms()]),
        UNKNOWN,
      );
      expect(local.reason).toBe("rxnorm_terminology_unavailable");
      await unspaced();
      rxnavCalls = [];
      await expect(
        unknownRxcuiContract("not-found-404", mutant.factory),
      ).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: NLM's statement left off the drug answer", async () => {
    const mutant = await plantMutant(
      new URL("../../src/domain/drugs/repository.ts", import.meta.url),
      "if (evidence) result.rxnorm_identity = evidence;",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RepositoryModule;
      await expect(
        drugAttributionContract(module.drugCoverage),
      ).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: a failed RxNav call not disclosed", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/sources/passthrough.ts", import.meta.url),
      "recordUpstream([source.id]);",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof PassThroughModule;
      await expect(
        failedCallDisclosedContract(module.createPassThrough),
      ).rejects.toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: the switch default flipped to on", async () => {
    const mutant = await plantMutant(
      new URL("../../src/config/index.ts", import.meta.url),
      "rxnavIdentity: z.boolean().default(false),",
      "rxnavIdentity: z.boolean().default(true),",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof ConfigModule;
      expect(() =>
        expect(module.loadConfig({}).rxnavIdentity).toBe(false),
      ).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

// Runs last: it activates the RxNorm release and imports a formulary into the shared database.
describe("a local release that activates later", () => {
  /** Clears pacing and budgets but keeps the stored CMS answers. */
  async function budgetsOnly() {
    await h.db.exec(
      `UPDATE passthrough_budget SET next_request_at='epoch',daily_requests=0;
       UPDATE cms_api_budget SET next_request_at='epoch',daily_requests=0`,
    );
  }

  it("records the disagreement in the conflict table, and the files win", async () => {
    // Before: no release, RxNav confirms both RxCUIs and CMS's NotCovered is served and stored.
    for (const rxcui of [LISTED, CURRENT]) {
      await budgetsOnly();
      const { served } = await request(core([rxnav(), cms()]), rxcui);
      expect(served).toMatchObject({
        status: "explicitly_not_covered",
        cms_api: { identity_source: "rxnav" },
      });
    }
    const stored = await h.db.query<{ rxcui: string; coverage: string }>(
      `SELECT rxcui,coverage FROM cms_api_drug_coverage`,
    );
    expect(stored.rows.map((row) => row.rxcui).sort()).toEqual(
      [LISTED, CURRENT].sort(),
    );

    // The release activates and the issuer's formulary lists LISTED for the plan.
    await setRelease(true);
    await h.replace(await formularyFixture("drugs"));
    const report = await importFormulary(h.db, formularyScope);
    expect(report.status).toBe("ACTIVE");
    await budgetsOnly();
    rxnavCalls = [];
    cmsCalls = [];

    const listed = await request(core([rxnav(), cms()]), LISTED);
    expect(listed.served).toBe(listed.local);
    expect(listed.served.status).toBe("listed_covered");
    expect(listed.served.cms_api).toBeUndefined();
    expect(listed.served.rxnorm_identity).toBeUndefined();
    const conflicts = await h.db.query(
      `SELECT identity,cms_coverage,authoritative_status,agrees FROM cms_api_conflict`,
    );
    expect(conflicts.rows).toEqual([
      {
        identity: LISTED,
        cms_coverage: "NotCovered",
        authoritative_status: "listed_covered",
        agrees: false,
      },
    ]);

    // An RxCUI RxNav confirmed but the release does not hold: the release wins.
    const current = await request(core([rxnav(), cms()]), CURRENT);
    expect(current.served).toBe(current.local);
    expect(current.served).toMatchObject({
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
    });
    expect(rxnavCalls).toEqual([]);
    expect(cmsCalls).toEqual([]);
  });
});
