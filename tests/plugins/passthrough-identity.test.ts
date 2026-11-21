// The drug identity stage (PRX-3): a synthetic identity source confirms RxCUIs only when no RxNorm
// release is ACTIVE, and a coverage source may accept those confirmations for this request only.
// Synthetic plans, concepts, hosts and answers; an injected transport; no network.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DRUG_IDENTITY_KIND,
  IDENTITY_OPENING_REASONS,
  PASSTHROUGH_OPENING_REASONS,
} from "@openplans/plugin-sdk";
import type {
  AbsorbedRow,
  PassThroughApi,
  PassThroughScope,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import type * as RepositoryModule from "../../src/domain/drugs/repository.js";
import { drugCoverage } from "../../src/domain/drugs/repository.js";
import type { DrugCoverage } from "../../src/domain/drugs/index.js";
import { AdmissionSession } from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import { createPassThrough } from "../../src/plugins/sources/passthrough.js";
import type { PassThroughDeps } from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import {
  IDENTITY_HOST,
  IDENTITY_PATH,
  syntheticIdentitySource,
} from "../fixtures/plugins/synthetic-drug-identity/index.mjs";
import { setup } from "../ingest/qhp/formulary-helpers.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const COVERAGE_HOST = "answers.synthetic.test";
/** The synthetic identity host lists this RxCUI as an active concept. */
const ACTIVE = "7000001";
/** The synthetic identity host does not know this RxCUI. */
const ABSENT = "8000001";
const terms = "Synthetic publisher permits request-time answers.";
const robots = "User-agent: *\nDisallow: /private\n";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const repositoryFile = new URL(
  "../../src/domain/drugs/repository.ts",
  import.meta.url,
);
const passthroughFile = new URL(
  "../../src/plugins/sources/passthrough.ts",
  import.meta.url,
);

type Source = PassThroughSource<Question, unknown>;
type Create = (deps: PassThroughDeps) => PassThroughApi;
type Coverage = typeof RepositoryModule.drugCoverage;

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
let scratch: string;
let manifestPath: string;
let identityCalls: URL[];
let coverageCalls: URL[];
let identityStatus: number;

function publisher(host: string, path: string): PublisherPolicy {
  return {
    host,
    state: "allowed",
    evidence: [
      {
        url: `https://${host}/terms`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}${path}`],
    permittedPaths: [path],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}

/** Identity host: only ACTIVE is an active concept. Coverage host: every pair is a negative. */
const transport: Transport = async (url) => {
  let body = "";
  let status = 200;
  if (url.pathname === "/robots.txt") body = robots;
  else if (url.pathname === "/terms") body = terms;
  else if (url.hostname === IDENTITY_HOST) {
    identityCalls.push(new URL(url.href));
    status = identityStatus;
    const ids = (url.searchParams.get("rxcuis") ?? "").split(",");
    body = JSON.stringify({
      concepts: ids
        .filter((id) => id === ACTIVE)
        .map((rxcui) => ({ rxcui, status: "active" })),
    });
  } else {
    coverageCalls.push(new URL(url.href));
    body = JSON.stringify({
      pairs: (url.searchParams.get("q") ?? "").split(","),
    });
  }
  return { status, headers: {}, body: Readable.from([body]) };
};

/**
 * A synthetic coverage source that answers every pair with a negative. Its `confirmIdentities`
 * knows nothing locally and accepts only what the identity stage confirmed in this request.
 */
function coverageSource(): Source {
  return {
    kind: "passthrough",
    id: "synthetic-coverage",
    publisher: "Synthetic publisher",
    kinds: ["drug"],
    manifest: {
      host: COVERAGE_HOST,
      accessMode: "public",
      permittedPaths: ["/answers"],
    },
    cache: { level: "none" },
    eligibility: {
      openingReasons: PASSTHROUGH_OPENING_REASONS,
      accepts: () => true,
    },
    question: (_kind, answer) => {
      const a = answer as unknown as DrugCoverage;
      return {
        planId: a.requested_plan_id,
        identity: a.rxcui,
        year: a.plan_year,
      };
    },
    confirmIdentities: async (_db, _kind, ids, request) =>
      new Set(ids.filter((id) => request?.confirmed.has(id))),
    batch: { maxQuestionsPerCall: 10, maxCallsPerRequest: 2 },
    budget: {
      dailyMax: 50,
      minIntervalMs: 0,
      clientShare: 1,
      breaker: { failures: 5, windowMs: 300_000, pauseMs: 900_000 },
    },
    buildRequest: (questions) => ({
      path: "/answers",
      query: {
        q: questions.map((q) => `${q.planId}:${q.identity}`).join(","),
      },
    }),
    mapResponse: (_body, questions) =>
      questions.map((question) => ({
        question,
        outcome: "answer" as const,
        answer: { status: "explicitly_not_covered" },
        negative: true,
        statement: "NotCovered",
      })),
    evidence: {
      source: "Synthetic publisher",
      termsUrl: `https://${COVERAGE_HOST}/terms`,
    },
  };
}

/** A `stored` identity source whose own storage already holds a confirmation for every id. */
function storedIdentitySource(): Source {
  const confirmed = (q: Question): AbsorbedRow<unknown> => ({
    identity: q.identity,
    year: q.year,
    outcome: "answer",
    answer: { confirmed: true },
    statement: "Active concept",
    snapshotId: "synthetic-identity-stored",
    sourcedAt: new Date().toISOString(),
    freshness: "absorbed",
  });
  return syntheticIdentitySource("stored", {
    storage: {
      readAbsorbed: async (_db: unknown, questions: Question[]) =>
        questions.map(confirmed),
      writeAbsorbed: async () => {},
      recordConflict: async () => {},
      excludedTables: [],
    },
  }) as Source;
}

function deps(sources: Source[]): PassThroughDeps {
  return {
    sources: () => sources,
    fetchOptions: {
      transport,
      dataDir: scratch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    },
    admission: () =>
      new AdmissionSession([manifestPath], {
        maxRequests: 100,
        maxTransferBytes: 1024 ** 2,
      }),
  };
}
const requestScope = (): PassThroughScope => ({ reader: h.db, writer: h.db });
const identitySource = () => syntheticIdentitySource("memory") as Source;

async function setRelease(active: boolean) {
  await h.db.query(
    `UPDATE snapshot SET validation_state=$1 WHERE snapshot_id='rx'`,
    [active ? "ACTIVE" : "QUARANTINED"],
  );
}

/** One request: the identity stage inside drugCoverage, then the coverage pass-through. */
async function request(
  sources: Source[],
  rxcui: string,
  options: {
    coverage?: Coverage;
    create?: Create;
    scope?: PassThroughScope;
  } = {},
) {
  const api = (options.create ?? createPassThrough)(deps(sources));
  const scope = options.scope ?? requestScope();
  const local = await (options.coverage ?? drugCoverage)(
    h.db,
    plan,
    rxcui,
    2026,
    {
      api,
      scope,
    },
  );
  const [served] = await api.apply("drug", [local], scope);
  return { local, served: served!, api, scope };
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0]!.base_plan_id as string;
  scratch = await mkdtemp(join(tmpdir(), "openplans-identity-stage-"));
  manifestPath = join(scratch, "access.json");
  const manifest: AdmissionManifest = {
    version: 1,
    publishers: [
      publisher(IDENTITY_HOST, IDENTITY_PATH),
      publisher(COVERAGE_HOST, "/answers"),
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
}, 120_000);
afterAll(async () => {
  await h?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  identityCalls = [];
  coverageCalls = [];
  identityStatus = 200;
  await setRelease(false);
});

describe("SDK identity kind", () => {
  it("has its own closed opening reasons, disjoint from the coverage list", () => {
    expect(IDENTITY_OPENING_REASONS[DRUG_IDENTITY_KIND]).toEqual([
      "rxcui_not_in_rxnorm",
      "rxnorm_terminology_unavailable",
    ]);
    for (const reason of IDENTITY_OPENING_REASONS[DRUG_IDENTITY_KIND]!)
      expect(PASSTHROUGH_OPENING_REASONS).not.toContain(reason);
  });

  it("an identity reason never opens a coverage call, nor a coverage reason an identity call", async () => {
    const api = createPassThrough(deps([identitySource(), coverageSource()]));
    const drug = {
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
      requested_plan_id: plan,
      rxcui: ACTIVE,
      plan_year: 2026,
    };
    const identity = {
      status: "unknown",
      reason: "source_set_not_available",
      identity: ACTIVE,
      plan_year: 2026,
    };
    expect(await api.apply("drug", [drug], requestScope())).toEqual([drug]);
    expect(
      await api.apply(DRUG_IDENTITY_KIND, [identity], requestScope()),
    ).toEqual([identity]);
    expect(identityCalls).toEqual([]);
    expect(coverageCalls).toEqual([]);
  });
});

describe("identity stage in drugCoverage", () => {
  it("confirms an RxCUI without a release and lets the coverage source accept it for this request", async () => {
    const { local, served } = await request(
      [identitySource(), coverageSource()],
      ACTIVE,
    );
    expect(identityCalls).toHaveLength(1);
    // Past the identity gate: the plan is found and the issuer files are not loaded.
    expect(local).toMatchObject({
      status: "unknown",
      reason: "source_set_not_available",
    });
    expect(coverageCalls).toHaveLength(1);
    expect(served).toMatchObject({
      status: "explicitly_not_covered",
      reason: null,
    });
  });

  it("a confirmation from another request does not confirm a negative", async () => {
    const api = createPassThrough(deps([identitySource(), coverageSource()]));
    const confirming = requestScope();
    const local = await drugCoverage(h.db, plan, ACTIVE, 2026, {
      api,
      scope: confirming,
    });
    const [served] = await api.apply("drug", [local], requestScope());
    expect(coverageCalls).toHaveLength(1);
    // Missing identity evidence keeps the negative unknown, never "not covered".
    expect(served).toMatchObject({
      status: "unknown",
      reason: "passthrough_negative_unconfirmed",
    });
  });

  it("an RxCUI the identity source does not confirm stays rxcui_not_in_rxnorm and opens no coverage call", async () => {
    const { local, served } = await request(
      [identitySource(), coverageSource()],
      ABSENT,
    );
    expect(identityCalls).toHaveLength(1);
    expect(local).toMatchObject({
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
    });
    expect(served).toBe(local);
    expect(coverageCalls).toEqual([]);
  });

  it("an identity source that cannot answer leaves rxnorm_terminology_unavailable", async () => {
    identityStatus = 503;
    const { local } = await request(
      [identitySource(), coverageSource()],
      ACTIVE,
    );
    expect(identityCalls.length).toBeGreaterThan(0);
    expect(local).toMatchObject({
      status: "unknown",
      reason: "rxnorm_terminology_unavailable",
    });
    expect(coverageCalls).toEqual([]);
  });

  it("without an identity source, or without the stage, the answer is what it was", async () => {
    const without = await drugCoverage(h.db, plan, ACTIVE, 2026);
    const { local } = await request([coverageSource()], ACTIVE);
    expect(local).toEqual(without);
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
    expect(coverageCalls).toEqual([]);
  });

  it("a loaded release always wins: the identity source is not asked", async () => {
    await setRelease(true);
    const { local } = await request(
      [identitySource(), coverageSource()],
      ACTIVE,
    );
    expect(identityCalls).toEqual([]);
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
    expect(coverageCalls).toEqual([]);
  });

  it("a stored identity source is never asked and confirms nothing", async () => {
    const { local } = await request(
      [storedIdentitySource(), coverageSource()],
      ACTIVE,
    );
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
    expect(coverageCalls).toEqual([]);
  });

  it("a source that mixes identity and coverage kinds is not asked for identity", async () => {
    const mixed = syntheticIdentitySource("memory", {
      kinds: [DRUG_IDENTITY_KIND, "drug"],
    }) as Source;
    const { local } = await request([mixed], ACTIVE);
    expect(identityCalls).toEqual([]);
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
  });

  it("an identity answer is built by the core, so a source cannot fold its way to confirmed", async () => {
    const lying = syntheticIdentitySource("memory", {
      mapResponse: (_body: unknown, questions: Question[]) =>
        questions.map((question) => ({
          question,
          outcome: "answer",
          answer: { status: "confirmed", confirmed: false },
          statement: "Says confirmed",
        })),
      serve: (_kind: string, answer: object) => ({
        ...answer,
        status: "confirmed",
        reason: null,
      }),
    }) as Source;
    const { local } = await request([lying, coverageSource()], ACTIVE);
    expect(identityCalls).toHaveLength(1);
    expect(local.reason).toBe("rxcui_not_in_rxnorm");
    expect(coverageCalls).toEqual([]);
  });
});

describe("planted mutants", () => {
  it("kills: an identity accepted from a stored source", async () => {
    const mutant = await plantMutant(
      passthroughFile,
      `if (identity && levelUsed === "stored") return answers;`,
      `if (identity && levelUsed === "stored" && false) return answers;`,
    );
    try {
      const module = (await import(/* @vite-ignore */ mutant.path)) as {
        createPassThrough: Create;
      };
      const { local, served } = await request(
        [storedIdentitySource(), coverageSource()],
        ACTIVE,
        { create: module.createPassThrough },
      );
      // The real guard keeps rxcui_not_in_rxnorm and no coverage call.
      expect(() => {
        expect(local.reason).toBe("rxcui_not_in_rxnorm");
        expect(served.status).toBe("unknown");
      }).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: the identity source asked while a release is ACTIVE", async () => {
    await setRelease(true);
    const mutant = await plantMutant(
      repositoryFile,
      `if (!identity || (await rxnorm.activeRelease()))`,
      `if (!identity)`,
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RepositoryModule;
      await request([identitySource(), coverageSource()], ACTIVE, {
        coverage: module.drugCoverage,
      });
      expect(() => expect(identityCalls).toEqual([])).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("kills: an unconfirmed RxCUI opening a coverage call", async () => {
    const mutant = await plantMutant(
      repositoryFile,
      `if (verdict !== "confirmed") return { ...result, reason: verdict };`,
      `if (verdict === "rxnorm_terminology_unavailable") return { ...result, reason: verdict };`,
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof RepositoryModule;
      await request([identitySource(), coverageSource()], ABSENT, {
        coverage: module.drugCoverage,
      });
      expect(() => expect(coverageCalls).toEqual([])).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});
