import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import type { SqlSession } from "../../src/db/database.js";
import { searchProviders } from "../../src/api/provider-repository.js";
import { importProviders } from "../../src/ingest/qhp/provider.js";
import { fixture, scope, setup } from "../ingest/qhp/provider-helpers.js";
import { saveResult } from "../../src/ingest/geocode/repository.js";
import type { Address } from "../../src/ingest/geocode/address.js";

// Synthetic records, coordinates and plan assignments; no claimed publisher data.
// P6K_POSTGIS_URL must be an empty disposable database.
describe("plan radius: batched current-point counts preserve record scope", () => {
  let h: Awaited<ReturnType<typeof setup>>, plan: string;
  const latitude = 29.7105,
    longitude = -95.3973;
  const npi = (i: number) => String(1000030000 + i);
  beforeAll(async () => {
    h = await setup(
      process.env.P6K_POSTGIS_URL
        ? createDatabase(process.env.P6K_POSTGIS_URL)
        : undefined,
    );
    const source = (await fixture("records"))[0];
    const plans = source.plans.filter((p: { plan_id: string }) =>
      h.catalog.plans.some(
        (c: { base_plan_id: string }) => c.base_plan_id === p.plan_id,
      ),
    );
    plan = plans[0].plan_id;
    expect(plans[1]).toBeTruthy();
    await h.replace(
      Array.from({ length: 69 }, (_, i) => ({
        ...structuredClone(source),
        npi: npi(i),
        name: { first: "Synthetic", last: "PlanRadius" },
        plans: [structuredClone(plans[i === 68 ? 1 : 0])],
        addresses:
          i === 67
            ? []
            : [
                {
                  address: `Synthetic plan radius ${i}`,
                  city: "HOUSTON",
                  state: "TX",
                  zip: "77030",
                },
              ],
      })),
    );
    await importProviders(h.db, scope);
    // Duplicate positive ordinals on the grouped path still count one record/address.
    await h.db.exec(`INSERT INTO provider_plan_group VALUES (repeat('d',64))`);
    await h.db.query(
      `INSERT INTO provider_plan_group_edge(group_id,source_plan_index,base_hios_id,plan_year,network_tier,tier_status)
      SELECT repeat('d',64),i,e.base_hios_id,e.plan_year,e.network_tier,e.tier_status
      FROM (SELECT * FROM qhp_provider_plan_legacy WHERE base_hios_id=$1 LIMIT 1) e
        CROSS JOIN generate_series(0,1) i`,
      [plan],
    );
    await h.db
      .exec(`INSERT INTO provider_record_plan_group SELECT snapshot_id,record_id,repeat('d',64)
        FROM qhp_provider_record WHERE source_record BETWEEN 30 AND 67;
      DELETE FROM qhp_provider_plan_legacy e USING provider_record_plan_group l
        WHERE e.snapshot_id=l.snapshot_id AND e.record_id=l.record_id;
      DELETE FROM qhp_provider_plan WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=63);
      UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
        WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=64);`);
    await h.db.transaction(async (tx) => {
      const records = (
        await tx.query<{
          snapshot_id: string;
          record_id: string;
          source_record: string;
        }>(
          "SELECT snapshot_id,record_id,source_record FROM qhp_provider_record ORDER BY source_record",
        )
      ).rows;
      for (const record of records) {
        const i = Number(record.source_record);
        if (i === 65 || i === 67) continue;
        const address: Address = {
          npi: npi(i),
          kind: "issuer",
          ordinal: 0,
          line_1: `Synthetic plan radius ${i}`,
          line_2: null,
          city: "HOUSTON",
          state: "TX",
          zip5: "77030",
          snapshot_id: i === 66 ? "catalog" : record.snapshot_id,
          source_table: "qhp_provider_address",
          source_row: `${record.snapshot_id}:${record.record_id}:0`,
        };
        await saveResult(
          tx,
          address,
          {
            id: String(i),
            status: "Match",
            quality: "Exact",
            latitude: latitude + (i >= 60 && i <= 62 ? 8 / 69.093 : i / 100000),
            longitude,
          },
          "catalog",
        );
      }
    });
  });
  afterAll(async () => {
    await h?.close();
  });
  const query = (page: number) => ({
    plan,
    year: 2026,
    page,
    origin: { latitude, longitude, method: "coordinates" },
    radius: 5,
  });
  it("keeps exact totals/unlocated counts before paging and matches the direct anti-join", async () => {
    const indexed = [];
    for (const page of [1, 2, 3])
      indexed.push(await searchProviders(h.db, query(page)));
    expect(indexed.map((p) => p.total)).toEqual([60, 60, 60]);
    expect(indexed.map((p) => p.providers.length)).toEqual([50, 10, 0]);
    expect(indexed.map((p) => p.next_page)).toEqual([2, null, null]);
    expect(indexed.every((p) => p.meta.unlocated === 2)).toBe(true);
    const rows = indexed.flatMap((p) => p.providers);
    expect(new Set(rows.map((p) => p.record_id)).size).toBe(60);
    expect(rows.map((p) => p.npi).sort()).toEqual(
      Array.from({ length: 60 }, (_, i) => npi(i)).sort(),
    );
    expect(
      rows.every(
        (p) =>
          p.addresses.length === 1 &&
          p.participation === "listed_participating",
      ),
    ).toBe(true);
    let batched = false;
    const direct: SqlSession = {
      ...h.db,
      query: (sql, args) => {
        batched ||= sql.includes("current_points AS MATERIALIZED");
        const directCount = `(SELECT count(*)::int FROM locations a WHERE NOT EXISTS (SELECT 1 FROM address_point p
        WHERE p.source_table='qhp_provider_address' AND p.source_snapshot_id=a.snapshot_id
        AND p.source_row=a.snapshot_id||':'||a.record_id||':'||a.address_index::text))`;
        return h.db.query(
          sql
            .replace(
              "(SELECT count(*)::int FROM locations)-(SELECT coalesce(sum(located),0)::int FROM current_point_counts)",
              directCount,
            )
            .replace(
              "(SELECT count(*)::int FROM locations a WHERE NOT EXISTS (SELECT 1 FROM current_points p WHERE p.source_snapshot_id=a.snapshot_id AND p.record_id=a.record_id AND p.address_index=a.address_index))",
              directCount,
            ),
          args,
        );
      },
    };
    for (const page of [1, 2, 3])
      expect(await searchProviders(direct, query(page))).toEqual(
        indexed[page - 1],
      );
    expect(batched).toBe(Boolean(process.env.P6K_POSTGIS_URL));
    expect(
      await searchProviders(h.db, { ...query(1), name: "PlanRadius" }),
    ).toEqual(indexed[0]);
    // Without an origin, coordinates are page-only but missing counts still cover
    // every candidate, including when the requested page has no providers.
    for (const page of [1, 2, 3]) {
      const q = { plan, year: 2026, page, name: "PlanRadius" };
      const result = await searchProviders(h.db, q);
      expect(result.total).toBe(66);
      expect(result.meta.unlocated).toBe(2);
      expect(result.providers).toHaveLength([50, 16, 0][page - 1]!);
      expect(await searchProviders(direct, q)).toEqual(result);
    }
  });
  it("counts an address once when two normalization hashes retain current points", async () => {
    const rollback = new Error("rollback duplicate point control");
    await expect(
      h.db.transaction(async (tx) => {
        const r = (
          await tx.query<{ snapshot_id: string; record_id: string }>(
            "SELECT snapshot_id,record_id FROM qhp_provider_record WHERE source_record=0",
          )
        ).rows[0]!;
        await saveResult(
          tx,
          {
            npi: npi(0),
            kind: "issuer",
            ordinal: 0,
            line_1: "Synthetic alternate normalization",
            line_2: null,
            city: "HOUSTON",
            state: "TX",
            zip5: "77030",
            snapshot_id: r.snapshot_id,
            source_table: "qhp_provider_address",
            source_row: `${r.snapshot_id}:${r.record_id}:0`,
          },
          {
            id: "duplicate",
            status: "Match",
            quality: "Exact",
            latitude,
            longitude,
          },
          "catalog",
        );
        for (const q of [query(1), { plan, year: 2026, page: 3 }]) {
          expect((await searchProviders(tx, q)).meta.unlocated).toBe(2);
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("negative control: dropping the plan predicate changes results and fails the consistency check", async () => {
    const expected = await searchProviders(h.db, query(1));
    let mutated = false;
    const mutant: SqlSession = {
      ...h.db,
      query: (sql, args) => {
        if (sql.includes("plan_records AS MATERIALIZED")) {
          sql = sql.replace(
            "e.base_hios_id=$1 AND e.plan_year=$2",
            "$1::text IS NOT NULL AND $2::integer IS NOT NULL",
          );
          mutated = true;
        }
        return h.db.query(sql, args);
      },
    };
    const broken = await searchProviders(mutant, query(1));
    expect(mutated).toBe(true);
    expect(broken.total).toBe(61);
    expect(() => expect(broken).toEqual(expected)).toThrow();
  });
  it("returns the same complete response when the covering indexes are removed", async () => {
    const expected = await searchProviders(h.db, query(1)),
      rollback = new Error("rollback index consistency control");
    await expect(
      h.db.transaction(async (tx) => {
        await tx.exec(`DROP INDEX provider_record_plan_group_search;
        DROP INDEX provider_plan_group_search; DROP INDEX address_point_provider_source`);
        expect(await searchProviders(tx, query(1))).toEqual(expected);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
