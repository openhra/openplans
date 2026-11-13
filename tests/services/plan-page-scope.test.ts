import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlSession } from "../../src/db/database.js";
import { requestScope } from "../../src/db/scope.js";
import { SHARED_PLAN_LOOKUPS } from "../../src/api/repository.js";
import { searchPlans } from "../../src/services/catalog.js";
import type * as CatalogModule from "../../src/services/catalog.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "../api/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { importMutant, withMutantFile } from "../mutant-file.js";

// Real regenerable CMS/Census cuts.
const db = testDatabase(new PGlite());
let dir: string, core: Awaited<ReturnType<typeof coreMigrations>>;
const params = { zip: "77002", year: "2026" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "openplans-plan-page-scope-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files: await fixtureFiles(dir),
        dataDir: dir,
      })
    ).status,
  ).toBe("ACTIVE");
  await ingestRatingRules(db);
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** Counts every statement and the most that ran at the same time. */
function counted(inner: SqlSession) {
  const seen = { total: 0, shared: 0, inFlight: 0, peak: 0 };
  const session: SqlSession = {
    async query(sql, parameters) {
      seen.total++;
      if (SHARED_PLAN_LOOKUPS.has(sql)) seen.shared++;
      seen.inFlight++;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      try {
        return await inner.query(sql, parameters);
      } finally {
        seen.inFlight--;
      }
    },
    exec: (sql) => inner.exec(sql),
  };
  return { session, seen };
}

/** Distinct plan-page lookups: snapshot files, issuers and networks. */
async function distinctLookups(plans: Record<string, unknown>[]) {
  const issuers = new Set(
    plans.map((p) => (p.issuer as { issuer_id: string }).issuer_id),
  );
  const networks = new Set(
    plans.map((p) =>
      JSON.stringify([
        (p.issuer as { issuer_id: string }).issuer_id,
        (p.network as { network_id: string }).network_id,
      ]),
    ),
  );
  return { issuers: issuers.size, networks: networks.size };
}

/** A copy of the catalog service that skips the page scope: the per-plan behaviour this change replaced. */
async function unscopedCatalog() {
  const source = fileURLToPath(
    new URL("../../src/services/catalog.ts", import.meta.url),
  );
  const text = await readFile(source, "utf8");
  const mutant = text.replace(
    "const scoped = planPageScope(db);",
    "const scoped = db;",
  );
  expect(mutant).not.toBe(text);
  // Node caches the module by URL, so it stays usable after the file is removed.
  return withMutantFile(source, mutant, (file) =>
    importMutant<typeof CatalogModule>(file, "searchPlans"),
  );
}

/** The query budget per catalog page: two per plan plus one per distinct shared lookup. */
function requireBudget(
  seen: { total: number; shared: number },
  plans: Record<string, unknown>[],
  lookups: { issuers: number; networks: number },
) {
  const sharedBudget = 1 + lookups.issuers + lookups.networks;
  if (seen.shared > sharedBudget)
    throw new Error(`shared lookups ${seen.shared} exceed ${sharedBudget}`);
  if (seen.total > 2 * plans.length + sharedBudget + 10)
    throw new Error(`queries ${seen.total} exceed the page budget`);
}

it("runs shared plan lookups once per page and keeps the response bytes", async () => {
  const { session, seen } = counted(db);
  const result = await searchPlans(session, params);
  expect(result.plans.length).toBeGreaterThan(1);
  const lookups = await distinctLookups(result.plans);
  requireBudget(seen, result.plans, lookups);
  expect(seen.peak).toBeLessThanOrEqual(5);

  // Negative control and before/after check: the unscoped copy returns identical bytes
  // but runs the shared lookups for every plan, which the budget rejects.
  const before = await unscopedCatalog();
  const old = counted(db);
  const oldResult = await before.searchPlans(old.session, params);
  expect(JSON.stringify(oldResult)).toBe(JSON.stringify(result));
  expect(old.seen.total).toBeGreaterThan(seen.total);
  expect(() => requireBudget(old.seen, oldResult.plans, lookups)).toThrow(
    /exceed/,
  );
});

it("caps concurrent queries and gives every caller its own rows", async () => {
  let inFlight = 0,
    peak = 0;
  const slow: SqlSession = {
    async query(sql) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { rows: [{ sql, value: { nested: 1 } }] } as never;
    },
    exec: async () => {},
  };
  const scoped = requestScope(slow, { concurrency: 3, shared: new Set(["S"]) });
  const answers = await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => scoped.query(`Q${i}`)),
    scoped.query("S", [1]),
    scoped.query("S", [1]),
  ]);
  expect(peak).toBe(3);
  // Late arrivals while slots change hands still respect the cap.
  peak = 0;
  const late: Promise<unknown>[] = [];
  for (let i = 0; i < 12; i++) {
    late.push(scoped.query(`L${i}`));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await Promise.all(late);
  expect(peak).toBeLessThanOrEqual(3);
  const [a, b] = answers.slice(-2).map((answer) => answer.rows[0]!);
  expect(a).toEqual(b);
  expect(a).not.toBe(b);

  // Negative control: an uncapped scope lets all 20 run at once.
  peak = 0;
  const open = requestScope(slow, { concurrency: Infinity, shared: new Set() });
  await Promise.all(Array.from({ length: 20 }, (_, i) => open.query(`Q${i}`)));
  expect(peak).toBe(20);
});

it("does not reuse a failed shared lookup", async () => {
  let calls = 0;
  const flaky: SqlSession = {
    async query() {
      calls++;
      if (calls === 1) throw new Error("synthetic failure");
      return { rows: [{ ok: true }] } as never;
    },
    exec: async () => {},
  };
  const scoped = requestScope(flaky, {
    concurrency: 2,
    shared: new Set(["S"]),
  });
  await expect(scoped.query("S")).rejects.toThrow("synthetic failure");
  expect((await scoped.query("S")).rows).toEqual([{ ok: true }]);
  expect(calls).toBe(2);
});
