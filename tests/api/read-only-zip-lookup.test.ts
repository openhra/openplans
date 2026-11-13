import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/api/app.js";
import type { Database, SqlSession } from "../../src/db/database.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { cmsCountySnapshot } from "../../src/ingest/geo/cms.js";
import { STATE_FIPS } from "../../src/ingest/geo/states.js";
import {
  BASE,
  headers,
  searchBody,
  setup,
  TOKEN,
} from "../compat/v1/helpers.js";
import { connect } from "../mcp/client.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

// SYNTHETIC requests against the TX fixture catalog. No NY or VT rows, ZCTAs or state catalogs load,
// like a deployment that serves only federal-platform states.
let h: Awaited<ReturnType<typeof setup>>;
let readOnly: Database;
beforeAll(async () => {
  h = await setup();
  for (const year of [2025, 2026, 2027])
    await ingestRatingRules(
      h.db,
      fileURLToPath(
        new URL(`../../data/rating-rules/${year}.json`, import.meta.url),
      ),
    );
  // Request scopes run each statement in a READ ONLY transaction, as the Postgres pool does.
  readOnly = {
    ...h.db,
    withRequest: (_signal, run, options) =>
      h.db.transaction(async (tx: SqlSession) => {
        if (options?.readOnly !== false)
          await tx.exec("SET TRANSACTION READ ONLY");
        return run(tx);
      }),
  };
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await h?.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
// Unloaded ZIPs in New York, Vermont and New Jersey: none has a ZCTA row in this database.
const UNLOADED_ZIPS = ["10001", "12207", "05401", "07030"];

describe("ZIP lookups in read-only request scopes", () => {
  it("answer unknown instead of failing when a CMS key is set and the ZIP is not loaded", async () => {
    vi.stubEnv("CMS_API_KEY", "synthetic-key");
    await h.db.exec(
      "UPDATE cms_zip_budget SET next_request_at='epoch',blocked_until='epoch',daily_requests=0",
    );
    const app = createApp(readOnly, { premiumToken: TOKEN });
    for (const zip of UNLOADED_ZIPS) {
      for (const year of [2025, 2026, 2027]) {
        const response = await app.request(
          `/v1/benchmark?zip=${zip}&year=${year}&ages=40`,
          { headers: auth },
        );
        expect(response.status, `${zip} ${year}`).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "unknown",
          issues: ["zip_not_in_loaded_geography"],
          slcsp_monthly_cents: null,
          lowest_silver_plans: [],
        });
      }
      const premium = await app.request("/v1/premium-quotes", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          plan_ids: ["87226TX0100013"],
          zip,
          coverage_start: "2026-01-01",
          members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
          household_income_annual: 31_300,
          household_size: 1,
          tax_filing: "single",
        }),
      });
      expect(premium.status, `premium-quotes ${zip}`).not.toBe(500);
      const quotes = await app.request("/v1/quotes", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          year: 2026,
          zip,
          members: [{ age: 35 }],
          plan_ids: ["87226TX0100013"],
        }),
      });
      expect(quotes.status, `quotes ${zip}`).not.toBe(500);
    }
    // The read-only path served cached rows only: no budget spent, no attempt recorded.
    expect(
      (await h.db.query("SELECT daily_requests FROM cms_zip_budget")).rows,
    ).toEqual([{ daily_requests: 0 }]);
    expect(
      (await h.db.query("SELECT count(*)::int AS n FROM cms_zip_attempt")).rows,
    ).toEqual([{ n: 0 }]);
  });

  it("MCP search and quote tools answer unknown locations without an internal error", async () => {
    vi.stubEnv("CMS_API_KEY", "synthetic-key");
    const client = await connect({ db: readOnly });
    try {
      for (const zip of UNLOADED_ZIPS) {
        const search = await client.call("search_plans", {
          year: 2026,
          location: { zip },
        });
        expect(JSON.stringify(search), zip).not.toContain("INTERNAL");
        const quote = await client.call("quote_plans", {
          year: 2026,
          location: { zip },
          members: [{ age: 35 }],
          plan_refs: ["87226TX0100013"],
        });
        expect(JSON.stringify(quote), zip).not.toContain("INTERNAL");
      }
    } finally {
      await client.close();
    }
  });

  it("every state's county benchmark answers without a 500, NY and VT as unsupported", async () => {
    vi.stubEnv("CMS_API_KEY", "");
    const app = createApp(readOnly, { premiumToken: TOKEN });
    for (const [state, fips] of Object.entries(STATE_FIPS)) {
      const county = `${fips}001`;
      const response = await app.request(
        `/v1/benchmark?county=${county}&year=2026&ages=40`,
        { headers: auth },
      );
      expect(response.status, `${state} ${county}`).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      if (state === "NY" || state === "VT")
        expect(body).toMatchObject({
          status: "unsupported_rating_method",
          issues: ["state_catalog_not_loaded"],
        });
      if (state !== "TX")
        expect(body).toMatchObject({ slcsp_monthly_cents: null });
    }
    for (const county of ["36061", "36001", "50007"]) {
      const response = await app.request(`${BASE}/plans/medical/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(searchBody({ fips_code: county })),
      });
      expect(response.status, `compat search ${county}`).toBe(200);
    }
  });

  it("planted mutant: without the read-only check the ZIP lookup throws in a read-only scope", async () => {
    vi.stubEnv("CMS_API_KEY", "synthetic-key");
    await h.db.exec(
      "UPDATE cms_zip_budget SET next_request_at='epoch',blocked_until='epoch',daily_requests=0",
    );
    const original = new URL("../../src/ingest/geo/cms.ts", import.meta.url);
    const directory = await mkdtemp(join(tmpdir(), "openplans-cms-mutant-"));
    const path = join(directory, "cms.ts");
    await writeFile(
      path,
      rebaseImports(
        replaceSyntax(
          await readFile(original, "utf8"),
          'if (mode?.read_only === "on") return null;',
          'if (mode?.read_only === "never") return null;',
        ),
        original,
      ),
    );
    const scope = (lookup: typeof cmsCountySnapshot) =>
      readOnly.withRequest!(new AbortController().signal, (session) =>
        lookup(session, "10001"),
      );
    try {
      const mutant = (await import(path)) as {
        cmsCountySnapshot: typeof cmsCountySnapshot;
      };
      expect(String(mutant.cmsCountySnapshot)).toContain('"never"');
      await expect(scope(mutant.cmsCountySnapshot)).rejects.toThrow(
        /read-only/,
      );
      await expect(scope(cmsCountySnapshot)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
