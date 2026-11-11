import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlSession } from "../../src/db/database.js";
import { dataAvailability } from "../../src/services/availability.js";
import { quotePlans } from "../../src/services/quotes.js";
import type * as Quotes from "../../src/services/quotes.js";
import { quoteBody, quoteFixture } from "../api/quote-fixture.js";

let fixture: Awaited<ReturnType<typeof quoteFixture>>;
beforeAll(async () => {
  fixture = await quoteFixture();
});
afterAll(async () => fixture?.close());

function countedCatalog() {
  const evidence: unknown[][] = [];
  const seen = { total: 0 };
  const db: SqlSession = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      seen.total++;
      if (sql.includes("count(r.base_plan_id)"))
        evidence.push(parameters ?? []);
      const result = await fixture.db.query<Row>(sql, parameters);
      if (!sql.includes("FROM data_availability")) return result;
      // Synthetic manifest metadata only: unrelated scopes have no invented rate rows.
      const unrelated = result.rows.flatMap((row) => [
        { ...row, state: "UT" },
        { ...row, plan_year: 2027 },
        { ...row, issuer_id: "synthetic-unquoted-issuer" },
      ]);
      return { rows: [...result.rows, ...unrelated] };
    },
    exec: (sql) => fixture.db.exec(sql),
  };
  return { db, evidence, seen };
}

it("checks only quoted state/year/issuers and preserves filtered national evidence", async () => {
  const { db, evidence } = countedCatalog();
  const scope = { state: "TX", year: 2026, issuers: new Set(["87226"]) };
  const scoped = await dataAvailability(db, scope);
  expect(scoped.length).toBeGreaterThan(0);
  expect(evidence.length).toBe(scoped.length);
  for (const parameters of evidence)
    expect(parameters.slice(0, 4)).toEqual(["TX", 2026, "Individual", "87226"]);
  const national = await dataAvailability(db);
  expect(scoped).toEqual(
    national.filter(
      (row) =>
        row.state === "TX" &&
        row.plan_year === 2026 &&
        row.issuer_id === "87226",
    ),
  );
  expect(await dataAvailability(db, { ...scope, issuers: new Set() })).toEqual(
    national.filter((row) => row.state === "TX" && row.plan_year === 2026),
  );
  expect(await dataAvailability(db, { ...scope, state: "ZZ" })).toEqual([]);
});

async function unscopedQuotes() {
  const source = fileURLToPath(
    new URL("../../src/services/quotes.ts", import.meta.url),
  );
  const text = await readFile(source, "utf8");
  const mutant = text.replace(
    "await dataAvailability(db, { state, year, issuers })",
    ` (await dataAvailability(db)).filter(row => row.state === state && row.plan_year === year && (!issuers.size || issuers.has(row.issuer_id as string)))`,
  );
  expect(mutant).not.toBe(text);
  const path = source.replace(
    /quotes\.ts$/,
    `.quotes-unscoped-${process.pid}.ts`,
  );
  await writeFile(path, mutant);
  try {
    return (await import(path)) as typeof Quotes;
  } finally {
    await rm(path, { force: true });
  }
}

function requireQuoteBudget(evidence: unknown[][]) {
  if (evidence.length > 1)
    throw new Error("quote exceeded one rate-evidence check per quoted issuer");
}

it("bounds quote evidence queries independently of unrelated catalogs and rejects the old path", async () => {
  const scoped = countedCatalog();
  const result = await quotePlans(scoped.db, quoteBody());
  expect(result.quotes[0]).toMatchObject({
    status: "rated",
    total_cents: 52928,
  });
  requireQuoteBudget(scoped.evidence);
  expect(scoped.evidence).toHaveLength(1);

  // Negative control: the original filter-after-read path returns the same bytes
  // but rates unrelated catalogs, so the query bound must reject it.
  const mutant = await unscopedQuotes();
  const old = countedCatalog();
  const before = await mutant.quotePlans(old.db, quoteBody());
  expect(before).toEqual(result);
  expect(old.seen.total).toBeGreaterThan(scoped.seen.total);
  expect(() => requireQuoteBudget(old.evidence)).toThrow(/exceeded/);
});
