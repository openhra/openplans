// Operator policy changes for pass-through sources (design 5.10.4): tightening `stored` expires
// absorbed rows and stops writes, loosening is refused, a TTL change recomputes `expired_at`.
// Synthetic source, answers and host on PGlite; an injected transport; no network.
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type {
  CacheLevel,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { AdmissionSession } from "../../src/fetch/index.js";
import { currentRegistries, loadPlugins } from "../../src/plugins/index.js";
import {
  activateRegistries,
  emptyRegistries,
  freezeRegistries,
} from "../../src/plugins/registries.js";
import {
  PassThroughPolicyRefusal,
  applyPassThroughPolicies,
  createPassThrough,
  operatorLevels,
  operatorSourcePolicies,
} from "../../src/plugins/sources/passthrough.js";
import type {
  OperatorSourcePolicy,
  PassThroughDeps,
} from "../../src/plugins/sources/passthrough.js";
import { syntheticSource } from "../fixtures/plugins/synthetic-passthrough/index.mjs";
import {
  syntheticTransport,
  writeManifest,
} from "../fixtures/plugins/synthetic-passthrough/harness.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

type Source = PassThroughSource<Question, unknown>;
const PLAN = "12345TX0010001";
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);

let pg: PGlite;
let db: Database;
let scratch: string;
let manifestPath: string;
let cleanupMigrations: () => Promise<void>;
let calls: URL[];
let lines: string[];
let sql: string[];

const stored = () => syntheticSource("stored") as unknown as Source;
const output = {
  out: (line: string) => lines.push(line),
  error: (line: string) => lines.push(`error: ${line}`),
};
/** The database with every statement text recorded, to see the batches. */
const recorded = () =>
  new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "query") return value;
      return (text: string, ...rest: unknown[]) => {
        sql.push(text);
        return (value as (...args: unknown[]) => unknown).call(
          target,
          text,
          ...rest,
        );
      };
    },
  }) as Database;
function deps(
  sources: Source[],
  extra: Partial<PassThroughDeps> = {},
): PassThroughDeps {
  return {
    sources: () => sources,
    fetchOptions: {
      transport: syntheticTransport(calls),
      dataDir: scratch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    },
    admission: () =>
      new AdmissionSession([manifestPath], {
        maxRequests: 100,
        maxTransferBytes: 1024 ** 2,
      }),
    ...extra,
  };
}
const local = (code: string) => ({
  status: "unknown",
  reason: "source_set_not_available",
  plan_id: PLAN,
  code,
  plan_year: 2026,
});
const scope = () => ({ reader: db, writer: db });
async function absorb(codes: string[]) {
  return createPassThrough(deps([stored()])).apply(
    "drug",
    codes.map(local),
    scope(),
  );
}
const rows = async () =>
  (
    await db.query<{
      identity: string;
      record_policy: string;
      ttl: string;
      live: boolean;
      deadline: boolean;
    }>(
      `SELECT identity,record_policy,record_ttl::text AS ttl,
        (expired_at IS NULL OR expired_at>now()) AS live,
        (expired_at=sourced_at+record_ttl) AS deadline
      FROM passthrough_answer ORDER BY identity`,
    )
  ).rows;
const policy = async (name: string) =>
  (
    await db.query<{ ttl: string | null; stale: string }>(
      "SELECT default_ttl::text AS ttl, stale_window::text AS stale FROM record_policy WHERE name=$1",
      [name],
    )
  ).rows[0];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-policy-"));
  manifestPath = await writeManifest(scratch);
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
  calls = [];
  lines = [];
  sql = [];
  await db.exec(`
    DELETE FROM passthrough_conflict; DELETE FROM passthrough_answer; DELETE FROM passthrough_attempt;
    DELETE FROM passthrough_budget; DELETE FROM snapshot WHERE source_id LIKE 'synthetic-%';
    UPDATE record_policy SET default_ttl=CASE name WHEN 'synthetic_answer' THEN interval '7 days'
      ELSE interval '1 day' END, stale_window=CASE name WHEN 'synthetic_answer' THEN interval '30 days'
      ELSE interval '0' END WHERE name IN ('synthetic_answer','synthetic_no_data');`);
  await rm(join(scratch, "raw"), { recursive: true, force: true });
});
afterEach(() => {
  activateRegistries(freezeRegistries(emptyRegistries()));
});

describe("tightening `stored` to `memory`", () => {
  it("expires every absorbed row through record-policy expire and stops writes", async () => {
    await absorb(["100", "200"]);
    expect(await rows()).toEqual([
      expect.objectContaining({ identity: "100", live: true }),
      expect.objectContaining({ identity: "200", live: true }),
    ]);
    const policies = { "synthetic-stored": { cacheLevel: "memory" as const } };

    const ran = await applyPassThroughPolicies(
      recorded(),
      [stored()],
      policies,
      output,
    );
    expect(ran).toEqual([
      ["expire", "synthetic_answer"],
      ["expire", "synthetic_no_data"],
    ]);
    // The record-policy command's own output and batched statements.
    expect(lines).toEqual([
      JSON.stringify({
        policy: "synthetic_answer",
        command: "expire",
        rows: 1,
      }),
      JSON.stringify({
        policy: "synthetic_no_data",
        command: "expire",
        rows: 1,
      }),
    ]);
    expect(
      sql.filter((text) =>
        /UPDATE "passthrough_answer" SET expired_at=now\(\)/.test(text),
      ),
    ).toEqual([
      expect.stringContaining("ctid >= $2::tid AND ctid < $3::tid"),
      expect.stringContaining("ctid >= $2::tid AND ctid < $3::tid"),
    ]);
    // Expired, not deleted (expand/contract).
    expect((await rows()).map((row) => [row.identity, row.live])).toEqual([
      ["100", false],
      ["200", false],
    ]);

    // At the operator's level the core keeps answers in memory and writes no row.
    const before = Number(
      (
        await db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM snapshot WHERE source_id='synthetic-stored'",
        )
      ).rows[0]!.n,
    );
    const memory = new MemoryCache(1024 * 1024);
    const core = createPassThrough(
      deps([stored()], {
        cacheStore: memory,
        operatorLevels: operatorLevels([stored()], policies),
      }),
    );
    const [answer] = await core.apply("drug", [local("100")], scope());
    expect(answer).toMatchObject({
      status: "listed_covered",
      synthetic_passthrough: { level: "memory", served_from: "live" },
    });
    expect(calls).toHaveLength(2);
    expect((await rows()).map((row) => [row.identity, row.live])).toEqual([
      ["100", false],
      ["200", false],
    ]);
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM snapshot WHERE source_id='synthetic-stored'",
          )
        ).rows[0]!.n,
      ),
    ).toBe(before);
    expect(memory.keys()).toEqual([
      `openplans:passthrough:v1:synthetic-stored:drug:${PLAN}|100|2026`,
    ]);

    // A second worker start finds nothing live and runs nothing.
    lines = [];
    expect(
      await applyPassThroughPolicies(db, [stored()], policies, output),
    ).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("negative control: without the operator setting the rows stay live", async () => {
    await absorb(["100"]);
    expect(await applyPassThroughPolicies(db, [stored()], {}, output)).toEqual(
      [],
    );
    expect(
      await applyPassThroughPolicies(
        db,
        [stored()],
        { "synthetic-stored": { cacheLevel: "stored" } },
        output,
      ),
    ).toEqual([]);
    expect((await rows()).map((row) => row.live)).toEqual([true]);
  });
});

describe("loosening a declared level", () => {
  it.each([
    ["none", "request"],
    ["none", "stored"],
    ["request", "memory"],
    ["memory", "stored"],
  ] as [CacheLevel, CacheLevel][])(
    "declared %s, operator %s: refused",
    async (declared, wanted) => {
      const source = syntheticSource(declared) as unknown as Source;
      const policies = { [source.id]: { cacheLevel: wanted } };
      let refusal: unknown;
      try {
        operatorLevels([source], policies);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(PassThroughPolicyRefusal);
      expect(refusal).toMatchObject({
        code: "passthrough_level_loosened",
        sourceId: source.id,
      });
      await expect(
        applyPassThroughPolicies(db, [source], policies, output),
      ).rejects.toBeInstanceOf(PassThroughPolicyRefusal);
      expect(lines).toEqual([]);
    },
  );

  it("accepts the declared level and anything stricter", () => {
    const source = syntheticSource("memory") as unknown as Source;
    for (const level of ["none", "request", "memory"] as const)
      expect(
        operatorLevels([source], { [source.id]: { cacheLevel: level } }),
      ).toEqual({ [source.id]: level });
    expect(operatorLevels([source], {})).toEqual({});
  });

  it("reads the setting from the config file and refuses it for the loaded plugin", async () => {
    const config = loadConfig(
      {},
      {
        version: 1,
        plugins: [
          {
            package: "./synthetic-passthrough/index.mjs",
            options: { level: "none" },
            sources: { "synthetic-none": { cacheLevel: "memory" } },
          },
        ],
      },
    );
    // The loader reads the setting and refuses the load; nothing is activated.
    await expect(
      loadPlugins(config, "api", {
        env: {},
        baseDirectory: fixtures,
        manifestPaths: [manifestPath],
        writeLog: (line) => lines.push(line),
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      }),
    ).rejects.toThrow("exit 1");
    expect(lines).toEqual([
      JSON.stringify({
        plugin: "@synthetic/passthrough",
        code: "passthrough_level_loosened",
        reason: "synthetic-none",
      }),
    ]);
    expect(currentRegistries().sources).toEqual([]);
    const sources = [syntheticSource("none") as unknown as Source];
    const policies = operatorSourcePolicies(config);
    expect(policies).toEqual({ "synthetic-none": { cacheLevel: "memory" } });
    expect(() => operatorLevels(sources, policies)).toThrow(
      "passthrough_level_loosened: synthetic-none",
    );
  });
});

describe("TTL change for a `stored` source", () => {
  it("recomputes expired_at in batches through record-policy set", async () => {
    await absorb(["100", "200"]);
    const policies: Record<string, OperatorSourcePolicy> = {
      "synthetic-stored": { ttl: "2 days", negativeTtl: "3 hours" },
    };
    const ran = await applyPassThroughPolicies(
      recorded(),
      [stored()],
      policies,
      output,
    );
    expect(ran).toEqual([
      ["set", "synthetic_answer", "--ttl", "2 days"],
      ["set", "synthetic_no_data", "--ttl", "3 hours"],
    ]);
    expect(lines).toEqual([
      JSON.stringify({ policy: "synthetic_answer", command: "set", rows: 1 }),
      JSON.stringify({ policy: "synthetic_no_data", command: "set", rows: 1 }),
    ]);
    expect(
      sql.filter((text) =>
        /UPDATE "passthrough_answer" SET record_ttl=/.test(text),
      ),
    ).toEqual([
      expect.stringContaining("ctid >= $2::tid AND ctid < $3::tid"),
      expect.stringContaining("ctid >= $2::tid AND ctid < $3::tid"),
    ]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        identity: "100",
        record_policy: "synthetic_answer",
        ttl: "2 days",
        deadline: true,
        live: true,
      }),
      expect.objectContaining({
        identity: "200",
        record_policy: "synthetic_no_data",
        ttl: "03:00:00",
        deadline: true,
        live: true,
      }),
    ]);
    expect(await policy("synthetic_answer")).toEqual({
      ttl: "2 days",
      stale: "30 days",
    });
    expect(await policy("synthetic_no_data")).toEqual({
      ttl: "03:00:00",
      stale: "00:00:00",
    });

    // Unchanged settings at the next start run nothing.
    lines = [];
    expect(
      await applyPassThroughPolicies(db, [stored()], policies, output),
    ).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("a stale window alone keeps the TTL and changes the window", async () => {
    await absorb(["100"]);
    expect(
      await applyPassThroughPolicies(
        db,
        [stored()],
        { "synthetic-stored": { staleWindow: "5 days" } },
        output,
      ),
    ).toEqual([
      ["set", "synthetic_answer", "--ttl", "7 days", "--stale", "5 days"],
    ]);
    expect(await policy("synthetic_answer")).toEqual({
      ttl: "7 days",
      stale: "5 days",
    });
    expect(await rows()).toEqual([
      expect.objectContaining({ ttl: "7 days", deadline: true, live: true }),
    ]);
  });

  it("leaves sources below `stored` and sources without record policies alone", async () => {
    for (const level of ["none", "request", "memory"] as const)
      expect(
        await applyPassThroughPolicies(
          db,
          [syntheticSource(level) as unknown as Source],
          { [`synthetic-${level}`]: { ttl: "1 day" } },
          output,
        ),
      ).toEqual([]);
    expect(lines).toEqual([]);
    expect(await policy("synthetic_answer")).toEqual({
      ttl: "7 days",
      stale: "30 days",
    });
  });
});
