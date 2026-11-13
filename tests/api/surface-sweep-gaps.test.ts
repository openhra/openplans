import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import { callTool } from "../../src/mcp/tools.js";
import { setup, TOKEN, headers, searchBody } from "../compat/v1/helpers.js";

// Failure classes found by scripts/oracle/surface-sweep.mjs, one test each, over the TX fixture
// cut. The fixture loads only TX PY2026, no Medicare catalog and no territory ZCTAs. SYNTHETIC
// ZCTA rows for Puerto Rico and Guam are inserted in a transaction that is rolled back; their
// county codes and names are public Census identifiers, the areas are invented.
type Json = ReturnType<typeof JSON.parse>;
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const mcp = async (db: SqlSession, tool: string, input: unknown) =>
  (await callTool({ db: db as never }, tool as never, input))
    .structuredContent as Json;
async function native(db: SqlSession, path: string, body?: unknown) {
  const response = await createApp(db, { premiumToken: TOKEN }).request(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  expect(response.status, path).toBe(200);
  return (await response.json()) as Json;
}
async function compatGaps(extra: Record<string, unknown>) {
  const response = await createApp(h.db, { premiumToken: TOKEN }).request(
    "/compat/v1/plans/medical/search",
    {
      method: "POST",
      headers,
      body: JSON.stringify(searchBody({ applicants: [{ age: 40 }], ...extra })),
    },
  );
  expect(response.status).toBe(200);
  return (response.headers.get("x-openplans-gaps") ?? "").split(", ");
}

describe("a county whose state or plan year has no active catalog", () => {
  // Los Angeles County (no CA catalog) and Harris County in a year the fixture does not load.
  const cases = [
    { county: "06037", year: 2026 },
    { county: "48201", year: 2027 },
  ];

  it("native plan search and public quotes name state_catalog_not_loaded", async () => {
    for (const { county, year } of cases) {
      const search = await native(
        h.db,
        `/v1/plans?county=${county}&year=${year}`,
      );
      expect(search.plans).toEqual([]);
      expect(search.issues).toEqual(["state_catalog_not_loaded"]);
      const quotes = await native(h.db, "/v1/quotes", {
        county,
        year,
        members: [{ age: 40 }],
      });
      expect(quotes.quotes).toEqual([]);
      expect(quotes.issues).toEqual(["state_catalog_not_loaded"]);
    }
  });

  it("MCP search_plans and quote_plans carry it in location_issues", async () => {
    for (const { county, year } of cases) {
      const search = await mcp(h.db, "search_plans", {
        year,
        location: { county },
      });
      expect(search.error).toBeNull();
      expect(search.data.location_issues).toEqual(["state_catalog_not_loaded"]);
      const quote = await mcp(h.db, "quote_plans", {
        year,
        location: { county },
        members: [{ age: 40 }],
      });
      expect(quote.error).toBeNull();
      expect(quote.data.location_issues).toEqual(["state_catalog_not_loaded"]);
    }
  });

  it("compatibility search adds the state_catalog_not_loaded gap", async () => {
    expect(await compatGaps({ fips_code: "06037" })).toContain(
      "state_catalog_not_loaded",
    );
    expect(
      await compatGaps({ fips_code: "48201", enrollment_date: "2027-01-01" }),
    ).toContain("state_catalog_not_loaded");
  });
});

describe("territory ZIP codes", () => {
  async function withTerritories<T>(run: (tx: SqlSession) => Promise<T>) {
    const marker = new Error("synthetic territory rollback");
    let result: T | undefined;
    await expect(
      h.db.transaction(async (tx) => {
        const { snapshot_id } = (
          await tx.query<{ snapshot_id: string }>(
            "SELECT snapshot_id FROM zcta_county LIMIT 1",
          )
        ).rows[0]!;
        for (const [zcta, county, name, row] of [
          ["00601", "72001", "Adjuntas Municipio", 900001],
          ["00601", "72141", "Utuado Municipio", 900002],
          ["96910", "66010", "Guam", 900003],
        ] as const)
          await tx.query(
            `INSERT INTO zcta_county VALUES ($1,$2,$3,1000,0,5000,0,500,0,$4,$5)`,
            [zcta, county, name, snapshot_id, row],
          );
        result = await run(tx);
        throw marker;
      }),
    ).rejects.toBe(marker);
    return result!;
  }

  it("MCP lookup_geography and search_plans answer instead of failing the output check", async () => {
    const out = await withTerritories(async (tx) => ({
      split: await mcp(tx, "lookup_geography", { zip: "00601" }),
      guam: await mcp(tx, "lookup_geography", { zip: "96910" }),
      search: await mcp(tx, "search_plans", {
        year: 2026,
        location: { zip: "00601" },
      }),
      guamSearch: await mcp(tx, "search_plans", {
        year: 2026,
        location: { zip: "96910" },
      }),
    }));
    expect(out.split.error).toBeNull();
    expect(
      out.split.data.counties.map((c: Json) => [c.county_fips, c.state]),
    ).toEqual([
      ["72001", "PR"],
      ["72141", "PR"],
    ]);
    expect(out.guam.error).toBeNull();
    expect(out.guam.data.counties[0].state).toBe("GU");
    expect(out.search.error).toBeNull();
    expect(out.search.status).toBe("ambiguous");
    expect(out.guamSearch.error).toBeNull();
    expect(out.guamSearch.data.plans).toEqual([]);
    expect(out.guamSearch.data.location_issues).toEqual([
      "state_catalog_not_loaded",
    ]);
  });
});

describe("Medicare plan search with no Medicare catalog", () => {
  it("MCP search_medicare_plans names the native reason for an empty list", async () => {
    const nativeAnswer = await native(
      h.db,
      "/v1/medicare/plans?county_fips=48201&year=2026",
    );
    expect(nativeAnswer.reason).toBe("catalog_not_loaded");
    const out = await mcp(h.db, "search_medicare_plans", {
      year: 2026,
      location: { county: "48201" },
    });
    expect(out.error).toBeNull();
    expect(out.data.plans).toEqual([]);
    expect(out.data.reason).toBe("catalog_not_loaded");
  });

  it("a ZIP outside the loaded geography names zip_not_in_loaded_geography", async () => {
    const nativeAnswer = await native(
      h.db,
      "/v1/medicare/plans?zip=10001&year=2026",
    );
    expect(nativeAnswer.plans).toEqual([]);
    expect(nativeAnswer.reason).toBe("zip_not_in_loaded_geography");
    const out = await mcp(h.db, "search_medicare_plans", {
      year: 2026,
      location: { zip: "10001" },
    });
    expect(out.error).toBeNull();
    expect(out.data.reason).toBe("zip_not_in_loaded_geography");
  });
});
