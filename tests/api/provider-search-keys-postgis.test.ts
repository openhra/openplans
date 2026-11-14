import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setup } from "../ingest/qhp/provider-helpers.js";
import {
  buildProviderSearchKeys,
  currentSearchKeys,
} from "../../src/api/provider-search-keys.js";
import { searchProviders } from "../../src/api/provider-repository.js";
import type { ProviderSearch } from "../../src/api/provider-repository.js";
import {
  equivalenceSeeds,
  freshDatabase,
  load,
  origin,
  recording,
  serverUrl,
} from "./provider-search-keys-fixtures.js";

// Checks for the provider search keys (fixtures in provider-search-keys-fixtures.ts).

describe.skipIf(!serverUrl)(
  "a search that started before a slot switch never answers from the emptied slot",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    const q: ProviderSearch = {
      page: 1,
      origin: origin(29.7105, -95.3973),
      radius: 5,
    };
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(
        h.db,
        Array.from({ length: 12 }, (_, i) => ({
          npi: String(1000020000 + i),
          name: `ReviewNear${i}`,
          type: "1" as const,
          codes: ["207Q00000X"],
          addresses: [[[29.7105 + i / 1000, -95.3973]]],
        })),
      );
    });
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    it("a snapshot taken before the switch does not answer from the truncated old slot", async () => {
      const before = await searchProviders(h.db, q);
      expect(before.total).toBe(12);
      expect((await buildProviderSearchKeys(h.db)).slot).toBe("a");
      const db = fresh.db;
      // provider_search_query is STABLE: its EXECUTE reads in the snapshot of the outer
      // statement, taken before the inner statement locks the slot table. A REPEATABLE READ
      // transaction pins that snapshot the same way, deterministically.
      const during = await db.withSession!(async (pinned) => {
        await pinned.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await pinned.query("SELECT 1 FROM provider_search_build");
          // Switches to slot b and truncates slot a: no lock conflict, the pinned reader
          // has not touched slot a yet.
          expect(await buildProviderSearchKeys(db)).toMatchObject({
            slot: "b",
            previous_cleared: true,
          });
          expect(await currentSearchKeys(pinned)).toBe("a");
          const { seen, session } = recording(pinned);
          const answer = await searchProviders(session, q);
          return { answer, seen };
        } finally {
          await pinned.exec("COMMIT");
        }
      });
      // TRUNCATE is not MVCC-safe, so slot a looks empty to the old snapshot, yet the check in
      // the same snapshot still names it current. The answer must fall back, not be empty.
      expect(during.answer.total).toBe(12);
      expect(during.answer.providers.map((p) => p.npi)).toEqual(
        before.providers.map((p) => p.npi),
      );
    });

    it("nor from a slot that a later build emptied and refilled", async () => {
      const before = await searchProviders(h.db, q);
      const db = fresh.db;
      const current = await currentSearchKeys(db);
      const during = await db.withSession!(async (pinned) => {
        await pinned.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
        try {
          await pinned.query("SELECT 1 FROM provider_search_build");
          // After two builds the second has emptied the pinned slot, filled it again and named it.
          await buildProviderSearchKeys(db);
          expect((await buildProviderSearchKeys(db)).slot).toBe(current);
          const { seen, session } = recording(pinned);
          const answer = await searchProviders(session, q);
          return { answer, seen };
        } finally {
          await pinned.exec("COMMIT");
        }
      });
      // The refilled rows were written after the snapshot, so it reads the slot as empty.
      expect(during.answer.total).toBe(before.total);
      expect(during.seen.original).toBe(1);
      // Outside the old snapshot the refilled slot answers again.
      const after = recording(db);
      expect((await searchProviders(after.session, q)).total).toBe(
        before.total,
      );
      expect(after.seen).toEqual({ keyed: 1, original: 0 });
    });
  },
);

describe.skipIf(!serverUrl)(
  "keyed and original searches give identical answers",
  () => {
    let h: Awaited<ReturnType<typeof setup>>,
      fresh: Awaited<ReturnType<typeof freshDatabase>>;
    beforeAll(async () => {
      fresh = await freshDatabase();
      h = await setup(fresh.db);
      await load(h.db, equivalenceSeeds());
      await h.db
        .query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Family Medicine Physician','Family Medicine','26.1','catalog')`);
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      await fresh?.drop();
    });

    const searches = () => {
      const list: ProviderSearch[] = [];
      const origins: [number, number][] = [
        [30.3, -97.7],
        [30.35, -97.65],
        [64.84, -147.72],
        [21.3, -157.8],
        [51.88, 180],
        [51.88, -180],
        [51.9, 179.99],
      ];
      for (const [lat, lon] of origins)
        for (const radius of [0, 0.000001, 1, 5, 25, 120, 500])
          for (const filter of [
            {},
            { name: "reviewtie" },
            { taxonomy: "208D00000X" },
            { specialty: "family", type: "INDIVIDUAL" as const },
          ])
            for (const page of radius >= 120 ? [1, 2, 3] : [1])
              list.push({ page, origin: origin(lat, lon), radius, ...filter });
      return list;
    };

    it("for every origin, radius, filter and page", async () => {
      const list = searches();
      const original: string[] = [];
      for (const q of list)
        original.push(JSON.stringify(await searchProviders(h.db, q)));
      const built = await buildProviderSearchKeys(h.db);
      expect(built.unlocated_rows).toBe(5);
      const { seen, session } = recording(h.db);
      const differences: string[] = [];
      for (const [i, q] of list.entries()) {
        const keyed = JSON.stringify(await searchProviders(session, q));
        if (keyed !== original[i]) differences.push(JSON.stringify(q));
      }
      expect(seen).toEqual({ keyed: list.length, original: 0 });
      expect(differences).toEqual([]);
      // At least one page boundary is crossed, so pagination is exercised.
      expect(
        original.some(
          (body) => (JSON.parse(body) as { total: number }).total > 50,
        ),
      ).toBe(true);
    }, 300_000);
  },
);
