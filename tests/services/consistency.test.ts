import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHonest, outputSchemas } from "../../src/mcp/schemas.js";
import {
  estimatePremiums,
  getPlan,
  lookupGeography,
} from "../../src/services/catalog.js";
import { getSnapshot } from "../../src/services/provenance.js";
import { createApp } from "../../src/api/app.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "../api/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Real regenerable CMS/Census cuts; household and credentials below are synthetic.
const db = testDatabase(new PGlite());
let dir: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  vi.stubEnv("OPENPLANS_COMPAT_API_KEY", "synthetic-consistency-token");
  vi.stubEnv("OPENPLANS_COMPAT_KEY_HEADER", "");
  dir = await mkdtemp(join(tmpdir(), "openplans-service-consistency-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files: await fixtureFiles(dir),
        dataDir: dir,
      })
    ).status,
  ).toBe("ACTIVE");
  await ingestRatingRules(db);
  // Freeze operational timestamps only, never source data or source retrieval dates.
  await db.exec(
    "UPDATE snapshot SET created_at='2026-11-08T00:00:00Z',activated_at=CASE WHEN activated_at IS NULL THEN NULL ELSE '2026-11-08T00:00:00Z'::timestamptz END",
  );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
  await core.cleanup();
  await rm(dir, { recursive: true, force: true });
});
it("retains pre-extraction native and compatibility status, headers and exact JSON bytes", async () => {
  const app = createApp(db, { premiumToken: "synthetic-consistency-token" });
  const requests: [string, unknown?][] = [
    ["/v1/zip-counties?zip=75034"],
    ["/v1/zip-counties?zip=77001"],
    ["/v1/plans?zip=77002&year=2026"],
    ["/v1/plans?zip=75034&year=2026"],
    ["/v1/plans/87226TX0100013?year=2026"],
    ["/v1/plans/87226TX0100013-00?year=2026"],
    ["/v1/plans/99999TX0100001?year=2026"],
    ["/v1/carriers?state=TX&year=2026"],
    ["/v1/networks?state=TX&year=2026"],
    [
      "/v1/premium-quotes",
      {
        plan_ids: ["87226TX0100013"],
        county: "48201",
        coverage_start: "2026-01-01",
        members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
      },
    ],
    ["/v1/benchmark?county=48201&year=2026&ages=35"],
    ["/v1/data-availability?state=TX&year=2026"],
    ["/v1/providers?plan_id=99999TX0100001&year=2026"],
    ["/v1/providers?specialty=Cardiology"],
    ["/v1/providers?zip=77001&radius_miles=5"],
    ["/v1/providers/1234567890"],
    ["/v1/plans/87226TX0100013/providers/1234567890?year=2026"],
    [
      "/v1/provider-participation",
      { plan_ids: ["87226TX0100013"], npis: ["1234567890"], year: 2026 },
    ],
    ["/v1/drugs?q=aspirin"],
    ["/v1/drugs?ndc=0002-8215-01"],
    ["/v1/drugs/1191"],
    [
      "/v1/drug-coverage",
      { plan_ids: ["87226TX0100013"], rxcuis: ["1191"], year: 2026 },
    ],
    ["/compat/v1/zip_counties?zip_prefix=77002"],
    ["/compat/v1/carriers?state=TX&year=2026"],
    ["/compat/v1/networks?state=TX&year=2026"],
    [
      "/compat/v1/plans/medical/search",
      {
        fips_code: "48201",
        enrollment_date: "2026-01-01",
        applicants: [{ age: 35, smoker: false }],
      },
    ],
  ];
  const wire = [];
  for (const [url, body] of requests) {
    const response = await app.request(url, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer synthetic-consistency-token",
        "x-api-key": "synthetic-consistency-token",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    wire.push({
      url,
      status: response.status,
      content_type: response.headers.get("content-type"),
      gaps: response.headers.get("x-openplans-gaps"),
      cache_control: response.headers.get("cache-control"),
      body: (await response.text()).replace(
        /puf-2026-TX-[0-9a-f-]{36}/g,
        "puf-2026-TX-fixture-import",
      ),
    });
  }
  // Compatibility source/market enums and plan coverage keys follow the wire
  // contract. Native response bytes, source labels and all prices stay frozen.
  expect(wire).toMatchSnapshot();
});

it("round-trips the real gross premium trace and rejects a one-cent fabrication independently", async () => {
  const canonical = await estimatePremiums(db, {
    plan_ids: ["87226TX0100013"],
    county: "48201",
    coverage_start: "2026-01-01",
    members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
  });
  const quote = canonical.estimates[0]!;
  expect(quote).toMatchObject({ status: "rated", total_cents: 52928 });
  const rows = quote.rate_rows_used as {
    provenance: { snapshot_id: string; source_row: number };
    age_band: number;
    tobacco: string;
    individual_rate_cents: number | null;
    individual_tobacco_rate_cents: number | null;
    effective_date: string;
    expiration_date: string;
  }[];
  const refs = [...new Set(rows.map((row) => row.provenance.snapshot_id))];
  const provenance = await Promise.all(
    refs.map(async (id) => {
      const snapshot = (await getSnapshot(db, id))!;
      return {
        id,
        snapshot_id: id,
        publisher: snapshot.publisher,
        url: snapshot.url,
        sha256: snapshot.sha256,
        retrieved_at: new Date(snapshot.retrieved_at!).toISOString(),
        publisher_updated_at: null,
        record_ref: null,
        status: "available",
      };
    }),
  );
  const trace = rows.map((row) => ({
    snapshot_id: row.provenance.snapshot_id,
    source_row: row.provenance.source_row,
    source_record: null,
    family_rates_cents: null,
    column: null,
    tier: null,
    value: null,
    individual_rate_cents: row.individual_rate_cents,
    individual_tobacco_rate_cents: row.individual_tobacco_rate_cents,
    effective_date: row.effective_date,
    expiration_date: row.expiration_date,
    age_band: row.age_band,
    tobacco: row.tobacco,
    evidence_refs: [row.provenance.snapshot_id],
    gaps: [],
  }));
  const members = quote.members.map((m) => ({ ...m, rate_rows: trace }));
  const projected = {
    kind: "estimate",
    plan_ref: quote.plan_id,
    coverage_start: quote.coverage_start,
    gross_status: quote.status,
    coverage: quote.coverage,
    dental_business_rules: [],
    pediatric_ehb: null,
    gross_monthly_cents: "total_cents" in quote ? quote.total_cents : null,
    estimated_credit_cents: null,
    estimated_net_cents: null,
    benchmark_cents: null,
    subsidy_status: "not_requested",
    quote_method: "puf_calculation",
    bindable_quote: false,
    csr_eligibility_status: "not_evaluated",
    rating_area_id: "rating_area_id" in quote ? quote.rating_area_id : null,
    filed_column: null,
    state_rule_trace: null,
    members,
    rate_trace: trace,
    subsidy: null,
    evidence_refs: refs,
    gaps: [],
  };
  const output = {
    schema_version: "1",
    status: "ok",
    data_generation: "fixture-generation",
    provenance,
    notes: [],
    truncated: false,
    freshness: { checked_at: "2026-11-08T00:00:00Z", status: "current_local" },
    page: null,
    error: null,
    data: { quotes: [projected], bindable_quote: false },
  };
  const wire = JSON.parse(JSON.stringify(output));
  expect(outputSchemas.quote_premiums.parse(wire)).toEqual(wire);
  assertHonest("quote_premiums", wire, canonical);
  // A structurally valid and plausible cent still fails against canonical service evidence.
  const mutant = structuredClone(wire);
  mutant.data!.quotes[0]!.gross_monthly_cents =
    mutant.data!.quotes[0]!.gross_monthly_cents! + 1;
  expect(() => outputSchemas.quote_premiums.parse(mutant)).not.toThrow();
  expect(() => assertHonest("quote_premiums", mutant, canonical)).toThrow(
    "fabricated cents",
  );
  expect(() => assertHonest("quote_premiums", wire)).toThrow(
    "missing canonical estimate",
  );
  const noSource = structuredClone(wire);
  noSource.provenance = [];
  expect(() => assertHonest("quote_premiums", noSource, canonical)).toThrow(
    "unresolvable provenance",
  );
  const falseRate = structuredClone(wire);
  falseRate.data!.quotes[0]!.rate_trace[0]!.individual_rate_cents!++;
  expect(() => assertHonest("quote_premiums", falseRate, canonical)).toThrow(
    "changed rate evidence",
  );
  const fabricatedCredit = structuredClone(wire);
  fabricatedCredit.data!.quotes[0]!.estimated_credit_cents = 1;
  expect(() =>
    assertHonest("quote_premiums", fabricatedCredit, canonical),
  ).toThrow("fabricated cents");
  const unrated = structuredClone(wire);
  unrated.data!.quotes[0]!.gross_status = "unknown";
  expect(() => assertHonest("quote_premiums", unrated, canonical)).toThrow(
    "unrated numeric premium",
  );
});
it("shares location ambiguity, variant errors and plan detail outside HTTP", async () => {
  expect(await lookupGeography(db, { zip: "75034" })).toMatchObject({
    status: "ambiguous",
  });
  await expect(
    getPlan(db, "87226TX0100013-99", { year: "2026" }),
  ).rejects.toMatchObject({ error: { code: "PLAN_NOT_FOUND" } });
  const response = await createApp(db, {}).request(
    "/v1/plans/87226TX0100013?year=2026",
  );
  expect(await response.text()).toBe(
    JSON.stringify(await getPlan(db, "87226TX0100013", { year: "2026" })),
  );
});
