// RxNav drug name search end to end: `/v1/drugs?q=` and the MCP `search_drugs` tool with no
// RxNorm release ACTIVE. RxNav's answer is the recorded fixture drugs-metformin.json (labelled
// `recorded` in tests/fixtures/rxnav/recorded.json); other names, robots and terms pages are
// synthetic. An injected transport serves everything; no network.
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
import { MAX_CANDIDATES } from "@openplans/plugin-sdk";
import * as RxnavPackage from "@openplans/source-rxnav-identity";
import { createApp } from "../../src/api/app.js";
import { ttlTable } from "../../src/api/cache/index.js";
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
import { callTool } from "../../src/mcp/tools.js";
import { assertHonest } from "../../src/mcp/schemas.js";
import { configurePassThrough } from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { searchDrugs } from "../../src/services/drugs.js";
import type * as DrugsModule from "../../src/services/drugs.js";
import {
  upstreamSources,
  withUpstreamDisclosure,
} from "../../src/services/upstream-disclosure.js";
import { setup } from "../ingest/qhp/formulary-helpers.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const RXNAV = RxnavPackage.RXNAV_HOST;
/** The generic name of the recorded fixture. */
const RECORDED_NAME = "metformin";
const fixtures = new URL("../fixtures/rxnav/", import.meta.url);
const shippedFederal = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const syntheticTerms = (url: string) =>
  `Synthetic stand-in for the reviewed terms document ${url}`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Search = Awaited<ReturnType<typeof searchDrugs>> & {
  candidates: Record<string, unknown>[];
  terminology_status: string;
  terminology_evidence?: Record<string, unknown>;
  reason?: string;
};

let h: Awaited<ReturnType<typeof setup>>;
let app: ReturnType<typeof createApp>;
let scratch: string;
let manifestPath: string;
let recordedBody: string;
let recordedCandidates: { rxcui: string; name: string; tty: string }[];
/** Each RxNav request as path plus query. */
let rxnavCalls: string[];

const transport: Transport = async (url) => {
  let status = 200;
  let body = "";
  if (url.pathname === "/robots.txt") {
    if (url.hostname === RXNAV) status = 404;
    else body = "User-agent: *\nDisallow: /*.txt$\n";
  } else if (url.hostname !== RXNAV)
    body = syntheticTerms(`${url.origin}${url.pathname}`);
  else {
    rxnavCalls.push(`${url.pathname}${url.search}`);
    body =
      url.pathname === "/REST/drugs.json" &&
      url.searchParams.get("name") === RECORDED_NAME
        ? recordedBody
        : JSON.stringify({ drugGroup: { name: null } });
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
const context = () => cmsFallbackContext(h.db, h.db)!;

async function setRelease(active: boolean) {
  await h.db.query(
    `UPDATE snapshot SET validation_state=$1 WHERE snapshot_id='rx'`,
    [active ? "ACTIVE" : "QUARANTINED"],
  );
}
async function unspaced() {
  await h.db.exec(
    `UPDATE passthrough_budget SET next_request_at='epoch',daily_requests=0,blocked_until='epoch',
       failure_count=0,half_open=false`,
  );
}
const search = (
  q: string,
  search: typeof searchDrugs = searchDrugs,
  limit = "50",
) => search(h.db, { q, limit }, context()) as Promise<Search>;

/** Contract: suggestions carry the passthrough label and RxNav's evidence with NLM's statement. */
function expectLabelled(found: Search, limit: number) {
  expect(found.terminology_status).toBe("passthrough");
  expect(found.exact_concept_required).toBe(true);
  expect(found.terminology_evidence).toMatchObject({
    source_id: "rxnav",
    level: "memory",
    source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
    terms_url: RxnavPackage.RXNAV_TERMS_URL,
    limits: RxnavPackage.NAME_SEARCH_LIMITS,
  });
  expect(found.candidates).toEqual(recordedCandidates.slice(0, limit));
}
/** Contract: a search RxNav answered is labelled, exact, and asked drugs.json once. */
async function labelledContract(search_: typeof searchDrugs) {
  const found = await search("  Metformin ", search_, "5");
  expect(rxnavCalls).toEqual([`/REST/drugs.json?name=${RECORDED_NAME}`]);
  expectLabelled(found, 5);
}
/** Contract: with a release ACTIVE, RxNav is not asked and the release answers. */
async function releaseWinsContract(search_: typeof searchDrugs) {
  await setRelease(true);
  try {
    const found = await search(RECORDED_NAME, search_);
    expect(rxnavCalls).toEqual([]);
    expect(found.terminology_status).toBe("available");
    expect(found.terminology_evidence).toBeUndefined();
  } finally {
    await setRelease(false);
  }
}
/** Contract: `passthrough=off` asks RxNav nothing and keeps the empty list unknown. */
async function declinedContract(search_: typeof searchDrugs) {
  const { found, sources } = await withUpstreamDisclosure(async () => {
    const found = await search(RECORDED_NAME, search_);
    return { found, sources: upstreamSources() };
  }, true);
  expect(rxnavCalls).toEqual([]);
  expect(sources).toEqual([]);
  expect(found).toEqual({
    candidates: [],
    exact_concept_required: true,
    terminology_status: "unknown",
    reason: "rxnorm_terminology_unavailable",
  });
}

beforeAll(async () => {
  h = await setup();
  app = createApp(h.db, {});
  scratch = await mkdtemp(join(tmpdir(), "openplans-rxnav-names-"));
  const index = JSON.parse(
    await readFile(new URL("recorded.json", fixtures), "utf8"),
  ) as { files: { file: string; label: string; sha256: string }[] };
  const entry = index.files.find((f) => f.file === "drugs-metformin.json")!;
  expect(entry.label).toBe("recorded");
  recordedBody = await readFile(new URL(entry.file, fixtures), "utf8");
  expect(digest(recordedBody)).toBe(entry.sha256);
  const parsed = JSON.parse(recordedBody) as {
    drugGroup: {
      conceptGroup: {
        conceptProperties?: {
          rxcui: string;
          name: string;
          tty: string;
          suppress: string;
        }[];
      }[];
    };
  };
  recordedCandidates = parsed.drugGroup.conceptGroup
    .flatMap((group) => group.conceptProperties ?? [])
    .filter((concept) => concept.suppress === "N")
    .map(({ rxcui, name, tty }) => ({ rxcui, name, tty }))
    .slice(0, MAX_CANDIDATES);
  const federal = admissionManifestSchema.parse(
    JSON.parse(await readFile(shippedFederal, "utf8")),
  );
  const publishers: PublisherPolicy[] = [
    federal.publishers.find((p) => p.host === RXNAV)!,
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
  configurePassThrough({});
  await h?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  rxnavCalls = [];
  vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
  configurePassThrough({
    fetchOptions: fetchOptions(),
    admission: session,
    cacheStore: new MemoryCache(8 * 1024 ** 2),
  });
  await setRelease(false);
  await unspaced();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("name search without an ACTIVE release", () => {
  it("serves RxNav's current concepts labelled passthrough, with NLM's statement, exact concept required", async () => {
    await labelledContract(searchDrugs);
  });

  it("keeps a second search of the same name in memory: no second call", async () => {
    await search("metformin");
    await unspaced();
    const again = await search("METFORMIN", searchDrugs, "100");
    expect(rxnavCalls).toHaveLength(1);
    expectLabelled(again, MAX_CANDIDATES);
    expect(again.terminology_evidence).toMatchObject({
      served_from: "memory",
    });
  });

  it("a name RxNav does not know is labelled too, with an empty list", async () => {
    const found = await search("zzzznotadrug");
    expect(rxnavCalls).toEqual(["/REST/drugs.json?name=zzzznotadrug"]);
    expect(found).toMatchObject({
      candidates: [],
      terminology_status: "passthrough",
      terminology_evidence: { source_id: "rxnav", outcome: "no_data" },
    });
  });

  it("asks nothing for a name the source does not take, and stays unknown", async () => {
    const found = await search("metformin<script>");
    expect(rxnavCalls).toEqual([]);
    expect(found).toMatchObject({
      terminology_status: "unknown",
      reason: "rxnorm_terminology_unavailable",
    });
  });

  it("with the switch off there is no scope and nothing is asked", async () => {
    vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "");
    const found = (await searchDrugs(
      h.db,
      { q: RECORDED_NAME },
      cmsFallbackContext(h.db, h.db),
    )) as Search;
    expect(rxnavCalls).toEqual([]);
    expect(found.terminology_status).toBe("unknown");
  });

  it("a loaded RxNorm release wins: RxNav is not asked", async () => {
    await releaseWinsContract(searchDrugs);
  });

  it("passthrough=off asks RxNav nothing", async () => {
    await declinedContract(searchDrugs);
  });

  it("is spaced by the 5 s host floor with the identity lookups: one call per window", async () => {
    await search("metformin");
    const next = await search("zzzznotadrug");
    expect(rxnavCalls).toHaveLength(1);
    expect(next.terminology_status).toBe("unknown");
  });
});

describe("GET /v1/drugs", () => {
  it("discloses rxnav in x-openplans-upstream and keeps the 60 s response cache", async () => {
    const response = await app.request("/v1/drugs?q=Metformin&limit=3");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-openplans-upstream")).toBe("rxnav");
    const body = (await response.json()) as Search;
    expectLabelled(body, 3);
    expect(ttlTable().get("GET /v1/drugs")).toBe(60);
  });

  it("?passthrough=off keeps the request local", async () => {
    const response = await app.request(
      "/v1/drugs?q=metformin&limit=4&passthrough=off",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-openplans-upstream")).toBeNull();
    expect(rxnavCalls).toEqual([]);
    expect(await response.json()).toMatchObject({
      candidates: [],
      terminology_status: "unknown",
    });
  });
});

describe("MCP search_drugs", () => {
  it("is read-only: unknown until a REST search fetched the name, then the labelled suggestions", async () => {
    const before = await callTool({ db: h.db }, "search_drugs", {
      query: "metformin",
      limit: 2,
    });
    expect(rxnavCalls).toEqual([]);
    expect(before.structuredContent).toMatchObject({
      status: "unknown",
      data: { terminology_status: "unknown", candidates: [] },
    });
    await search("metformin");
    const after = await callTool({ db: h.db }, "search_drugs", {
      query: "Metformin",
      limit: 2,
    });
    const output = after.structuredContent as {
      data: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    expect(output.data).toMatchObject({
      exact_concept_required: true,
      terminology_status: "passthrough",
      terminology_evidence: {
        source_id: "rxnav",
        source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
        terms_url: RxnavPackage.RXNAV_TERMS_URL,
      },
    });
    expect(output.data.candidates).toEqual(
      recordedCandidates
        .slice(0, 2)
        .map((c) => ({ kind: "drug_suggestion", ...c })),
    );
    expect(output.page).toMatchObject({ returned: 2, total: MAX_CANDIDATES });
    expect(rxnavCalls).toHaveLength(1);
    // Suggestions without the label, or release concepts mixed into them, are refused.
    const unlabelled = structuredClone(after.structuredContent) as {
      data: Record<string, unknown>;
    };
    unlabelled.data.terminology_status = "unknown";
    delete unlabelled.data.terminology_evidence;
    expect(() => assertHonest("search_drugs", unlabelled)).toThrow(
      "unlabelled drug suggestion",
    );
    const bare = structuredClone(after.structuredContent) as {
      data: Record<string, unknown>;
    };
    delete bare.data.terminology_evidence;
    expect(() => assertHonest("search_drugs", bare)).toThrow(
      "passthrough terminology without evidence",
    );
  });
});

describe("planted mutants", () => {
  async function plantedDrugs(before: string, after: string) {
    const mutant = await plantMutant(
      new URL("../../src/services/drugs.ts", import.meta.url),
      before,
      after,
    );
    const module = (await import(
      /* @vite-ignore */ mutant.path
    )) as typeof DrugsModule;
    return { search: module.searchDrugs, cleanup: mutant.cleanup };
  }

  it("kills: candidates served without the source label", async () => {
    const mutant = await plantedDrugs(
      `terminology_status: "passthrough" as const,
        terminology_evidence: suggested.evidence`,
      `...status`,
    );
    try {
      await expect(labelledContract(mutant.search)).rejects.toThrow();
      // The mutant serves RxNav's candidates as if they came from a release.
      await unspaced();
      const found = await search("zzzz metformin", mutant.search);
      expect(found.terminology_status).toBe("unknown");
      expect(found.terminology_evidence).toBeUndefined();
      expect(rxnavCalls).toHaveLength(2);
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: RxNav asked while an RxNorm release is ACTIVE", async () => {
    const mutant = await plantedDrugs(
      `if (status.terminology_status === "unknown") {`,
      `if (status.terminology_status) {`,
    );
    try {
      await expect(releaseWinsContract(mutant.search)).rejects.toThrow();
      expect(rxnavCalls).toHaveLength(1);
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: exact_concept_required flipped on suggestions", async () => {
    const mutant = await plantedDrugs(
      `candidates: suggested.candidates.slice(0, Number(limit)),
        exact_concept_required: true,`,
      `candidates: suggested.candidates.slice(0, Number(limit)),
        exact_concept_required: false,`,
    );
    try {
      await expect(labelledContract(mutant.search)).rejects.toThrow();
      expect(rxnavCalls).toHaveLength(1);
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: RxNav asked under passthrough=off", async () => {
    const planted = await plantMutant(
      new URL("../../src/services/drug-name-search.ts", import.meta.url),
      `const [answer] = await consultPassThrough(
    api,
    DRUG_NAME_SEARCH_KIND,
    [asked],
    scope,
  );`,
      `const [answer] = await api.apply(DRUG_NAME_SEARCH_KIND, [asked], scope);`,
    );
    const mutant = await plantedDrugs(
      `import { suggestDrugNames } from "./drug-name-search.js";`,
      `import { suggestDrugNames } from ${JSON.stringify(planted.path)};`,
    );
    try {
      await expect(declinedContract(mutant.search)).rejects.toThrow();
      expect(rxnavCalls).toHaveLength(1);
    } finally {
      await mutant.cleanup();
      await planted.cleanup();
    }
  });
});
