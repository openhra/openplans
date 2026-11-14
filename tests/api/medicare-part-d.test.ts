import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { Transport } from "../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  coreTables,
  importSpuf,
  parseSpufUrl,
  pharmacyNpi,
} from "../../src/ingest/medicare/spuf.js";
import {
  loadedDatabase,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";
import type { Loaded } from "../ingest/medicare/helpers.js";

interface StatusBody {
  status: string;
  reason?: string;
}
interface DrugsBody extends StatusBody {
  packages: unknown[];
  tier_cost_sharing: { tier: number }[];
  average_unit_cost: { caveat: string };
  tier_labels: { status: string };
}
interface PharmaciesBody extends StatusBody {
  pharmacies: { npi: string; nppes: unknown }[];
}
const all = [...coreTables, "pharmacy_network", "pricing"] as const;

async function cache(dataDir: string, bytes: Buffer) {
  const transport: Transport = async () => ({
    status: 200,
    headers: { "content-type": "application/zip" },
    body: Readable.from([bytes]),
  });
  await acquireSpuf(parseSpufUrl(spufUrl)!, {
    dataDir,
    dependencies: { lookup, transport },
  });
  return (await cachedSpuf("quarterly", dataDir))[0]!;
}

describe("Part D public use files (Q3 2026 cut from the real file)", () => {
  let loaded: Loaded;
  let report: Awaited<ReturnType<typeof importSpuf>>;
  let get: <T = unknown>(path: string) => Promise<{ status: number; body: T }>;
  beforeAll(async () => {
    loaded = await loadedDatabase();
    report = await importSpuf(
      loaded.db,
      await cache(loaded.dataDir, await spufArchive()),
      all,
    );
    const app = createApp(loaded.db, { premiumToken: undefined });
    get = async <T>(path: string): Promise<{ status: number; body: T }> => {
      const response = await app.request(path);
      return { status: response.status, body: await response.json() };
    };
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await loaded?.cleanup();
  });

  it("imports every table and stores each distinct pharmacy network once", () => {
    expect(report.outcome).toBe("imported");
    expect(report.counts.formulary_rows).toBe(15);
    expect(report.counts.pharmacy_network_plans).toBeGreaterThan(0);
    expect(report.counts.pharmacy_networks_distinct).toBeLessThanOrEqual(
      report.counts.pharmacy_network_plans!,
    );
  });

  it("stays off until the operator turns Part D serving on", async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "");
    const { body } = await get(
      "/v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=860975",
    );
    expect(body).toMatchObject({
      status: "unknown",
      reason: "pending_terms_review",
    });
    const pharmacies = await get<StatusBody>(
      "/v1/medicare/plans/H0028-042-0/pharmacies?year=2026&zip=77002",
    );
    expect(pharmacies.body.reason).toBe("pending_terms_review");
  });

  it("serves the formulary listing, tier cost sharing and average unit cost when on", async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    const { body } = await get<DrugsBody>(
      "/v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=860975",
    );
    expect(body).toMatchObject({
      status: "listed",
      formulary_id: "00026408",
      as_of: "2026-10-07",
    });
    expect(body.packages[0]).toMatchObject({
      proxy_ndc: "70010049105",
      tier: 1,
      prior_authorization: false,
    });
    expect(body.tier_cost_sharing.length).toBeGreaterThan(0);
    expect(body.tier_cost_sharing.every((row) => row.tier === 1)).toBe(true);
    expect(body.average_unit_cost.caveat).toMatch(
      /not a price at any pharmacy/,
    );
    expect(body.tier_labels.status).toBe("unknown");
    const absent = await get<StatusBody>(
      "/v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=310965",
    );
    expect(absent.body.status).toBe("not_listed");
    expect(JSON.stringify(absent.body)).not.toMatch(/not_covered/);
  });

  it("lists network pharmacies by NPI and ZIP, leaving names to NPPES", async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    const { body } = await get<PharmaciesBody>(
      "/v1/medicare/plans/H0028-042-0/pharmacies?year=2026&zip=77030",
    );
    expect(body.status).toBe("available");
    for (const pharmacy of body.pharmacies) {
      expect(pharmacy.npi).toMatch(/^[12]\d{9}$/);
      expect(pharmacy.nppes).toEqual({
        status: "unknown",
        reason: "npi_not_in_loaded_nppes",
      });
    }
  });

  it("reads the NPI out of the 12-digit pharmacy number", () => {
    expect(pharmacyNpi("101003001934")).toBe("1003001934");
    expect(() => pharmacyNpi("201003001934")).toThrow("NPI");
    expect(() => pharmacyNpi("1003001934")).toThrow("NPI");
  });
});

describe("Part D negative controls", () => {
  async function fails(
    mutate: Parameters<typeof spufArchive>[0],
    message: RegExp,
  ) {
    const loaded = await loadedDatabase();
    const dataDir = await mkdtemp(join(tmpdir(), "partd-mutant-"));
    try {
      const cached = await cache(dataDir, await spufArchive(mutate));
      await expect(importSpuf(loaded.db, cached, all)).rejects.toThrow(message);
      const state = await loaded.db.query<{ validation_state: string }>(
        "SELECT validation_state FROM snapshot WHERE source_id='cms-partd-spuf-quarterly'",
      );
      expect(state.rows[0]!.validation_state).toBe("QUARANTINED");
    } finally {
      await loaded.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  const edit =
    (outer: RegExp, from: RegExp, to: string) =>
    (name: string, inner: Record<string, Buffer>) => {
      if (!outer.test(name)) return;
      const key = Object.keys(inner)[0]!;
      inner[key] = Buffer.from(
        inner[key]!.toString("latin1").replace(from, to),
        "latin1",
      );
    };
  it(
    "a dropped formulary column",
    () =>
      fails(
        edit(/^basic drugs/, /\|PRIOR_AUTHORIZATION_YN/, "|PRIOR_AUTH"),
        /header lacks PRIOR_AUTHORIZATION_YN/,
      ),
    180_000,
  );
  it(
    "a pharmacy number that is not an NPI",
    () =>
      fails(
        edit(/^pharmacy networks/, /\|10([12]\d{9})\|/, "|99$1|"),
        /not an NPI/,
      ),
    180_000,
  );
  it(
    "an invalid suppression flag",
    () =>
      fails(
        edit(/^plan information/, /\|N\r\n/, "|X\r\n"),
        /PLAN_SUPPRESSED_YN is not Y\/N/,
      ),
    180_000,
  );
});
