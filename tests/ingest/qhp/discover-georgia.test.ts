import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import { fetchToCache } from "../../../src/fetch/index.js";
import type { Transport } from "../../../src/fetch/transport.js";
import { discoverQhp } from "../../../src/ingest/qhp/discover.js";
import { readGeorgiaRegistry } from "../../../src/ingest/qhp/discover-registry.js";
import type { RegistryInput } from "../../../src/ingest/qhp/discover-registry.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

// Synthetic, labelled: the real Georgia Access MR-PUF layout (four columns, the
// last a contact column) with example hosts. The contact cells are placeholders.
const csv = [
  '"State","Issuer ID","URL Submitted","Tech POC Email"',
  '"GA","11111","https://cached.example/ga/cms-data-index.json","contact-placeholder"',
  '"GA","22222","https://uncached.example/index.json","contact-placeholder"',
  '"TX","33333","https://other-state.example/index.json","contact-placeholder"',
].join("\n");

let directory: string,
  db: Database,
  migration: Awaited<ReturnType<typeof coreMigrations>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-qhp-ga-"));
  db = testDatabase(new PGlite());
  migration = await coreMigrations();
  await migrate(db, migration.directory);
});
afterEach(async () => {
  await db.close();
  await migration.cleanup();
  await rm(directory, { recursive: true, force: true });
});
async function registry(): Promise<RegistryInput> {
  const path = join(directory, "MR-PUF_20261001161638_2027-1.csv");
  await writeFile(path, csv);
  const sha256 = createHash("sha256").update(csv).digest("hex");
  return {
    path,
    format: "georgia-access-csv",
    metadata: {
      snapshot_id: sha256,
      source: "synthetic-georgia-access-puf",
      url: "https://georgia.example/MR-PUF_20261001161638_2027-1.csv",
      final_url: "https://georgia.example/MR-PUF_20261001161638_2027-1.csv",
      redirect_chain: [],
      status: 200,
      content_type: "text/csv",
      etag: null,
      last_modified: null,
      sha256,
      bytes: Buffer.byteLength(csv),
      fetched_at: "2026-11-09T00:00:00Z",
    },
  };
}
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("Georgia Access MR-PUF registry and offline discovery", () => {
  it("reads state rows and never carries the contact column", async () => {
    const rows = await readGeorgiaRegistry((await registry()).path, "GA");
    expect(rows).toEqual([
      {
        issuer: "11111",
        url: "https://cached.example/ga/cms-data-index.json",
        row: 2,
      },
      { issuer: "22222", url: "https://uncached.example/index.json", row: 3 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("contact");
  });

  it("offline: reopens a cached index, records a miss as not_cached and sends nothing", async () => {
    // Seed the cache once through a trusted test transport (no network).
    const index = JSON.stringify({
      plan_urls: ["https://cached.example/ga/plans_GA.json"],
      provider_urls: ["https://cached.example/ga/providers_GA.json"],
      formulary_urls: [],
    });
    const seed: Transport = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([index]),
    });
    await fetchToCache("https://cached.example/ga/cms-data-index.json", {
      source: "qhp-11111-2027-index",
      dataDir: directory,
      allowHosts: ["cached.example"],
      expectedContent: "json",
      lookup,
      transport: seed,
      maxAttempts: 1,
    });
    const report = await discoverQhp(db, {
      year: 2027,
      state: "GA",
      dataDir: directory,
      registry: await registry(),
      offline: true,
    });
    expect(
      report.issuers.map((i) => [
        i.issuer,
        i.status,
        i.plan_urls,
        i.provider_urls,
      ]),
    ).toEqual([
      ["11111", "ok", 1, 1],
      ["22222", "not_cached", 0, 0],
    ]);
  });

  it("refuses the Georgia Access registry outside Georgia", async () => {
    await expect(
      discoverQhp(db, {
        year: 2027,
        state: "TX",
        dataDir: directory,
        registrySource: "georgia_access",
        offline: true,
      }),
    ).rejects.toThrow(/GA only/);
  });
});
