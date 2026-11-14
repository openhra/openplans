import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cachedUnlocated } from "../../src/api/provider-unlocated.js";
import type { SqlSession } from "../../src/db/database.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

// A synthetic database: settable provider data revisions and a count whose answer and delay
// the test controls. It records every count query and the timeout each one asked for.
function synthetic() {
  const state = {
    generation: "g1",
    answer: 7,
    delayMs: 0,
    counts: 0,
    timeouts: [] as (number | undefined)[],
  };
  const db: SqlSession = {
    query: async (sql, _parameters, options) => {
      if (sql.includes("api_data_generation"))
        return { rows: [{ revisions: state.generation }] } as never;
      state.counts += 1;
      state.timeouts.push(options?.timeoutMs);
      const answer = state.answer;
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (answer === TIMED_OUT) throw new Error("Query read timeout");
      if (answer < 0) throw new Error("synthetic count failure");
      return { rows: [{ unlocated: answer }] } as never;
    },
    exec: async () => {},
  };
  return { db, state };
}
/** A count that ran past its own limit, as the pool reports it. */
const TIMED_OUT = -2;
const count = (key = "filters") => ({
  key,
  sql: "SELECT 1 AS unlocated",
  parameters: [],
});
type Cached = typeof cachedUnlocated;

async function keepsPerGeneration(cached: Cached) {
  const { db, state } = synthetic();
  expect(await cached(db, count(), 1000)).toBe(7);
  state.answer = 9;
  // Same data generation and filters: the kept count, no second query.
  expect(await cached(db, count(), 1000)).toBe(7);
  expect(state.counts).toBe(1);
  // Other filters count on their own.
  expect(await cached(db, count("other"), 1000)).toBe(9);
  // New provider data: counted again.
  state.generation = "g2";
  expect(await cached(db, count(), 1000)).toBe(9);
  expect(state.counts).toBe(3);
}

describe("kept unlocated counts", () => {
  it("counts once per provider data revision and filter set, with a long read limit", async () => {
    await keepsPerGeneration(cachedUnlocated);
    const { db, state } = synthetic();
    await cachedUnlocated(db, count(), 1000);
    expect(state.timeouts).toEqual([120_000]);
  });

  it("answers an unknown count while the count runs, then serves the finished count", async () => {
    const { db, state } = synthetic();
    state.delayMs = 150;
    expect(await cachedUnlocated(db, count(), 20)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await cachedUnlocated(db, count(), 20)).toBe(7);
    expect(state.counts).toBe(1);
  });

  it("keeps a count that ran past its limit as unknown instead of running it on every search", async () => {
    const { db, state } = synthetic();
    state.answer = TIMED_OUT;
    expect(await cachedUnlocated(db, count(), 1000)).toBeNull();
    state.answer = 4;
    expect(await cachedUnlocated(db, count(), 1000)).toBeNull();
    expect(state.counts).toBe(1);
    // New data starts a new count.
    state.generation = "g2";
    expect(await cachedUnlocated(db, count(), 1000)).toBe(4);
  });

  it("drops a count that failed for another reason so the next search counts again", async () => {
    const { db, state } = synthetic();
    state.answer = -1;
    await expect(cachedUnlocated(db, count(), 1000)).rejects.toThrow(
      "synthetic count failure",
    );
    state.answer = 4;
    expect(await cachedUnlocated(db, count(), 1000)).toBe(4);
  });

  it("keeps two databases apart", async () => {
    const one = synthetic(),
      two = synthetic();
    two.state.answer = 3;
    expect(await cachedUnlocated(one.db, count(), 1000)).toBe(7);
    expect(await cachedUnlocated(two.db, count(), 1000)).toBe(3);
  });

  it("fails when the provider revisions are left out of the key (planted mutant)", async () => {
    const path = new URL(
      "../../src/api/provider-unlocated.ts",
      import.meta.url,
    );
    const source = replaceSyntax(
      await readFile(path, "utf8"),
      "const key = `${await countRevisions(db)}\\n${count.key}`;",
      "const key = count.key;",
    );
    await withMutantFile(path, source, async (file) => {
      const mutant = await importMutant<{ cachedUnlocated: Cached }>(
        file,
        "cachedUnlocated",
      );
      await expect(
        keepsPerGeneration(mutant.cachedUnlocated),
      ).rejects.toThrow();
    });
  });
});
