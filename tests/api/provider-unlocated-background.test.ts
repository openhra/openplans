import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cachedUnlocated,
  COUNT_SOURCES,
  countRevisions,
} from "../../src/api/provider-unlocated.js";
import { dataGeneration } from "../../src/api/cache/generation.js";
import type { SqlSession } from "../../src/db/database.js";
import { POOL_MAX } from "../../src/db/scope.js";
import { setup } from "../ingest/qhp/provider-helpers.js";

// While the search keys are stale, an identity radius search whose filter set has
// no kept count starts an exact count with a two-minute limit. Only one such count may run at a
// time, on the background connection, and counts and their retry pause follow the provider
// tables' revisions, not the global data generation. A synthetic database records how many
// counts run at the same time.
function slowCounts(delayMs: number) {
  const state = {
    generation: "g1",
    providers: "p1",
    running: 0,
    peak: 0,
    started: 0,
  };
  const db: SqlSession = {
    query: async (sql) => {
      // The provider revision read names the count's source tables; the global one does not.
      if (sql.includes("api_data_generation"))
        return {
          rows: [
            sql.includes("npi_provider")
              ? { revisions: state.providers }
              : { generation: state.generation },
          ],
        } as never;
      state.started += 1;
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        throw new Error("Query read timeout");
      } finally {
        state.running -= 1;
      }
    },
    exec: async () => {},
  };
  return { db, state };
}
const count = (key: string) => ({
  key,
  sql: "SELECT 1 AS unlocated",
  parameters: [],
});

describe("background unlocated counts", () => {
  it("run one at a time, leaving connections for requests when many filter sets miss at once", async () => {
    const { db, state } = slowCounts(100);
    const names = Array.from({ length: POOL_MAX + 1 }, (_, i) => `name-${i}`);
    expect(
      await Promise.all(
        names.map((name) => cachedUnlocated(db, count(name), 10)),
      ),
    ).toEqual(names.map(() => null));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.started).toBe(1);
    expect(state.peak).toBe(1);
    // The skipped filter sets were not kept: once the connection is free, the next search
    // for one of them starts its count.
    expect(await cachedUnlocated(db, count("name-1"), 10)).toBeNull();
    expect(state.started).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("does not restart a timed-out count when an unrelated table moves the generation", async () => {
    const { db, state } = slowCounts(5);
    expect(await cachedUnlocated(db, count("smith"), 50)).toBeNull();
    expect(state.started).toBe(1);
    state.generation = "g2";
    expect(await cachedUnlocated(db, count("smith"), 50)).toBeNull();
    expect(state.started).toBe(1);
    // A provider table write is new data: the count runs again.
    state.providers = "p2";
    expect(await cachedUnlocated(db, count("smith"), 50)).toBeNull();
    expect(state.started).toBe(2);
  });
});

describe("provider revisions on a migrated database", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.close();
  });

  it("move with a provider table write but not with an unrelated catalog write", async () => {
    const tables = (
      await h.db.query<{ table_name: string }>(
        "SELECT table_name FROM api_data_generation ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    // Every source table has a revision row, so a write to any of them is seen.
    for (const table of COUNT_SOURCES) expect(tables).toContain(table);
    const revisions = await countRevisions(h.db);
    const generation = await dataGeneration(h.db);
    await h.db.query(
      `INSERT INTO source(source_id,publisher,source_kind) VALUES ('unrelated-catalog-write','synthetic fixture harness','test')`,
    );
    expect(await dataGeneration(h.db)).not.toBe(generation);
    expect(await countRevisions(h.db)).toBe(revisions);
    await h.db.query(
      `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
      VALUES ('1000099999','1','Synthetic','Revision',true,'TX','2026-11-07','catalog')`,
    );
    expect(await countRevisions(h.db)).not.toBe(revisions);
  });
});
