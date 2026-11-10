import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { createApp } from "../../../src/api/app.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { readCsv } from "../../../src/ingest/csv/index.js";
import {
  importPlanLineage,
  NO_PLAN_ID,
} from "../../../src/ingest/puf/import-lineage.js";
import type { LineageFile } from "../../../src/ingest/puf/import-lineage.js";
import { planLineage } from "../../../src/ingest/puf/import-repository.js";
import { fixtureFiles } from "../../api/helpers.js";
import { fixtureFiles as geoFiles } from "../geo/helpers.js";

const fixtures = fileURLToPath(
  new URL("../../fixtures/puf/lineage/", import.meta.url),
);
const token = "synthetic-lineage-token";

async function cutFile(path: string): Promise<LineageFile> {
  const data = await readFile(path);
  const provenance = JSON.parse(
    await readFile(join(fixtures, "provenance.json"), "utf8"),
  );
  return {
    path,
    format: "csv",
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    retrievedAt: "2026-11-07T07:33:43.360Z",
    url: provenance.url,
  };
}

/** Writes a labelled synthetic mutant of the real cut into a disposable directory. */
async function mutant(
  directory: string,
  name: string,
  change: (rows: Record<string, string>[]) => Record<string, string>[],
): Promise<LineageFile> {
  const rows: Record<string, string>[] = [];
  for await (const row of readCsv(
    Readable.from([await readFile(join(fixtures, "plan-id-crosswalk.csv"))]),
  ))
    rows.push(row.values);
  const changed = change(rows);
  const keys = Object.keys(changed[0]!);
  const path = join(directory, `synthetic-mutant-${name}.csv`);
  await writeFile(
    path,
    [keys.join(","), ...changed.map((r) => keys.map((k) => r[k]).join(","))]
      .join("\n")
      .concat("\n"),
  );
  return cutFile(path);
}

describe("Plan ID Crosswalk PUF lineage: real CMS PY2026 cut and labelled synthetic mutants", () => {
  const db = testDatabase(new PGlite());
  let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
  let activeId: string;
  beforeAll(async () => {
    process.env.OPENPLANS_COMPAT_API_KEY = token;
    directory = await mkdtemp(join(tmpdir(), "openplans-lineage-"));
    core = await coreMigrations();
    await migrate(db, core.directory);
    await ingestGeo(db, { files: await geoFiles() });
    const catalog = await importPufs(db, {
      year: 2026,
      state: "TX",
      files: await fixtureFiles(directory),
      dataDir: directory,
    });
    expect(catalog.status).toBe("ACTIVE");
  });
  afterAll(async () => {
    await db.close();
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  it("stores every published row 1:1 and publishes the snapshot", async () => {
    const provenance = JSON.parse(
      await readFile(join(fixtures, "provenance.json"), "utf8"),
    );
    const file = await cutFile(join(fixtures, "plan-id-crosswalk.csv"));
    expect(file.sha256).toBe(provenance.cut_sha256);
    const report = await importPlanLineage(db, {
      year: 2026,
      file,
      dataDir: directory,
    });
    activeId = report.import_id;
    expect(report).toMatchObject({
      status: "ACTIVE",
      input_rows: provenance.rows,
      stored_rows: provenance.rows,
      rejected_rows: 0,
      states: ["AK", "AL", "TX"],
      // The cut also keeps one AK renewal pair beside the TX successor pairs.
      lineage_pairs: provenance.pairs.length + 1,
    });
    const { rows } = await db.query<{ plan_id: string | null; raw: object }>(
      "SELECT plan_id,raw FROM plan_lineage WHERE snapshot_id=$1 AND state='AL'",
      [activeId],
    );
    // The all-zero placeholder is "no successor", never a plan.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBeNull();
    expect(rows[0]!.raw).toMatchObject({ PlanID_2026: NO_PLAN_ID });
  });

  it("returns distinct prior-year IDs, and unknown where no crosswalk covers the state", async () => {
    const merged = await planLineage(db, "66252TX0380001", 2026, "TX");
    expect(merged.status).toBe("available");
    expect(merged.ancestors.map((a) => a.id)).toEqual([
      "66252TX0300001",
      "66252TX0300002",
      "66252TX0300003",
      "66252TX0300006",
      "66252TX0300007",
      "66252TX0300009",
      "66252TX0300010",
      "66252TX0300011",
      "66252TX0300012",
      "66252TX0300013",
    ]);
    expect(new Set(merged.ancestors.map((a) => a.year))).toEqual(
      new Set([2025]),
    );
    const renewed = await planLineage(db, "11718TX0140016", 2026, "TX");
    expect(renewed.ancestors.map(({ id, year }) => ({ id, year }))).toEqual([
      { id: "11718TX0140016", year: 2025 },
    ]);
    expect(await planLineage(db, "11718TX0140099", 2026, "TX")).toEqual({
      status: "available",
      ancestors: [],
    });
    expect(await planLineage(db, "10544CA0010001", 2026, "CA")).toEqual({
      status: "unknown",
      ancestors: [],
    });
  });

  it("serves plan_ancestors, scoped CMS network IDs and carrier issuers", async () => {
    const app = createApp(db);
    const headers = { "X-Api-Key": token };
    const detail = await app.request("/compat/v1/plans/11718TX0140016", {
      headers,
    });
    expect(detail.status).toBe(200);
    const { plan } = (await detail.json()) as {
      plan: Record<string, unknown>;
    };
    expect(plan.plan_ancestors).toEqual([{ id: "11718TX0140016", year: 2025 }]);
    expect(plan.networks).toEqual([
      {
        id: "11718-2026-TXN001-individual",
        name: "Community Health Choice Ultra Select Network",
        provider_directory_url:
          "https://memberaccount.communityhealthchoice.org/s/find-a-provider?language=en_US",
      },
    ]);
    expect(plan.network_ids).toEqual(["11718-2026-TXN001-individual"]);
    expect(detail.headers.get("x-openplans-gaps")).toContain(
      "network_ids_are_cms_network_ids",
    );
    const networks = (await (
      await app.request("/compat/v1/networks?state=TX&year=2026", { headers })
    ).json()) as { networks: { id: string; name: string }[] };
    expect(networks.networks.map((n) => n.id)).toContain(
      "11718-2026-TXN001-individual",
    );
    const carriers = (await (
      await app.request("/compat/v1/carriers?state=TX&year=2026", { headers })
    ).json()) as { carriers: { id: string; issuers: unknown[] }[] };
    expect(carriers.carriers.find((c) => c.id === "11718")?.issuers).toEqual([
      { id: "11718", name: "Community Health Choice", state: "TX" },
    ]);
  });

  it("negative control: a wrong prior-year ID quarantines and keeps the served pointer", async () => {
    const file = await mutant(directory, "wrong-prior-id", (rows) => {
      // Issuer prefix no longer matches IssuerID_2025.
      rows[0]!.PlanID_2025 = "99999TX0270004";
      return rows;
    });
    const report = await importPlanLineage(db, {
      year: 2026,
      file,
      dataDir: directory,
    });
    expect(report.status).toBe("QUARANTINED");
    expect(report.rejected_rows).toBe(1);
    const { rows } = await db.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM plan_lineage_active WHERE plan_year=2026",
    );
    expect(rows[0]!.snapshot_id).toBe(activeId);
  });

  it("negative control: a missing successor column fails closed", async () => {
    const file = await mutant(directory, "missing-column", (rows) =>
      rows.map((row) => {
        const copy = { ...row };
        delete copy.PlanID_2026;
        return copy;
      }),
    );
    const report = await importPlanLineage(db, {
      year: 2026,
      file,
      dataDir: directory,
    });
    expect(report.status).toBe("QUARANTINED");
    expect(report.stored_rows).toBe(0);
    expect(report.failures[0]).toContain("PlanID_2026");
  });

  it("negative control: the wrong publication year's columns are rejected", async () => {
    const file = await cutFile(join(fixtures, "plan-id-crosswalk.csv"));
    const report = await importPlanLineage(db, {
      year: 2027,
      file,
      dataDir: directory,
    });
    expect(report.status).toBe("QUARANTINED");
    const { rows } = await db.query(
      "SELECT 1 FROM plan_lineage_active WHERE plan_year=2027",
    );
    expect(rows).toEqual([]);
  });
});
