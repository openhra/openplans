import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { compatReasonGap, REASON_CODES } from "../../src/api/reason-codes.js";
import type { ReasonCode } from "../../src/api/reason-codes.js";
import { resolveLocation } from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import type { SqlSession } from "../../src/db/database.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { outputJsonSchemas } from "../../src/mcp/schemas.js";
import { estimateToolDefinition } from "../../src/mcp/medicare-estimate.js";
import { callTool } from "../../src/mcp/tools.js";
import { householdSubsidy } from "../../src/services/subsidies.js";
import * as catalog from "../../src/services/catalog.js";
import { headers, searchBody, setup, TOKEN } from "../compat/v1/helpers.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

// One row per code in src/api/reason-codes.ts. SYNTHETIC households and a SYNTHETIC
// service-area edit (rolled back) over the TX fixture cut, which loads no NY or VT state
// catalog and no ZCTA rows for ZIP 10001.
type Json = ReturnType<typeof JSON.parse>;
type CompatRoutes = (db: SqlSession) => Hono;
let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
beforeAll(async () => {
  h = await setup();
  await ingestRatingRules(
    h.db,
    fileURLToPath(
      new URL("../../data/rating-rules/2026.json", import.meta.url),
    ),
  );
  directory = await mkdtemp(join(tmpdir(), "openplans-reason-codes-"));
}, 120_000);
afterAll(async () => {
  await h?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const ROOT = new URL("../../", import.meta.url);
const text = (path: string) => readFile(new URL(path, ROOT), "utf8");
const PLAN = "20069TX0100006";
const PART_COUNTY = `UPDATE service_area_county SET partial_county=true, zip_codes='77002' WHERE service_area_id='TXS003' AND county_fips='48201'`;

interface Scenario {
  location: Record<string, string>;
  partCounty?: boolean;
}
/** A request that reaches each code in the TX fixture. */
const TX_SCENARIOS: Readonly<Record<string, Scenario>> = {
  location_requires_zip: { location: { county: "48201" }, partCounty: true },
  zip_limited_service_area: {
    location: { county: "48201" },
    partCounty: true,
  },
  zip_not_in_loaded_geography: { location: { zip: "10001" } },
  state_catalog_not_loaded: { location: { county: "36061" } },
};
/** Codes the TX fixture cannot reach, and the test that drives every surface for them. */
const PROVEN_ELSEWHERE: Readonly<Record<string, string>> = {
  template_saved_before_submission: "tests/services/ichra-ny.test.ts",
  pricing_not_loaded: "tests/api/medicare-cost-plan-average.test.ts",
  dispensing_fees_not_loaded: "tests/api/medicare-cost-plan-average.test.ts",
  dispensing_fee_unknown: "tests/api/medicare-cost-plan-average.test.ts",
  maximum_fair_price_not_in_effect:
    "tests/domain/medicare-cost-plan-average.test.ts",
};

async function inScenario<T>(
  scenario: Scenario,
  run: (db: SqlSession) => Promise<T>,
) {
  if (!scenario.partCounty) return run(h.db);
  const marker = new Error("synthetic part-county rollback");
  let result: T | undefined;
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query(PART_COUNTY);
      result = await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
  return result!;
}

/** Every place each surface can carry a code, as text, for one scenario. */
async function surfaces(
  db: SqlSession,
  location: Record<string, string>,
  compatRoutes?: CompatRoutes,
) {
  const body = {
    plan_ids: [PLAN],
    ...location,
    coverage_start: "2026-01-01",
    members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
  };
  const income = {
    household_income_annual: 31_300,
    household_size: 1,
    tax_filing: "single",
  };
  const request = premiumRequest({ ...body, ...income });
  const subsidy = (await householdSubsidy(
    db,
    request,
    await resolveLocation(db, request.location),
  ))!;
  const search = await catalog.searchPlans(db, { ...location, year: "2026" });
  const native = [
    subsidy.status,
    subsidy.reason,
    ...subsidy.benchmark.issues,
    ...search.issues,
  ];

  const compatApp = compatRoutes
    ? new Hono().route("/", compatRoutes(db))
    : createApp(db, { premiumToken: TOKEN });
  const compat: string[] = [];
  for (const extra of [
    {},
    { household_income: 31_300, household_size: 1, tax_filing: "single" },
  ]) {
    const response = await compatApp.request(
      "/compat/v1/plans/medical/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          searchBody({
            fips_code: location.county ?? "36061",
            ...(location.zip ? { zip_code: location.zip } : {}),
            applicants: [{ age: 40 }],
            ...extra,
          }),
        ),
      },
    );
    expect(response.status).toBe(200);
    compat.push(
      ...(response.headers.get("x-openplans-gaps") ?? "").split(", "),
    );
  }

  const deps = {
    db,
    principal: { id: "synthetic-reason-codes" },
    policy: { canEstimate: () => true },
  };
  const quote = (
    await callTool(deps, "quote_premiums", {
      plan_refs: [PLAN],
      location,
      coverage_start: "2026-01-01",
      members: body.members,
      household: { income_annual: 31_300, size: 1, tax_filing: "single" },
    })
  ).structuredContent as Json;
  const plans = (await callTool(deps, "search_plans", { year: 2026, location }))
    .structuredContent as Json;
  expect(quote.error).toBeNull();
  expect(plans.error).toBeNull();
  const estimate = quote.data.quotes[0];
  const mcp = [
    estimate.subsidy_status,
    estimate.subsidy?.reason,
    ...(estimate.subsidy?.benchmark.issues ?? []),
    ...plans.data.location_issues,
  ];
  return { native, compat, mcp };
}

/** The checks one row must pass; a planted mutant must fail them. */
async function checkRow(
  entry: ReasonCode,
  gapFor: (code: string) => string | undefined,
  compatRoutes?: CompatRoutes,
) {
  // The compatibility mapping exists, matches the list and is documented.
  expect(gapFor(entry.code), entry.code).toBe(entry.compat ?? undefined);
  const compatReadme = await text("src/compat/v1/README.md");
  if (entry.compat !== null)
    expect(
      compatReadme
        .split("\n")
        .some(
          (line) =>
            line.startsWith(`| \`${entry.code}\``) &&
            line.includes(`| \`${entry.compat}\``),
        ),
      `${entry.code} compat README row`,
    ).toBe(true);
  else expect(compatReadme, entry.code).toContain(`\`${entry.code}\``);
  // The public doc names it.
  expect(await text(entry.doc), `${entry.code} in ${entry.doc}`).toContain(
    `\`${entry.code}\``,
  );
  // The MCP output schemas list it, in a description or as an enum value.
  const published = JSON.stringify([
    outputJsonSchemas,
    estimateToolDefinition().outputSchema,
  ]);
  expect(
    published.includes(`\`${entry.code}\``) ||
      published.includes(`"${entry.code}"`),
    `${entry.code} in MCP schemas`,
  ).toBe(true);

  const scenario = TX_SCENARIOS[entry.code];
  if (!scenario) {
    const proof = PROVEN_ELSEWHERE[entry.code];
    expect(proof, `${entry.code} needs a scenario`).toBeDefined();
    expect(await text(proof!), entry.code).toContain(entry.code);
    return;
  }
  const seen = await inScenario(scenario, (db) =>
    surfaces(db, scenario.location, compatRoutes),
  );
  expect(seen.native, `${entry.code} native`).toContain(entry.code);
  expect(seen.mcp, `${entry.code} MCP`).toContain(entry.code);
  expect(seen.compat, `${entry.code} compat`).toContain(entry.compat);
}

describe("every reason code reaches every surface in its mapped form", () => {
  it("lists each code once, with a scenario or a test that proves it", () => {
    const codes = REASON_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes)
      expect(code in TX_SCENARIOS || code in PROVEN_ELSEWHERE, code).toBe(true);
  });

  it.each(REASON_CODES.map((entry) => [entry.code, entry] as const))(
    "%s",
    async (_code, entry) => {
      await checkRow(entry, compatReasonGap);
    },
  );

  it("planted mutant: a code dropped from the compatibility mapping is caught", async () => {
    const dropped = "state_catalog_not_loaded";
    const codes = new URL("../../dist/api/reason-codes.js", import.meta.url);
    const mutantCodes = join(directory, "reason-codes.mjs");
    await writeFile(
      mutantCodes,
      rebaseImports(
        replaceSyntax(
          await readFile(codes, "utf8"),
          `compat: "${dropped}",`,
          "compat: null,",
        ),
        codes,
      ),
    );
    const compat = new URL("../../dist/compat/v1/index.js", import.meta.url);
    const mutantCompat = join(directory, "compat.mjs");
    await writeFile(
      mutantCompat,
      rebaseImports(
        replaceSyntax(
          await readFile(compat, "utf8"),
          `"../../api/reason-codes.js"`,
          JSON.stringify(pathToFileURL(mutantCodes).href),
        ),
        compat,
      ),
    );
    const planted = (await import(pathToFileURL(mutantCodes).href)) as {
      compatReasonGap: typeof compatReasonGap;
    };
    const route = (await import(pathToFileURL(mutantCompat).href)) as {
      compatRoutes: CompatRoutes;
    };
    const entry = REASON_CODES.find((row) => row.code === dropped)!;
    // The real row passes in the table above; the mutant fails the mapping and the route check.
    await expect(checkRow(entry, planted.compatReasonGap)).rejects.toThrow(
      dropped,
    );
    await expect(
      checkRow(entry, compatReasonGap, route.compatRoutes),
    ).rejects.toThrow(`${dropped} compat`);
  });
});
