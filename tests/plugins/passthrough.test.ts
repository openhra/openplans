// Pass-through core with a synthetic source on PGlite. Synthetic answers, injected transport,
// no network.
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import { PASSTHROUGH_OPENING_REASONS } from "@openplans/plugin-sdk";
import type {
  CacheLevel,
  PassThroughApi,
  PassThroughScope,
  PassThroughSource,
  PluginManifest,
  Question,
} from "@openplans/plugin-sdk";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { AdmissionSession } from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import {
  activateRegistries,
  emptyRegistries,
  emptySeen,
  freezeRegistries,
  stagingRegistrar,
} from "../../src/plugins/registries.js";
import {
  runWithScope,
  scopeCacheLevel,
  scopeRequestAnswers,
} from "../../src/plugins/request-scope.js";
import {
  configurePassThrough,
  createPassThrough,
  intervalSeconds,
  strictestLevel,
} from "../../src/plugins/sources/passthrough.js";
import type { PassThroughDeps } from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const HOST = "answers.synthetic.test";
const PLAN = "12345TX0010001";
const terms = "Synthetic publisher permits request-time answers.";
const robots = "User-agent: *\nDisallow: /private\n";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const passthroughFile = new URL(
  "../../src/plugins/sources/passthrough.ts",
  import.meta.url,
);

interface LocalAnswer {
  status: string;
  reason: string | null;
  plan_id: string;
  code: string;
  plan_year: number;
  covered?: boolean;
  passthrough?: Record<string, unknown>;
}
interface SourceAnswer {
  status: string;
  covered: boolean;
}
type Synthetic = PassThroughSource<Question, SourceAnswer>;
type Create = (deps: PassThroughDeps) => PassThroughApi;

let pg: PGlite;
let db: Database;
let scratch: string;
let manifestPath: string;
let cleanupMigrations: () => Promise<void>;
let requests: URL[];
let status: number;
let known: Set<string>;
let events: { type: string; idempotencyKey: string; payload: unknown }[];

function publisher(): PublisherPolicy {
  return {
    host: HOST,
    state: "allowed",
    evidence: [
      {
        url: `https://${HOST}/terms`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${HOST}/answers`],
    permittedPaths: ["/answers"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${HOST}/robots.txt`,
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${HOST}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}

/** Code 1xx: covered; 2xx: no data; 3xx: a negative; 4xx: a negative the source cannot place. */
function answerFor(plan: string, code: string) {
  const question = { planId: plan, identity: code, year: 2026 };
  if (code.startsWith("2"))
    return { question, outcome: "no_data", statement: "DataNotProvided" };
  if (code.startsWith("3"))
    return {
      question,
      outcome: "answer",
      answer: { status: "explicitly_not_covered", covered: false },
      negative: true,
      statement: "NotCovered",
    };
  if (code.startsWith("4"))
    return {
      question,
      outcome: "negative_unconfirmed",
      statement: "NotCovered",
    };
  return {
    question,
    outcome: "answer",
    answer: { status: "listed_covered", covered: true },
    statement: "Covered",
  };
}
const transport: Transport = async (url) => {
  let body = "";
  let code = 200;
  if (url.pathname === "/robots.txt") body = robots;
  else if (url.pathname === "/terms") body = terms;
  else {
    requests.push(new URL(url.href));
    code = status;
    const pairs = (url.searchParams.get("q") ?? "").split(",");
    body = JSON.stringify({
      answers: pairs.map((pair) => {
        const [plan, id] = pair.split(":");
        return answerFor(plan!, id!);
      }),
    });
  }
  return { status: code, headers: {}, body: Readable.from([body]) };
};

function synthetic(
  level: CacheLevel,
  overrides: Partial<Synthetic> = {},
): Synthetic {
  return {
    kind: "passthrough",
    id: `synthetic-${level}`,
    publisher: "Synthetic publisher",
    kinds: ["drug"],
    manifest: {
      host: HOST,
      accessMode: "public",
      permittedPaths: ["/answers"],
    },
    cache: {
      level,
      ttl: "10 minutes",
      negativeTtl: "1 minute",
      ...(level === "stored"
        ? {
            recordPolicy: {
              name: "synthetic_answer",
              noDataName: "synthetic_no_data",
            },
          }
        : {}),
    },
    eligibility: {
      openingReasons: PASSTHROUGH_OPENING_REASONS,
      years: [2026],
      accepts: (q) => /^\d{3}$/.test(q.identity),
    },
    question: (_kind, answer) => {
      const a = answer as unknown as LocalAnswer;
      return { planId: a.plan_id, identity: a.code, year: a.plan_year };
    },
    confirmIdentities: async (_db, _kind, ids) =>
      new Set(ids.filter((id) => known.has(id))),
    batch: { maxQuestionsPerCall: 10, maxCallsPerRequest: 2 },
    budget: {
      dailyMax: 50,
      minIntervalMs: 0,
      clientShare: 1,
      breaker: { failures: 2, windowMs: 300_000, pauseMs: 900_000 },
    },
    buildRequest: (questions) => ({
      path: "/answers",
      query: {
        year: String(questions[0]!.year),
        q: questions.map((q) => `${q.planId}:${q.identity}`).join(","),
      },
    }),
    mapResponse: (body) =>
      (body as { answers: never[] }).answers as ReturnType<
        Synthetic["mapResponse"]
      >,
    evidence: {
      source: "Synthetic publisher",
      termsUrl: `https://${HOST}/terms`,
    },
    ...overrides,
  };
}

function local(code: string, overrides: Partial<LocalAnswer> = {}) {
  return {
    status: "unknown",
    reason: "source_set_not_available",
    plan_id: PLAN,
    code,
    plan_year: 2026,
    ...overrides,
  } as LocalAnswer;
}
function deps(
  sources: Synthetic[],
  extra: Partial<PassThroughDeps> = {},
): PassThroughDeps {
  return {
    sources: () => sources as never,
    events: {
      emit: async (event) => {
        events.push(event as (typeof events)[number]);
      },
    },
    fetchOptions: {
      transport,
      dataDir: scratch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    },
    // A fresh session per call: a failed call stops its session, as in production.
    admission: () =>
      new AdmissionSession([manifestPath], {
        maxRequests: 100,
        maxTransferBytes: 1024 ** 2,
      }),
    ...extra,
  };
}
const scope = (): PassThroughScope => ({ reader: db, writer: db });
const readOnly = (): PassThroughScope => ({ reader: db });
const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${sql}`,
        params,
      )
    ).rows[0]!.n,
  );
async function rawEntries(prefix: string): Promise<string[]> {
  try {
    return (await readdir(join(scratch, "raw"))).filter((n) =>
      n.startsWith(prefix),
    );
  } catch {
    return [];
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-passthrough-"));
  manifestPath = join(scratch, "access.json");
  const manifest: AdmissionManifest = { version: 1, publishers: [publisher()] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const core = await coreMigrations();
  cleanupMigrations = core.cleanup;
  pg = new PGlite();
  db = testDatabase(pg);
  await migrate(db, core.directory);
  await db.exec(`INSERT INTO record_policy(name,default_ttl,stale_window,description) VALUES
    ('synthetic_answer','7 days','30 days','Synthetic pass-through answers'),
    ('synthetic_no_data','1 day','0','Synthetic pass-through no-data answers')`);
}, 120_000);
afterAll(async () => {
  await pg?.close();
  await cleanupMigrations?.();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  requests = [];
  status = 200;
  known = new Set();
  events = [];
  await db.exec(`
    DELETE FROM passthrough_conflict; DELETE FROM passthrough_answer; DELETE FROM passthrough_attempt;
    DELETE FROM passthrough_budget;
    DELETE FROM snapshot WHERE source_id LIKE 'synthetic-%';`);
  await rm(join(scratch, "raw"), { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  activateRegistries(freezeRegistries(emptyRegistries()));
});

describe("pass-through core without sources", () => {
  it("returns the input array itself with no source or no scope", async () => {
    const answers = [local("100")];
    expect(
      await createPassThrough(deps([])).apply("drug", answers, scope()),
    ).toBe(answers);
    const core = createPassThrough(deps([synthetic("none")]));
    expect(await core.apply("drug", answers)).toBe(answers);
    expect(await core.apply("provider", answers, scope())).toBe(answers);
    expect(requests).toEqual([]);
    // Until a source stores an answer, the catalog generation is unchanged.
    expect(
      await count("api_data_generation WHERE table_name='passthrough_answer'"),
    ).toBe(0);
  });

  it("leaves settled and ineligible answers alone", async () => {
    const answers = [
      local("100", { status: "listed_covered", reason: null }),
      local("100", { reason: "not_in_formulary" }),
      local("1234"),
    ];
    const core = createPassThrough(deps([synthetic("none")]));
    expect(await core.apply("drug", answers, scope())).toBe(answers);
    expect(requests).toEqual([]);
  });

  it("orders levels strictest first and reads simple intervals", () => {
    expect(strictestLevel("stored", "memory")).toBe("memory");
    expect(strictestLevel("none", "stored")).toBe("none");
    expect(strictestLevel("request")).toBe("request");
    expect(intervalSeconds("10 minutes")).toBe(600);
    expect(intervalSeconds("1 day 2 hours")).toBe(93_600);
    expect(() => intervalSeconds("soon")).toThrow(TypeError);
  });
});

describe("stored level", () => {
  it("absorbs with the source's record policies and trigger-filled provenance", async () => {
    const core = createPassThrough(deps([synthetic("stored")]));
    const [covered, noData] = await runWithScope(async () => {
      const out = await core.apply(
        "drug",
        [local("100"), local("200")],
        scope(),
      );
      expect(scopeCacheLevel()).toBe("stored");
      return out;
    });
    expect(requests).toHaveLength(1);
    expect(covered).toMatchObject({
      status: "listed_covered",
      covered: true,
      reason: null,
      passthrough: {
        source_id: "synthetic-stored",
        level: "stored",
        outcome: "answer",
        served_from: "live",
        statement: "Covered",
        source: "Synthetic publisher",
      },
    });
    expect(noData).toMatchObject({
      status: "unknown",
      reason: "passthrough_data_not_provided",
      passthrough: { outcome: "no_data", statement: "DataNotProvided" },
    });
    const rows = (
      await db.query<Record<string, unknown>>(
        `SELECT identity,outcome,record_policy,sourced_by,sourced_slug,snapshot_id,
          (expired_at=sourced_at+record_ttl) AS deadline,record_ttl::text AS ttl
        FROM passthrough_answer ORDER BY identity`,
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        identity: "100",
        outcome: "answer",
        record_policy: "synthetic_answer",
        sourced_by: "synthetic-stored",
        deadline: true,
        ttl: "7 days",
      }),
      expect.objectContaining({
        identity: "200",
        outcome: "no_data",
        record_policy: "synthetic_no_data",
        sourced_by: "synthetic-stored",
        ttl: "1 day",
      }),
    ]);
    expect(rows[0]!.sourced_slug).toBe(rows[0]!.snapshot_id);
    expect((covered!.passthrough as { snapshot_id: string }).snapshot_id).toBe(
      rows[0]!.snapshot_id,
    );
    expect(await count("snapshot WHERE source_id='synthetic-stored'")).toBe(1);
    // The first stored answer registers the table in the catalog generation, and bumps it.
    expect(
      await count(
        "api_data_generation WHERE table_name='passthrough_answer' AND revision>0",
      ),
    ).toBe(1);
    // The attempt row holds counts, never identifiers.
    const attempts = (
      await db.query<Record<string, unknown>>(
        "SELECT source_id,kind,level,plan_year,pairs,receipt_id,outcome FROM passthrough_attempt",
      )
    ).rows;
    expect(attempts).toEqual([
      {
        source_id: "synthetic-stored",
        kind: "drug",
        level: "stored",
        plan_year: 2026,
        pairs: 2,
        receipt_id: rows[0]!.snapshot_id,
        outcome: "absorbed",
      },
    ]);
    expect(JSON.stringify(attempts)).not.toContain(PLAN);
    // Served from the stored row on the next request; no second call.
    const [again] = await core.apply("drug", [local("100")], scope());
    expect(again!.passthrough).toMatchObject({ served_from: "absorbed" });
    expect(requests).toHaveLength(1);
    // A read-only scope serves stored rows too.
    const [read] = await core.apply("drug", [local("100")], readOnly());
    expect(read).toMatchObject({ status: "listed_covered" });
  });

  it("records conflicts with loaded files and serves stale rows when no call is possible", async () => {
    const core = createPassThrough(deps([synthetic("stored")]));
    await core.apply("drug", [local("100")], scope());
    const settled = local("100", {
      status: "explicitly_not_covered",
      reason: null,
    });
    expect(await core.apply("drug", [settled], scope())).toEqual([settled]);
    expect(
      (
        await db.query(
          "SELECT source_outcome,local_status,agrees FROM passthrough_conflict",
        )
      ).rows,
    ).toEqual([
      {
        source_outcome: "answer",
        local_status: "explicitly_not_covered",
        agrees: false,
      },
    ]);
    await db.query(
      "UPDATE passthrough_answer SET expired_at=now()-interval '1 day'",
    );
    await db.query(
      "UPDATE passthrough_budget SET daily_requests=max_daily_requests",
    );
    const [stale] = await core.apply("drug", [local("100")], scope());
    expect(stale).toMatchObject({
      status: "listed_covered",
      passthrough: { served_from: "absorbed_stale" },
    });
    expect(requests).toHaveLength(1);
  });

  it("is tightened by the operator, never loosened", async () => {
    const core = createPassThrough(
      deps([synthetic("stored")], {
        operatorLevels: { "synthetic-stored": "none" },
      }),
    );
    await core.apply("drug", [local("100")], scope());
    expect(await count("passthrough_answer")).toBe(0);
    expect(await count("snapshot WHERE source_id='synthetic-stored'")).toBe(0);
    const loose = createPassThrough(
      deps([synthetic("none", { id: "synthetic-loose" })], {
        operatorLevels: { "synthetic-loose": "stored" },
      }),
    );
    await loose.apply("drug", [local("100")], scope());
    expect(await count("passthrough_answer")).toBe(0);
    expect(
      (
        await db.query(
          "SELECT level FROM passthrough_attempt ORDER BY attempt_id",
        )
      ).rows,
    ).toEqual([{ level: "none" }, { level: "none" }]);
  });
});

describe("memory level", () => {
  it("keeps answers in the cache store namespace with the TTL and nothing in the database", async () => {
    let now = Date.now();
    const store = new MemoryCache(1024 ** 2, () => now);
    const keys: string[] = [];
    const set = store.set.bind(store);
    store.set = async (key, value, ttl) => {
      keys.push(`${key} ${ttl}`);
      await set(key, value, ttl);
    };
    const core = createPassThrough(
      deps([synthetic("memory")], { cacheStore: store }),
    );
    const before = await dbState();
    await runWithScope(async () => {
      await core.apply("drug", [local("100"), local("200")], scope());
      expect(scopeCacheLevel()).toBe("memory");
    });
    expect(keys).toEqual([
      `openplans:passthrough:v1:synthetic-memory:drug:${PLAN}|100|2026 600`,
      `openplans:passthrough:v1:synthetic-memory:drug:${PLAN}|200|2026 60`,
    ]);
    // Only the attempt row reaches the database.
    expect(await dbState()).toEqual({
      ...before,
      attempts: before.attempts + 1,
    });
    expect(await rawEntries("synthetic-memory")).toEqual([]);
    const [hit] = await core.apply("drug", [local("100")], readOnly());
    expect(hit).toMatchObject({
      status: "listed_covered",
      passthrough: { served_from: "memory", snapshot_id: null },
    });
    expect(requests).toHaveLength(1);
    now += 601_000;
    const [expired] = await core.apply("drug", [local("100")], scope());
    expect(expired!.passthrough).toMatchObject({ served_from: "live" });
    expect(requests).toHaveLength(2);
  });
});

async function dbState() {
  return {
    answers: await count("passthrough_answer"),
    snapshots: await count("snapshot WHERE source_id LIKE 'synthetic-%'"),
    attempts: await count("passthrough_attempt"),
  };
}

describe("request level", () => {
  it("de-duplicates within one request and calls again on the next", async () => {
    const core = createPassThrough(deps([synthetic("request")]));
    await runWithScope(async () => {
      const [first] = await core.apply("drug", [local("100")], scope());
      const [second] = await core.apply("drug", [local("100")], scope());
      expect(first!.passthrough).toMatchObject({ served_from: "live" });
      expect(second!.passthrough).toMatchObject({ served_from: "request" });
      expect(scopeCacheLevel()).toBe("request");
    });
    expect(requests).toHaveLength(1);
    await runWithScope(() => core.apply("drug", [local("100")], scope()));
    expect(requests).toHaveLength(2);
    expect(await dbState()).toEqual({ answers: 0, snapshots: 0, attempts: 2 });
    expect(await rawEntries("synthetic-request")).toEqual([]);
  });
});

/** What a `none` source leaves behind after two identical requests in one scope. */
async function noneScenario(create: Create) {
  const store = new MemoryCache(1024 ** 2);
  const core = create(deps([synthetic("none")], { cacheStore: store }));
  let level: CacheLevel | null = null;
  let kept: string[] = [];
  await runWithScope(async () => {
    await core.apply("drug", [local("100"), local("150")], scope());
    await core.apply("drug", [local("100"), local("150")], scope());
    level = scopeCacheLevel();
    kept = [...(scopeRequestAnswers()?.keys() ?? [])];
  });
  return {
    calls: requests.length,
    level,
    kept,
    storeBytes: store.bytes(),
    db: await dbState(),
    attempts: (
      await db.query(
        "SELECT pairs,receipt_id IS NOT NULL AS hashed FROM passthrough_attempt",
      )
    ).rows,
    raw: await rawEntries("synthetic-none"),
  };
}
const noneExpected = {
  calls: 2,
  level: "none",
  kept: [],
  storeBytes: 0,
  db: { answers: 0, snapshots: 0, attempts: 2 },
  attempts: [
    { pairs: 2, hashed: true },
    { pairs: 2, hashed: true },
  ],
  raw: [],
};

describe("none level", () => {
  it("keeps nothing anywhere: every question calls, only attempt rows are written", async () => {
    expect(await noneScenario(createPassThrough)).toEqual(noneExpected);
  });

  it("answers read-only scopes with a reason and makes no call", async () => {
    const core = createPassThrough(deps([synthetic("none")]));
    const [out] = await core.apply("drug", [local("100")], readOnly());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "passthrough_not_available_read_only",
    });
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "the request map also keeps none answers",
      `if (levelUsed === "request") {
      const answers = scopeRequestAnswers();`,
      `if (levelUsed === "request" || levelUsed === "none") {
      const answers = scopeRequestAnswers();`,
    ],
    [
      "none answers go through the stored path",
      `const persistent = levelUsed === "stored";`,
      `const persistent = levelUsed === "stored" || levelUsed === "none";`,
    ],
    [
      "served answers restrict the scope to stored",
      `restrictCacheLevel(levelUsed, ttl);`,
      `restrictCacheLevel("stored", ttl);`,
    ],
  ])("catches a planted mutant: %s", async (_name, before, after) => {
    const mutant = await plantMutant(passthroughFile, before, after);
    try {
      const module = (await import(mutant.path)) as {
        createPassThrough: Create;
      };
      expect(await noneScenario(module.createPassThrough)).not.toEqual(
        noneExpected,
      );
    } finally {
      await mutant.cleanup();
    }
  });
});

/** Budget of one call a day: the second request is refused and the event fires once. */
async function budgetScenario(create: Create) {
  const core = create(
    deps([
      synthetic("none", {
        budget: { ...synthetic("none").budget, dailyMax: 1 },
      }),
    ]),
  );
  const reasons: (string | null)[] = [];
  for (let i = 0; i < 3; i++)
    reasons.push(
      (await core.apply("drug", [local("100")], scope()))[0]!.reason,
    );
  return {
    calls: requests.length,
    reasons,
    events: events.map((e) => [e.type, e.payload]),
  };
}
const budgetExpected = {
  calls: 1,
  reasons: [
    null,
    "passthrough_budget_exhausted",
    "passthrough_budget_exhausted",
  ],
  events: [
    [
      "passthrough.budget_exhausted",
      { sourceId: "synthetic-none", dailyMax: 1 },
    ],
  ],
};

describe("budget, breaker and caps", () => {
  it("yields unknown with the reason on exhaustion and emits the event once", async () => {
    expect(await budgetScenario(createPassThrough)).toEqual(budgetExpected);
    expect(
      (
        await db.query(
          "SELECT outcome,refusal_reason FROM passthrough_attempt ORDER BY attempt_id",
        )
      ).rows,
    ).toEqual([
      { outcome: "answered", refusal_reason: null },
      { outcome: "refused", refusal_reason: "passthrough_budget_exhausted" },
      { outcome: "refused", refusal_reason: "passthrough_budget_exhausted" },
    ]);
  });

  it("catches a planted mutant: the reservation without the daily cap", async () => {
    const mutant = await plantMutant(
      passthroughFile,
      `const DAILY_CAP =
  "AND (day_start<(now() AT TIME ZONE 'UTC')::date OR daily_requests<max_daily_requests)";`,
      `const DAILY_CAP = "";`,
    );
    try {
      const module = (await import(mutant.path)) as {
        createPassThrough: Create;
      };
      expect(await budgetScenario(module.createPassThrough)).not.toEqual(
        budgetExpected,
      );
    } finally {
      await mutant.cleanup();
    }
  });

  it("opens the breaker after the configured failures and emits the event", async () => {
    status = 503;
    const core = createPassThrough(deps([synthetic("none")]));
    for (let i = 0; i < 2; i++)
      expect(
        (await core.apply("drug", [local("100")], scope()))[0],
      ).toMatchObject({
        status: "unknown",
        reason: "passthrough_unavailable",
      });
    expect(requests).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["passthrough.breaker_open"]);
    const [blocked] = await core.apply("drug", [local("100")], scope());
    expect(blocked!.reason).toBe("passthrough_unavailable");
    expect(requests).toHaveLength(2);
    const row = (
      await db.query<{ half_open: boolean; paused: boolean }>(
        "SELECT half_open,blocked_until>now()+interval '14 minutes' AS paused FROM passthrough_budget",
      )
    ).rows[0];
    expect(row).toEqual({ half_open: true, paused: true });
    // A trial call that succeeds closes the breaker.
    status = 200;
    await db.query(
      "UPDATE passthrough_budget SET blocked_until=now()-interval '1 second'",
    );
    expect((await core.apply("drug", [local("100")], scope()))[0]!.status).toBe(
      "listed_covered",
    );
    expect(
      (await db.query("SELECT half_open,failure_count FROM passthrough_budget"))
        .rows,
    ).toEqual([{ half_open: false, failure_count: 0 }]);
  });

  it("caps calls per request, per client share, by year and by key", async () => {
    const core = createPassThrough(
      deps([
        synthetic("none", {
          batch: { maxQuestionsPerCall: 1, maxCallsPerRequest: 2 },
        }),
      ]),
    );
    const out = await core.apply(
      "drug",
      [
        local("100"),
        local("110"),
        local("120"),
        local("130", { plan_year: 2025 }),
      ],
      scope(),
    );
    expect(out.map((a) => a.reason)).toEqual([
      null,
      null,
      "passthrough_request_cap",
      "passthrough_year_not_served",
    ]);
    expect(requests).toHaveLength(2);

    const shared = createPassThrough(
      deps([
        synthetic("none", {
          id: "synthetic-share",
          budget: {
            ...synthetic("none").budget,
            dailyMax: 10,
            clientShare: 0.1,
          },
        }),
      ]),
    );
    const client = { ...scope(), client: "203.0.113.7" };
    expect(
      (await shared.apply("drug", [local("100")], client))[0]!.reason,
    ).toBeNull();
    expect(
      (
        await shared.apply("drug", [local("100")], {
          ...scope(),
          client: "203.0.113.7",
        })
      )[0]!.reason,
    ).toBe("passthrough_request_cap");

    const keyed = createPassThrough(
      deps([
        synthetic("none", {
          manifest: {
            host: HOST,
            accessMode: "api-key",
            apiKeyEnv: "SYNTHETIC_PASSTHROUGH_KEY",
            permittedPaths: ["/answers"],
          },
        }),
      ]),
    );
    vi.stubEnv("SYNTHETIC_PASSTHROUGH_KEY", "");
    expect(
      (await keyed.apply("drug", [local("100")], scope()))[0]!.reason,
    ).toBe("passthrough_not_configured");
    expect(requests).toHaveLength(3);
  });

  it("makes no call at stored level without record policies to store under", async () => {
    const core = createPassThrough(
      deps([synthetic("stored", { cache: { level: "stored" } })]),
    );
    const [out] = await core.apply("drug", [local("100")], scope());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "passthrough_not_configured",
    });
    expect(requests).toEqual([]);
  });

  it("never fails the answers when storage breaks", async () => {
    const core = createPassThrough(
      deps([
        synthetic("stored", {
          cache: { level: "stored", recordPolicy: { name: "missing_policy" } },
        }),
      ]),
    );
    const [out] = await core.apply("drug", [local("100")], scope());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "passthrough_unavailable",
    });
  });
});

/** An unconfirmed negative and a negative the source cannot place both stay unknown. */
async function negativeScenario(create: Create) {
  const core = create(deps([synthetic("none")]));
  return core.apply(
    "drug",
    [local("300"), local("400"), local("310")],
    scope(),
  );
}

describe("unconfirmed negatives", () => {
  it("stay unknown with the source's statement in provenance", async () => {
    known = new Set(["310"]);
    const [unconfirmed, unplaced, confirmed] =
      await negativeScenario(createPassThrough);
    for (const answer of [unconfirmed, unplaced])
      expect(answer).toMatchObject({
        status: "unknown",
        reason: "passthrough_negative_unconfirmed",
        passthrough: {
          outcome: "negative_unconfirmed",
          statement: "NotCovered",
        },
      });
    expect(confirmed).toMatchObject({
      status: "explicitly_not_covered",
      covered: false,
      reason: null,
      passthrough: { outcome: "answer", statement: "NotCovered" },
    });
  });

  it("catches a planted mutant: the negative branch returns the negative answer", async () => {
    const mutant = await plantMutant(
      passthroughFile,
      "if (negativeUnconfirmed)",
      'if (result.outcome === "negative_unconfirmed")',
    );
    try {
      const module = (await import(mutant.path)) as {
        createPassThrough: Create;
      };
      const [unconfirmed] = await negativeScenario(module.createPassThrough);
      expect(unconfirmed!.status).toBe("explicitly_not_covered");
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("ctx.sources.passThrough", () => {
  it("applies the sources a plugin registered", async () => {
    const manifest: PluginManifest = {
      name: "@synthetic/passthrough",
      version: "0.1.0",
      apiVersion: "0.1",
      kinds: ["sources"],
    };
    const staging = emptyRegistries();
    const registrar = stagingRegistrar(staging, manifest, "api", emptySeen());
    registrar.context.sources.add(synthetic("request"));
    registrar.close();
    activateRegistries(freezeRegistries(staging));
    const { sources: _sources, ...rest } = deps([]);
    configurePassThrough(rest);
    try {
      const [out] = await registrar.context.sources.passThrough.apply(
        "drug",
        [local("100")],
        scope(),
      );
      expect(out).toMatchObject({ status: "listed_covered" });
      expect(requests).toHaveLength(1);
    } finally {
      configurePassThrough({});
    }
  });
});
