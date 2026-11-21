import { createApp } from "../../src/api/app.js";
import { createStatusHost } from "../../src/plugins/status-host.js";
import { loadConfig } from "../../src/config/index.js";
import { callTool } from "../../src/mcp/tools.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setup } from "../compat/v1/helpers.js";
import { admitAnnualData, annualAdmissions } from "../../src/db/data-window.js";
import { runDataAdmission } from "../../src/worker/data-admission.js";
import { migratedTemplate } from "../pglite.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../../src/worker/commands.js";
import {
  servingPolicy,
  withDataPolicy,
} from "../../src/services/data-window.js";
import { dataGeneration } from "../../src/db/generation.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { SqlSession } from "../../src/db/database.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
const at = (db: SqlSession) =>
  withDataPolicy(
    { historyYears: 3 },
    () => servingPolicy(db),
    new Date("2025-11-19T00:00:00Z"),
  );
const manifest = (year = 2026) => ({
  schema_version: 1,
  releases: [
    { kind: "puf", snapshot_id: h.report.import_id, contract_year: year },
  ],
});
async function admit(db: SqlSession, year = 2026) {
  await db.query(
    "INSERT INTO annual_data_admission(domain,coverage_year,manifest) VALUES ('individual',$1,$2)",
    [year, manifest(year)],
  );
}
async function rollback(run: (db: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic admission rollback");
  await expect(
    h.db.transaction(async (db) => {
      await run(db);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

describe("admission ledger over the unchanged CMS fixture", () => {
  it("a fresh database admits nothing", async () => {
    const template = await migratedTemplate();
    const db = await template.fresh();
    try {
      expect(await annualAdmissions(db)).toEqual([]);
    } finally {
      await db.close();
      await template.close();
    }
  });
  it("explicit publication is atomic and refuses a missing or mismatched receipt", async () => {
    const valid = {
      domain: "individual",
      coverage_year: 2026,
      manifest: manifest(),
    };
    for (const invalid of [
      {
        ...valid,
        manifest: {
          schema_version: 1,
          releases: [
            {
              kind: "puf",
              snapshot_id: "synthetic-missing",
              contract_year: 2026,
            },
          ],
        },
      },
      { ...valid, coverage_year: 2027, manifest: manifest(2027) },
    ]) {
      await expect(admitAnnualData(h.db, [valid, invalid])).rejects.toThrow();
      expect(await annualAdmissions(h.db)).toEqual([]);
    }
    await admitAnnualData(h.db, [valid]);
    try {
      expect(await annualAdmissions(h.db)).toEqual([valid]);
      const generation = await h.db.query(
        "SELECT * FROM api_data_generation WHERE table_name='annual_data_admission'",
      );
      await admitAnnualData(h.db, [valid]);
      expect(
        await h.db.query(
          "SELECT * FROM api_data_generation WHERE table_name='annual_data_admission'",
        ),
      ).toEqual(generation);
    } finally {
      await h.db.exec("DELETE FROM annual_data_admission");
    }
  });
  it("rejects malformed command arguments without opening a database", async () => {
    const errors: string[] = [];
    expect(
      await runDataAdmission(
        [],
        () => {
          throw new Error("must not open");
        },
        { out: () => {}, error: (s) => errors.push(s) },
      ),
    ).toBe(1);
    expect(errors).toEqual(["Usage: worker data-admission --manifest FILE"]);
  });
  it("the worker publishes a reviewed manifest and refuses an unmatched receipt", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-annual-command-"),
    );
    const path = join(directory, "admissions.json");
    const admitted = {
      domain: "individual",
      coverage_year: 2026,
      manifest: manifest(),
    };
    const output: string[] = [],
      errors: string[] = [];
    const run = () =>
      runWorker(
        ["data-admission", "--manifest", path],
        () => ({ ...h.db, close: async () => {} }),
        { out: (s) => output.push(s), error: (s) => errors.push(s) },
      );
    try {
      await writeFile(
        path,
        JSON.stringify([
          {
            ...admitted,
            manifest: {
              schema_version: 1,
              releases: [
                {
                  kind: "puf",
                  snapshot_id: "synthetic-missing-receipt",
                  contract_year: 2026,
                },
              ],
            },
          },
        ]),
      );
      expect(await run()).toBe(1);
      expect(errors).toHaveLength(1);
      expect(await annualAdmissions(h.db)).toEqual([]);
      const app = () => createApp(h.db, {}, { config: loadConfig({}) });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2025-11-19T00:00:00Z"));
      const refused = await app().request("/v1/plans?county=48201&year=2026");
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({
        error: { code: "not_loaded" },
      });
      await writeFile(path, JSON.stringify([admitted]));
      expect(await run()).toBe(0);
      expect(JSON.parse(output[0]!)).toEqual({
        admitted: [{ domain: "individual", coverage_year: 2026 }],
      });
      expect(
        (await app().request("/v1/plans?county=48201&year=2026")).status,
      ).toBe(200);
    } finally {
      vi.useRealTimers();
      await h.db.exec("DELETE FROM annual_data_admission");
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("the next request observes admission insertion and revocation through the real generation trigger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-11-19T00:00:00Z"));
    const store = new MemoryCache(1024 * 1024);
    const read = vi.spyOn(store, "get");
    const app = createApp(h.db, {}, { config: loadConfig({}), store });
    const path = "/v1/plans?county=48201&year=2026";
    const before = await dataGeneration(h.db);
    expect((await app.request(path)).status).toBe(404);
    try {
      await admit(h.db);
      expect(await dataGeneration(h.db)).not.toBe(before);
      const admitted = await app.request(path);
      expect(admitted.status).toBe(200);
      expect(admitted.headers.get("x-cache")).toBe("miss");
      expect((await app.request(path)).headers.get("x-cache")).toBe("hit");
      const lookups = read.mock.calls.length;
      await h.db.exec("DELETE FROM annual_data_admission");
      const revoked = await app.request(path);
      expect(revoked.status).toBe(404);
      expect(await revoked.json()).toMatchObject({
        error: { code: "not_loaded", required_year: 2026 },
      });
      expect(read).toHaveBeenCalledTimes(lookups);
    } finally {
      await h.db.exec("DELETE FROM annual_data_admission");
    }
  });
  it("validates every release in one batch and rejects an invalid last dependency", async () => {
    await rollback(async (db) => {
      await admit(db);
      const repeated = {
        schema_version: 1,
        releases: Array.from({ length: 31 }, () => manifest().releases[0]),
      };
      await db.query("UPDATE annual_data_admission SET manifest=$1", [
        repeated,
      ]);
      const query = vi.spyOn(db, "query");
      expect(await annualAdmissions(db)).toHaveLength(1);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1]![0]).toContain("jsonb_to_recordset");
      repeated.releases[30] = {
        kind: "puf",
        snapshot_id: "synthetic-missing-last",
        contract_year: 2026,
      };
      await db.query("UPDATE annual_data_admission SET manifest=$1", [
        repeated,
      ]);
      await expect(annualAdmissions(db)).rejects.toThrow(
        "annual_admission_dependency_invalid",
      );
    });
  });
  it("published rows alone cannot admit next year", async () => {
    const policy = await at(h.db);
    expect(policy.domains.individual.loaded_years).toContain(2026);
    expect(policy.domains.individual.allowed_years).toEqual([2024, 2025]);
  });
  it("an explicit admission validates the full active import dependency closure", async () => {
    await rollback(async (db) => {
      await admit(db);
      expect(await annualAdmissions(db)).toHaveLength(1);
      const policy = await at(db);
      expect(policy.domains.individual.allowed_years).toEqual([
        2024, 2025, 2026,
      ]);
      expect(policy.domains.medicare.allowed_years).toEqual([2024, 2025]);
    });
  });
  it("negative control: a claimed year cannot relabel a published import", async () => {
    await rollback(async (db) => {
      await admit(db, 2027);
      await expect(annualAdmissions(db)).rejects.toThrow(
        "annual_admission_dependency_invalid",
      );
      await expect(at(db)).rejects.toMatchObject({
        error: { code: "data_policy_unavailable" },
      });
    });
  });
  it("negative control: a quarantined dependency cannot advance the window", async () => {
    await rollback(async (db) => {
      await admit(db);
      const file = (
        await db.query<{ snapshot_id: string }>(
          "SELECT snapshot_id FROM puf_import_file WHERE import_id=$1 LIMIT 1",
          [h.report.import_id],
        )
      ).rows[0]!;
      await db.query(
        "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1",
        [file.snapshot_id],
      );
      await expect(annualAdmissions(db)).rejects.toThrow(
        "annual_admission_dependency_invalid",
      );
    });
  });
});

afterEach(() => vi.useRealTimers());
it("uses exactly the same policy manifest in REST, MCP and the status host", async () => {
  const now = () => Date.parse("2026-11-19T00:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now());
  const config = loadConfig({});
  const response = await createApp(h.db, {}, { config }).request(
    "/v1/data-policy",
  );
  expect(response.status).toBe(200);
  const policy: unknown = await response.json();
  const status = createStatusHost(config, { database: h.db }, () => undefined);
  expect(await status.dataPolicy!(h.db)).toEqual(policy);
  const tool = await callTool(
    { db: h.db, data: config.data, now },
    "get_data_status",
    {},
  );
  const output = tool.structuredContent as { data: { data_policy: unknown } };
  expect(output.data.data_policy).toEqual(policy);
});

it("keeps a late state on the admitted federal window while Medicare waits", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2025-11-19T00:00:00Z"));
  await rollback(async (db) => {
    await admit(db);
    const app = createApp(db, {}, { config: loadConfig({}) });
    const tx = await app.request("/v1/plans?county=48201&year=2026");
    expect(tx.status).toBe(200);
    expect(await tx.json()).toMatchObject({ status: "available", year: 2026 });
    const ny = await app.request("/v1/plans?county=36061&year=2026");
    expect(ny.status).toBe(200);
    expect(await ny.json()).toMatchObject({
      status: "unknown",
      year: 2026,
      plans: [],
    });
    const policy = await at(db);
    expect(policy.domains.individual.allowed_years).toEqual([2024, 2025, 2026]);
    expect(policy.domains.medicare.allowed_years).toEqual([2024, 2025]);
    expect((await app.request("/v1/plans?county=36061&year=2023")).status).toBe(
      404,
    );
  });
});
