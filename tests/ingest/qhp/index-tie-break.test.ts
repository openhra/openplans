import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { QHP_INDEX_NEWEST_FIRST } from "../../../src/db/qhp-index-order.js";
import { sourceSet } from "../../../src/ingest/qhp/provider-repository.js";
import { fixture, scope, setup } from "./provider-helpers.js";

// Synthetic indexes only. Two discovery runs can carry an equal discovered_at (a coarse clock);
// the newest-index selection must then be decided by qhp_index_id, never by physical row order.
describe("newest qhp_index selection with an equal discovered_at", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.close();
  });
  const insertTied = (ids: string[], stamp: string) =>
    ids.reduce(
      (chain, id) =>
        chain.then(() =>
          h.db.query(
            `INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,
            registry_row,snapshot_id,status,discovered_at) VALUES ($1,$1,'00010',2026,'TX','registry',1,'index','ok',$2)`,
            [id, stamp],
          ),
        ),
      Promise.resolve<unknown>(undefined),
    );
  it.each([
    [
      "lower id inserted first",
      ["tie-a-low", "tie-b-high"],
      "2098-01-01T00:00:00Z",
    ],
    [
      "higher id inserted first",
      ["tie-d-high", "tie-c-low"],
      "2098-02-01T00:00:00Z",
    ],
  ])("%s: the higher qhp_index_id wins", async (_name, ids, stamp) => {
    await insertTied(ids, stamp);
    const high = [...ids].sort().at(-1)!;
    expect((await sourceSet(h.db, scope)).discovery).toBe(high);
    const direct = await h.db.query<{ qhp_index_id: string }>(
      `SELECT qhp_index_id FROM qhp_index WHERE discovered_at=$1 ORDER BY ${QHP_INDEX_NEWEST_FIRST} LIMIT 1`,
      [stamp],
    );
    expect(direct.rows[0]?.qhp_index_id).toBe(high);
  });
  it("a strictly later discovered_at beats a higher id", async () => {
    await insertTied(["tie-a-newer"], "2099-01-01T00:00:00Z");
    expect((await sourceSet(h.db, scope)).discovery).toBe("tie-a-newer");
  });
  it("the harness gives every replacement a strictly increasing discovered_at and sortable id", async () => {
    const records = await fixture("records");
    // Passing replacements to a fresh harness; 12 crosses the index-9/index-10 text-order boundary.
    const fresh = await setup();
    try {
      for (let i = 0; i < 12; i++) await fresh.replace(records);
      const rows = (
        await fresh.db.query<{ qhp_index_id: string; discovered_at: Date }>(
          `SELECT qhp_index_id,discovered_at FROM qhp_index WHERE qhp_index_id<>'index-row' ORDER BY qhp_index_id`,
        )
      ).rows;
      expect(rows).toHaveLength(12);
      for (let i = 1; i < rows.length; i++)
        expect(rows[i]!.discovered_at.getTime()).toBeGreaterThan(
          rows[i - 1]!.discovered_at.getTime(),
        );
    } finally {
      await fresh.close();
    }
  });
  it("no source SQL orders by discovered_at DESC without the id tie-break", async () => {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(ts|mjs)$/.test(entry.name)) {
          const text = await readFile(path, "utf8");
          for (const m of text.matchAll(
            /discovered_at\s+DESC(?!\s*,\s*qhp_index_id\s+DESC)/gi,
          ))
            hits.push(`${path}:${m.index}`);
        }
      }
    };
    await walk(join(import.meta.dirname, "../../../src"));
    await walk(join(import.meta.dirname, "../../../scripts"));
    expect(hits).toEqual([]);
    expect(QHP_INDEX_NEWEST_FIRST).toMatch(
      /discovered_at DESC,\s*qhp_index_id DESC/,
    );
  });
});
