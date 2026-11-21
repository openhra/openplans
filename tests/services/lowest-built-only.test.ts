import type * as HandyBuild from "../../src/worker/handy-build.js";
import type * as HandyService from "../../src/services/handy.js";
import { readFile } from "node:fs/promises";
import { withMutantFile, importMutant } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setup } from "../compat/v1/helpers.js";
import { createApp } from "../../src/api/app.js";
import { lowestInput } from "../../src/api/handy.js";
import { lowestPremiums } from "../../src/services/handy.js";
import { callLowestTool } from "../../src/mcp/handy.js";
import { buildLowestPremiums } from "../../src/worker/handy-build.js";
import {
  lowestInventory,
  prebuildLowestPremiums,
  runLowestPrebuild,
} from "../../src/worker/lowest-prebuild.js";
import {
  handyKey,
  handyManifest,
  lowestEvidenceKey,
  readLowestCell,
} from "../../src/db/handy-repository.js";
import type { SqlSession } from "../../src/db/database.js";
import { ReadError } from "../../src/services/errors.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { loadConfig } from "../../src/config/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";

let h: Awaited<ReturnType<typeof setup>>;
const input = lowestInput({
  zip: "77002",
  county: "48201",
  year: 2026,
  age: 40,
});
const query = (age: number) =>
  `/v1/lowest-premiums?zip=77002&county=48201&year=2026&age=${age}`;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

it("serves built cells and returns cold structured misses without consulting pricing tables", async () => {
  await buildLowestPremiums(h.db, input);
  const reads: string[] = [];
  const guarded: SqlSession = {
    ...h.db,
    async query(sql, values) {
      reads.push(sql);
      if (
        /(?:FROM|JOIN)\s+(?:rate|plan|plan_attribute|state_community_rate)\b/i.test(
          sql,
        )
      )
        throw new Error("Request computed an unpublished cell");
      return h.db.query(sql, values);
    },
  };
  const app = createApp(guarded, { lowestPremiums: true });
  expect((await app.request(query(40))).status).toBe(200);
  reads.length = 0;
  const started = performance.now();
  const miss = await app.request(query(39));
  expect(miss.status).toBe(404);
  expect(performance.now() - started).toBeLessThan(100);
  expect(await miss.json()).toMatchObject({
    error: { code: "lowest_not_built", year: 2026 },
  });
  expect(reads.some((sql) => sql.includes("FROM handy_lowest_active"))).toBe(
    true,
  );
  const mcp = await callLowestTool(
    { db: guarded, lowestPremiums: true },
    { ...input, age: 39 },
  );
  expect(mcp).toMatchObject({
    isError: true,
    structuredContent: {
      status: "error",
      data: null,
      error: { code: "lowest_not_built" },
    },
  });
});

it("rejects expired publications even when a memory cache was warmed, then renews idempotently", async () => {
  const cache = createResponseCache(h.db, undefined, {
    config: loadConfig({}, { version: 1, cache: { enabled: true } }),
    store: new MemoryCache(8 * 1024 * 1024),
  });
  await lowestPremiums(h.db, input, { cache });
  const count = await h.db.query("SELECT build_id FROM handy_lowest_build");
  expect((await buildLowestPremiums(h.db, input)).status).toBe("current");
  expect(
    (await h.db.query("SELECT build_id FROM handy_lowest_build")).rows,
  ).toEqual(count.rows);
  await h.db.query(
    "UPDATE handy_lowest_build SET expires_at=now()-interval '1 second' WHERE request_key=$1",
    [handyKey(input)],
  );
  const started = performance.now();
  await expect(
    lowestPremiums(h.db, input, { builtOnly: true, cache }),
  ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
  expect(performance.now() - started).toBeLessThan(100);
  expect(
    (await createApp(h.db, { lowestPremiums: true }).request(query(40))).status,
  ).toBe(404);
  expect(
    await callLowestTool({ db: h.db, lowestPremiums: true, cache }, input),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "lowest_not_built" } },
  });
  await h.db.query(
    "UPDATE handy_lowest_active SET expired_at=now()-interval '1 second' WHERE request_key=$1",
    [handyKey(input)],
  );
  expect((await buildLowestPremiums(h.db, input)).status).toBe("active");
  expect((await lowestPremiums(h.db, input, { builtOnly: true })).status).toBe(
    "calculated",
  );
});

it("a planted request enumerator fails the strict-read assertion", async () => {
  const missing = { ...input, age: 38 };
  const assertUnpublished = async (call: () => Promise<unknown>) =>
    expect(call()).rejects.toBeInstanceOf(ReadError);
  await assertUnpublished(() =>
    lowestPremiums(h.db, missing, { builtOnly: true }),
  );
  const source = new URL("../../src/services/handy.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "if (options.builtOnly)",
      "if (false)",
    ),
    async (file) => {
      const mutant = await importMutant<typeof HandyService>(
        file,
        "lowestPremiums",
      );
      await expect(
        assertUnpublished(() =>
          mutant.lowestPremiums(h.db, missing, { builtOnly: true }),
        ),
      ).rejects.toThrow();
    },
  );
});

it("invalidates a built cell when pricing sources change", async () => {
  const end = new Error("rollback synthetic source change");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE api_data_generation SET revision=revision+1 WHERE table_name='rate'",
      );
      await expect(
        lowestPremiums(tx, input, { builtOnly: true }),
      ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
      throw end;
    }),
  ).rejects.toBe(end);
});

it("resumes a bounded inventory and produces the same digest on a second complete run", async () => {
  const inventory = [
    { ...input, age: 37 },
    { ...input, age: 36 },
    { ...input, age: 37 },
  ];
  const plan = await prebuildLowestPremiums(h.db, { inventory, dryRun: true });
  expect(plan).toMatchObject({
    status: "planned",
    expected_cells: 2,
    built_cells: 0,
    digest: null,
  });
  const partial = await prebuildLowestPremiums(h.db, {
    inventory,
    maxCells: 1,
  });
  expect(partial).toMatchObject({
    status: "partial",
    expected_cells: 2,
    ready_cells: 1,
    digest: null,
  });
  const first = await prebuildLowestPremiums(h.db, { inventory });
  expect(first).toMatchObject({
    status: "complete",
    built_cells: 1,
    current_cells: 1,
    ready_cells: 2,
  });
  const second = await prebuildLowestPremiums(h.db, {
    inventory: [...inventory].reverse(),
  });
  expect(second).toMatchObject({
    status: "complete",
    built_cells: 0,
    current_cells: 2,
  });
  expect(second.digest).toBe(first.digest);
  expect(second.inventory_sha256).toBe(first.inventory_sha256);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(await handyManifest(h.db)).toBe(first.input_manifest);
});

it("the default inventory contains county/year ages 0 through 64 only", async () => {
  let count = 0;
  const found = new Set<string>();
  for await (const cell of lowestInventory(h.db, { years: [2026] })) {
    count++;
    expect(cell.zip).toBeUndefined();
    expect(cell.age).toBeLessThanOrEqual(64);
    if (cell.county === "48201" && (cell.age === 0 || cell.age === 64))
      found.add(`${cell.county}:${cell.age}`);
    if (!cell.zip && cell.county === "48201" && cell.age === 40)
      found.add("county");
  }
  expect(count).toBeGreaterThan(121);
  expect(found).toEqual(new Set(["48201:0", "48201:64", "county"]));
  await expect(
    prebuildLowestPremiums(h.db, { years: [2025], dryRun: true }),
  ).rejects.toThrow("no loaded catalog");
});

it("published unknown evidence stays unknown and an unknown unbuilt year stays a 404", async () => {
  const unknown = lowestInput({
    ...input,
    year: 2025,
    coverage_start: "2025-01-01",
  });
  const app = createApp(h.db, { lowestPremiums: true });
  const response = await app.request(query(40).replace("2026", "2025"));
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("not covered");
  await buildLowestPremiums(h.db, unknown);
  expect(
    await lowestPremiums(h.db, unknown, { builtOnly: true }),
  ).toMatchObject({
    status: "unknown",
    reason: "catalog_not_loaded",
    lowest: { monthly_cents: null },
  });
});

it("invalid CLI arguments fail before opening storage", async () => {
  let opened = false;
  const out = { out: () => {}, error: () => {} };
  const code = await runLowestPrebuild(
    ["--years", "2026,2026"],
    () => {
      opened = true;
      return h.db;
    },
    out,
  );
  expect(code).toBe(1);
  expect(opened).toBe(false);
});

it("caps publication expiry at its pricing snapshot expiry", async () => {
  const end = new Error("rollback synthetic snapshot expiry");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE snapshot SET expired_at=now()+interval '1 hour' WHERE snapshot_id IN (SELECT snapshot_id FROM puf_import_file)",
      );
      const database = {
        ...h.db,
        ...tx,
        transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
          run({
            ...tx,
            exec: async (sql) => {
              if (!sql.startsWith("SET TRANSACTION")) await tx.exec(sql);
            },
          }),
      };
      const result = await buildLowestPremiums(database, input);
      expect(result.status).toBe("active");
      const row = await tx.query<{ bounded: boolean }>(
        "SELECT expires_at<=now()+interval '1 hour' AS bounded FROM handy_lowest_build WHERE request_key=$1",
        [handyKey(input)],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows.every((r) => r.bounded)).toBe(true);
      throw end;
    }),
  ).rejects.toBe(end);
});

it("an incomplete or corrupt publication cannot pass the inventory audit", async () => {
  const end = new Error("rollback synthetic publication corruption");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE handy_lowest_build SET payload='{' WHERE request_key=$1",
        [handyKey(input)],
      );
      await expect(
        lowestPremiums(tx, input, { builtOnly: true }),
      ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
      const database = { ...h.db, ...tx };
      expect(
        await prebuildLowestPremiums(database, {
          inventory: [input],
          maxCells: 0,
        }),
      ).toMatchObject({ status: "partial", ready_cells: 0, digest: null });
      throw end;
    }),
  ).rejects.toBe(end);
});

it("rejects legacy publications without changing the pricing manifest", async () => {
  const end = new Error("rollback synthetic legacy publication");
  await expect(
    h.db.transaction(async (tx) => {
      const manifest = await handyManifest(tx);
      await tx.query(
        "UPDATE handy_lowest_build SET algorithm=replace(algorithm,':county-v3','') WHERE request_key=$1",
        [handyKey(input)],
      );
      expect(await handyManifest(tx)).toBe(manifest);
      await expect(
        lowestPremiums(tx, input, { builtOnly: true }),
      ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
      throw end;
    }),
  ).rejects.toBe(end);
});

it("reclaims interrupted staged cells before replacement budget admission", async () => {
  const interrupted = { ...input, age: 43 };
  await buildLowestPremiums(h.db, interrupted);
  await h.db.query("DELETE FROM handy_lowest_active WHERE request_key=$1", [
    handyKey(interrupted),
  ]);
  let admitted = false;
  const database = {
    ...h.db,
    transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
      h.db.transaction((tx) =>
        run({
          ...tx,
          query: async (sql, values) => {
            if (sql.includes("INSERT INTO handy_lowest_evidence")) {
              const leftovers = await tx.query(
                "SELECT build_id FROM handy_lowest_build WHERE request_key=$1",
                [handyKey(interrupted)],
              );
              expect(leftovers.rows).toHaveLength(0);
              admitted = true;
            }
            return tx.query(sql, values);
          },
        }),
      ),
  };
  expect((await buildLowestPremiums(database, interrupted)).status).toBe(
    "active",
  );
  expect(admitted).toBe(true);
  expect(
    (
      await h.db.query(
        "SELECT build_id FROM handy_lowest_build WHERE request_key=$1",
        [handyKey(interrupted)],
      )
    ).rows,
  ).toHaveLength(1);
});

it("deduplicates ZIP forms and ages above 64 into county cells", async () => {
  const inventory = [
    { ...input, age: 64 },
    { ...input, age: 120 },
    { county: input.county, year: input.year, age: 64 },
    { zip: input.zip, year: input.year, age: 64 },
  ];
  const result = await prebuildLowestPremiums(h.db, { inventory });
  expect(result).toMatchObject({
    status: "complete",
    expected_cells: 1,
    ready_cells: 1,
  });
  const county = await lowestPremiums(h.db, inventory[2], { builtOnly: true });
  const zip = await lowestPremiums(h.db, inventory[3], { builtOnly: true });
  const older = await lowestPremiums(h.db, inventory[1], { builtOnly: true });
  expect(older.basis.age).toBe(120);
  expect(older.lowest).toEqual(county.lowest);
  expect(zip.lowest).toEqual(county.lowest);
  expect(older.provenance).toEqual(county.provenance);
  expect(zip.location.zip).toBe(input.zip);
  expect(county.location.zip).toBeUndefined();
});

it("stores full evidence once per county/year, keeps accounting exact and rejects shared corruption after warming", async () => {
  const manifest = await handyManifest(h.db),
    id = lowestEvidenceKey(input, manifest);
  const rows = await h.db.query<{ evidence_id: string }>(
    "SELECT DISTINCT evidence_id FROM handy_lowest_build WHERE evidence_id=$1",
    [id],
  );
  expect(rows.rows).toHaveLength(1);
  const usage = await h.db.query<{ accounted: string; actual: string }>(`SELECT
    (SELECT payload_bytes FROM handy_lowest_usage)::text AS accounted,
    ((SELECT sum(octet_length(payload)) FROM handy_lowest_build)+(SELECT sum(octet_length(payload)) FROM handy_lowest_evidence))::text AS actual`);
  expect(usage.rows[0]!.accounted).toBe(usage.rows[0]!.actual);
  await lowestPremiums(h.db, input, { builtOnly: true });
  const end = new Error("rollback synthetic shared corruption");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE handy_lowest_evidence SET payload=payload||' ' WHERE evidence_id=$1",
        [id],
      );
      await expect(
        lowestPremiums(tx, input, { builtOnly: true }),
      ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
      throw end;
    }),
  ).rejects.toBe(end);
});

it("rejects a planted payload budget overrun before publication", async () => {
  await expect(
    h.db.transaction(async (tx) => {
      await tx.exec("UPDATE handy_lowest_usage SET payload_bytes=1073741823");
      await tx.exec(
        "INSERT INTO handy_lowest_evidence(evidence_id,payload,payload_sha256,raw_bytes) VALUES('synthetic-budget','xx','synthetic',2)",
      );
    }),
  ).rejects.toThrow(/check constraint/);
  expect(
    (
      await h.db.query(
        "SELECT evidence_id FROM handy_lowest_evidence WHERE evidence_id='synthetic-budget'",
      )
    ).rows,
  ).toEqual([]);
  await expect(
    h.db.transaction(async (tx) => {
      await tx.exec(
        "UPDATE handy_lowest_usage SET raw_payload_bytes=1073741823",
      );
      await tx.exec(
        "INSERT INTO handy_lowest_evidence(evidence_id,payload,payload_sha256,raw_bytes) VALUES('synthetic-raw-budget','xx','synthetic',2)",
      );
    }),
  ).rejects.toThrow(/check constraint/);
});

it("retains ZIP ambiguity and mismatch checks without requiring an ambiguous publication", async () => {
  const ambiguous = await lowestPremiums(
    h.db,
    { zip: "75007", year: 2026, age: 40 },
    { builtOnly: true },
  );
  expect(ambiguous).toMatchObject({
    status: "ambiguous",
    reason: "location_ambiguous",
    lowest: { monthly_cents: null },
  });
  await expect(
    lowestPremiums(h.db, { ...input, county: "48113" }, { builtOnly: true }),
  ).rejects.toThrow();
});

it("shares SQL rows across ages without cloning PostgreSQL parser metadata", async () => {
  const database = {
    ...h.db,
    transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
      h.db.transaction((tx) =>
        run({
          ...tx,
          query: async <Row extends Record<string, unknown>>(
            sql: string,
            values?: unknown[],
          ) => ({
            ...(await tx.query<Row>(sql, values)),
            fields: [{ parser: () => 1 }],
          }),
        }),
      ),
  };
  expect(
    (await buildLowestPremiums(database, { ...input, age: 48 })).status,
  ).toBe("active");
});

it("reuses only age-independent refusals and a missing-child-rate shortcut mutant fails", async () => {
  const end = new Error("rollback synthetic age-specific missing rates");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.exec("DELETE FROM rate WHERE age_band='0-14'");
      const database = {
        ...h.db,
        ...tx,
        transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
          run({
            ...tx,
            exec: async (sql) => {
              if (!sql.startsWith("SET TRANSACTION")) await tx.exec(sql);
            },
          }),
      };
      const county = lowestInput({
        county: input.county,
        year: input.year,
        age: 0,
      });
      const inventory = [county, { ...county, age: 21 }];
      expect(
        (await prebuildLowestPremiums(database, { inventory })).status,
      ).toBe("complete");
      const expected = await lowestPremiums(tx, inventory[1], { slow: true });
      expect(expected.status).toBe("calculated");
      expect(
        await lowestPremiums(tx, inventory[0], { builtOnly: true }),
      ).toMatchObject({ status: "unknown", reason: "rate_rows_missing" });
      expect(
        await lowestPremiums(tx, inventory[1], { builtOnly: true }),
      ).toEqual(expected);
      const source = new URL(
        "../../src/worker/handy-build.ts",
        import.meta.url,
      );
      await withMutantFile(
        source,
        replaceSyntax(
          await readFile(source, "utf8"),
          '"catalog_not_loaded",',
          '"rate_rows_missing", "catalog_not_loaded",',
        ),
        async (file) => {
          const mutant = await importMutant<typeof HandyBuild>(
            file,
            "buildLowestCounty",
          );
          await tx.exec(
            "UPDATE api_data_generation SET revision=revision+1 WHERE table_name='rate'",
          );
          await mutant.buildLowestCounty(database, inventory);
          const assertAdultPrice = async () =>
            expect(
              (await lowestPremiums(tx, inventory[1], { builtOnly: true }))
                .status,
            ).toBe("calculated");
          await expect(assertAdultPrice()).rejects.toThrow();
        },
      );
      throw end;
    }),
  ).rejects.toBe(end);
});

it("the national file retains counties absent from state-scoped geography tables", async () => {
  const end = new Error("rollback synthetic sparse geography");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.exec(
        "DELETE FROM zcta_county; DELETE FROM rating_area; DELETE FROM service_area_county",
      );
      const database = { ...h.db, ...tx };
      let found = false;
      for await (const cell of lowestInventory(database, { years: [2026] }))
        if (cell.county === "48201" && cell.age === 64) found = true;
      expect(found).toBe(true);
      throw end;
    }),
  ).rejects.toBe(end);
});

it("rebuilds malformed request metadata and expired shared evidence instead of reusing them", async () => {
  for (const mutation of [
    "UPDATE handy_lowest_build SET request_json=replace(request_json,'48201','48203')",
    "UPDATE handy_lowest_evidence SET expired_at=now()-interval '1 second'",
  ]) {
    const end = new Error("rollback synthetic renewal corruption");
    await expect(
      h.db.transaction(async (tx) => {
        await tx.exec(mutation);
        await expect(
          lowestPremiums(tx, input, { builtOnly: true }),
        ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
        const database = {
          ...h.db,
          ...tx,
          transaction: async <T>(run: (session: SqlSession) => Promise<T>) =>
            run({
              ...tx,
              exec: async (sql) => {
                if (!sql.startsWith("SET TRANSACTION")) await tx.exec(sql);
              },
            }),
        };
        expect((await buildLowestPremiums(database, input)).status).toBe(
          "active",
        );
        expect(
          (await lowestPremiums(tx, input, { builtOnly: true })).status,
        ).toBe("calculated");
        throw end;
      }),
    ).rejects.toBe(end);
  }
});

it("shares parsed filed rows across ages while preserving independent age results", async () => {
  const { requestReads } = await import("../../src/services/request-reads.js");
  const { enumerateLowest } = await import("../../src/services/handy.js");
  const manifest = await handyManifest(h.db),
    reads = requestReads(h.db);
  const county = lowestInput({
    county: input.county,
    year: input.year,
    age: 0,
  });
  for (const age of [0, 14, 15, 20, 21, 40, 63, 64]) {
    const request = { ...county, age };
    expect(await enumerateLowest(h.db, request, manifest, reads)).toEqual(
      await enumerateLowest(h.db, request, manifest),
    );
  }
});

it("keeps refusal location ages exact and the digest stable after a single-cell rebuild", async () => {
  const inventory = [0, 63].map((age) =>
    lowestInput({ county: input.county, year: 2025, age }),
  );
  const keys = inventory.map(handyKey);
  const clear = async () => {
    await h.db.query(
      "DELETE FROM handy_lowest_active WHERE request_key=ANY($1::text[])",
      [keys],
    );
    await h.db.query(
      "DELETE FROM handy_lowest_build WHERE request_key=ANY($1::text[])",
      [keys],
    );
  };
  try {
    const first = await prebuildLowestPremiums(h.db, { inventory });
    expect(first.status).toBe("complete");
    const manifest = await handyManifest(h.db);
    expect(await readLowestCell(h.db, inventory[1]!, manifest)).toMatchObject({
      status: "unknown",
      reason: "catalog_not_loaded",
      location: { age: 63 },
      basis: { age: 63 },
    });
    await h.db.query("DELETE FROM handy_lowest_active WHERE request_key=$1", [
      keys[1],
    ]);
    await h.db.query("DELETE FROM handy_lowest_build WHERE request_key=$1", [
      keys[1],
    ]);
    const second = await prebuildLowestPremiums(h.db, { inventory });
    expect(second.status).toBe("complete");
    expect(second.built_cells).toBe(1);
    expect(second.digest).toBe(first.digest);
    await clear();
    const source = new URL("../../src/worker/handy-build.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "location: { ...ageIndependent.location, age: input.age },",
        "location: { ...ageIndependent.location, age: 0 },",
      ),
      async (file) => {
        const mutant = await importMutant<typeof HandyBuild>(
          file,
          "buildLowestCounty",
        );
        await mutant.buildLowestCounty(h.db, inventory);
        const assertExactAge = async () =>
          expect(
            await readLowestCell(h.db, inventory[1]!, manifest),
          ).toBeDefined();
        await expect(assertExactAge()).rejects.toThrow();
      },
    );
  } finally {
    await clear();
  }
});
