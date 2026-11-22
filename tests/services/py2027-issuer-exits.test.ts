import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import type { ImportFile } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { publishAnnualData } from "../../src/db/data-window.js";
import { dataAvailability } from "../../src/services/availability.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// PY2027 individual-market scopes after a carrier announces an exit. The only evidence the
// product reads is the CMS PY2027 PUF. A scope the PUF does not list serves no plan answers and
// the answer stays unknown or absent; no notice, page or press item changes it.
//
// Loaded here: the real CMS PY2027 plan-attribute cut for TX (issuer 66252 lists plans). The
// scopes below that exit are SYNTHETIC: issuer ids 99001..99003 and states with no PY2027
// catalog appear in no loaded file, standing in for each issuer class.
const fixtures = fileURLToPath(
  new URL("../fixtures/puf/import-2027/", import.meta.url),
);
const db = testDatabase(new PGlite());
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-py2027-exit-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  const provenance = JSON.parse(
    await readFile(join(fixtures, "provenance.json"), "utf8"),
  ) as { files: { kind: string; url: string }[] };
  const files: ImportFile[] = await Promise.all(
    IMPORT_KINDS.map(async (kind) => {
      const path = join(fixtures, `${kind}.csv`),
        data = await readFile(path);
      return {
        kind,
        path,
        format: "csv" as const,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        retrievedAt: "2026-11-07T07:33:40.115Z",
        url: provenance.files.find((f) => f.kind === kind)!.url,
      };
    }),
  );
  const report = await importPufs(db, {
    year: 2027,
    state: "TX",
    files,
    dataDir: directory,
  });
  expect(report.status, JSON.stringify(report)).toBe("ACTIVE");
  // The next plan year is served only once it is admitted; admit the loaded PY2027 import.
  await publishAnnualData(db, [
    {
      domain: "individual",
      coverage_year: 2027,
      manifest: {
        schema_version: 1,
        releases: [
          { kind: "puf", snapshot_id: report.import_id, contract_year: 2027 },
        ],
      },
    },
  ]);
  app = createApp(db, {}, { store: new MemoryCache(0) });
}, 120_000);
afterAll(async () => {
  await db?.close();
  await core?.cleanup();
  if (directory) await rm(directory, { recursive: true, force: true });
});

interface Answer {
  status?: string;
  plans?: { base_plan_id: string }[];
  quotes?: unknown[];
  issues?: string[];
}
async function get(path: string) {
  const response = await app.request(path);
  return { status: response.status, text: await response.text() };
}
const json = (text: string) => JSON.parse(text) as Answer;
/** HIOS plan ids start with the five-digit issuer id. */
const issuers = (body: Answer) =>
  (body.plans ?? []).map((p) => p.base_plan_id.slice(0, 5));
/** A refusal word the product never serves for a missing issuer. */
const NO_ABSENCE_CLAIM = /not[_ ]covered|not[_ ]offered|discontinu|exit/i;

describe("issuer the PY2027 PUF lists (a notice elsewhere changes nothing)", () => {
  it("serves its PY2027 plans and availability from the loaded rows", async () => {
    const entries = await dataAvailability(db, { state: "TX", year: 2027 });
    expect(entries.map((e) => e.issuer_id)).toContain("66252");
    const plans = await get("/v1/plans?county=48201&year=2027");
    expect(plans.status).toBe(200);
    const body = json(plans.text);
    expect(body.status).toBe("available");
    expect(body.plans!.length).toBeGreaterThan(0);
    // Positive control for the issuer reader used below: it finds a listed issuer.
    expect(issuers(body)).toContain("11718");
    expect(plans.text).not.toMatch(NO_ABSENCE_CLAIM);
  });

  it("reads no consumer-site source: shipped publishers are public-data hosts only", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../data/access/federal-publishers.json", import.meta.url),
        "utf8",
      ),
    ) as { publishers: unknown };
    const hosts = [
      ...JSON.stringify(manifest.publishers).matchAll(/"host":"([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts)
      expect(host, host).toMatch(
        /(^|\.)(cms\.gov|census\.gov|nlm\.nih\.gov|nucc\.org|geonames\.org)$/,
      );
  });
});

describe("issuer absent from a loaded PY2027 catalog (synthetic issuer 99001)", () => {
  it("has no availability entry and no plan, and never claims absence", async () => {
    const entries = await dataAvailability(db, {
      state: "TX",
      year: 2027,
      issuers: new Set(["99001"]),
    });
    expect(entries).toEqual([]);
    const all = await dataAvailability(db, { state: "TX", year: 2027 });
    expect(all.some((e) => e.issuer_id === "99001")).toBe(false);
    expect(JSON.stringify(all)).not.toMatch(NO_ABSENCE_CLAIM);
    const plans = await get("/v1/plans?county=48201&year=2027");
    const listed = issuers(json(plans.text));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain("99001");
  });

  it("serves no plan or premium for one of its PY2027 plan ids", async () => {
    const plan = await get("/v1/plans/99001TX0100001?year=2027");
    expect(plan.status).toBe(404);
    expect(plan.text).not.toMatch(NO_ABSENCE_CLAIM);
    const quote = await app.request("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        county: "48201",
        year: 2027,
        members: [{ age: 40 }],
        plan_ids: ["99001TX0100001"],
      }),
    });
    const text = await quote.text();
    expect(text).not.toMatch(/total_cents|premium_cents/);
    expect(text).not.toMatch(NO_ABSENCE_CLAIM);
  });
});

describe("scope with no PY2027 plan rows at all", () => {
  // Counties whose states have no PY2027 catalog loaded: IN Marion, OH Franklin, NV Clark.
  const counties = ["18097", "39049", "32003"];

  it("serves no PY2027 plans and names the missing catalog, never an exit", async () => {
    for (const county of counties) {
      const plans = await get(`/v1/plans?county=${county}&year=2027`);
      expect(plans.status, county).toBe(200);
      const body = json(plans.text);
      expect(body.plans, county).toEqual([]);
      expect(body.status, county).toBe("unknown");
      expect(body.issues, county).toEqual(["state_catalog_not_loaded"]);
      expect(plans.text).not.toMatch(NO_ABSENCE_CLAIM);
      const quote = await app.request("/v1/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ county, year: 2027, members: [{ age: 40 }] }),
      });
      const answer = json(await quote.text());
      expect(answer.quotes, county).toEqual([]);
      expect(answer.issues, county).toEqual(["state_catalog_not_loaded"]);
    }
  });

  it("has no availability entry for the scope", async () => {
    for (const state of ["IN", "OH", "NV"])
      expect(await dataAvailability(db, { state, year: 2027 })).toEqual([]);
  });
});
