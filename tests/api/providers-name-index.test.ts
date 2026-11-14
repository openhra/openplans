import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchProviders } from "../../src/api/provider-repository.js";
import type { ProviderSearch } from "../../src/api/provider-repository.js";
import type { Database, SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";

// A name search over NPPES identities must reach the name trigram index (migration 740)
// instead of reading every identity. The plan is checked with sequential scans disabled,
// so it shows the index exactly when the generated SQL carries the indexable condition.
type Search = typeof searchProviders;
const ORIGIN = { latitude: 30.34, longitude: -97.52, method: "synthetic" };
let db: Database, cleanup: () => Promise<void>;
beforeAll(async () => {
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await migrate(db, core.directory);
}, 120_000);
afterAll(async () => {
  await cleanup?.();
  await db?.close();
});

/** The generated search SQL and parameters, captured instead of executed. */
async function generated(search: Search, q: ProviderSearch) {
  let captured: { sql: string; parameters: unknown[] } | undefined;
  const recorder: SqlSession = {
    query: async (sql, parameters) => {
      const match = /\$provider_query\$([\s\S]*)\$provider_query\$/.exec(sql);
      if (!match) return db.query(sql, parameters);
      captured = { sql: match[1]!, parameters: parameters ?? [] };
      throw new Error("captured");
    },
    exec: (sql) => db.exec(sql),
  };
  await expect(search(recorder, q)).rejects.toThrow("captured");
  return captured!;
}

/** The search binds only the parameters its SQL text names. */
const highest = (sql: string) =>
  Math.max(0, ...[...sql.matchAll(/\$([0-9]+)/g)].map((m) => Number(m[1])));

async function plan(search: Search, q: ProviderSearch) {
  const { sql, parameters } = await generated(search, q);
  return db.transaction(async (session) => {
    await session.exec("SET LOCAL enable_seqscan = off");
    const rows = (
      await session.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT to_jsonb(provider_result) FROM (${sql}) provider_result`,
        parameters.slice(0, highest(sql)),
      )
    ).rows;
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

const INDEX = "provider_identity_name_search";
const byName = (name: string): ProviderSearch => ({
  name,
  origin: ORIGIN,
  page: 1,
});

describe("identity name search index", () => {
  it("uses the name trigram index for literal names of three or more characters", async () => {
    expect(await plan(searchProviders, byName("SMITH"))).toContain(INDEX);
    expect(await plan(searchProviders, byName("LEE"))).toContain(INDEX);
    expect(await plan(searchProviders, byName("ANN LEE"))).toContain(INDEX);
  });

  it("keeps the plain scan for wildcard and two-letter names", async () => {
    expect(await plan(searchProviders, byName("LI"))).not.toContain(INDEX);
    expect(await plan(searchProviders, byName("SM%TH"))).not.toContain(INDEX);
  });

  it("fails when the indexable name condition is dropped (planted mutant)", async () => {
    const path = new URL(
      "../../src/api/provider-repository.ts",
      import.meta.url,
    );
    const source = replaceSyntax(
      await readFile(path, "utf8"),
      "`${identityPredicate} ${identityTrigrams}`",
      "identityPredicate",
    );
    await withMutantFile(path, source, async (file) => {
      const mutant = await importMutant<{ searchProviders: Search }>(
        file,
        "searchProviders",
      );
      expect(await plan(mutant.searchProviders, byName("SMITH"))).not.toContain(
        INDEX,
      );
    });
  });
});
