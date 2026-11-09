import { runBootstrap } from "../../../src/worker/bootstrap.js";
import { ingestStateRates } from "../../../src/ingest/state/index.js";
import { createApp } from "../../../src/api/app.js";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { importSbe } from "../../../src/ingest/sbe/import.js";
import { discoverSbe } from "../../../src/ingest/sbe/source.js";
import { normalizeSbeRow } from "../../../src/ingest/sbe/normalize.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import type { ImportFile } from "../../../src/ingest/puf/import-source.js";
import { importPufs, plansForCounty } from "../../../src/ingest/puf/import.js";
import { dataAvailability } from "../../../src/api/availability.js";
import {
  bootstrapPlan,
  parseBootstrapOptions,
} from "../../../src/worker/bootstrap.js";

const fixture = fileURLToPath(new URL("../../fixtures/sbe/", import.meta.url));
const names = [
  "GAPlans05052026.csv",
  "GAServiceAreas05052026.csv",
  "GANetworks05052026.csv",
  "GABusinessRules05052026.csv",
  "GARates05052026.csv",
  "GABenefits05052026.csv",
];
async function files(): Promise<ImportFile[]> {
  return Promise.all(
    IMPORT_KINDS.map(async (kind, at) => {
      const path = join(fixture, names[at]!),
        bytes = await readFile(path);
      return {
        kind,
        path,
        format: "csv",
        source: "cms_sbe_puf",
        member: names[at],
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        retrievedAt: "2026-11-08T00:00:00Z",
        url: "https://www.cms.gov/files/zip/georgiasbepuf2026.zip",
      };
    }),
  );
}
async function mutation(
  inputs: ImportFile[],
  dir: string,
  kind: string,
  from: string,
  to: string,
) {
  const old = inputs.find((f) => f.kind === kind)!;
  const bytes = Buffer.from(
    (await readFile(old.path, "utf8")).replace(from, to),
  );
  const path = join(dir, `synthetic-mutant-${kind}.csv`);
  await writeFile(path, bytes);
  return inputs.map((f) =>
    f.kind === kind
      ? {
          ...f,
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        }
      : f,
  );
}

describe("SBE: real GA cuts, source normalization and protected state catalogs", () => {
  const db = testDatabase(new PGlite());
  let directory: string,
    migration: Awaited<ReturnType<typeof coreMigrations>>,
    inputs: ImportFile[],
    baseline: Awaited<ReturnType<typeof importSbe>>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openplans-sbe-test-"));
    migration = await coreMigrations();
    await migrate(db, migration.directory);
    inputs = await files();
    baseline = await importSbe(db, {
      year: 2026,
      state: "GA",
      dataDir: directory,
      files: inputs,
    });
  });
  afterAll(async () => {
    await db.close();
    await migration?.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  it("loads real plans, rates, benefits and areas without making up cost sharing", async () => {
    expect(baseline.status, JSON.stringify(baseline)).toBe("ACTIVE");
    expect(baseline.identifiers.base_plans).toBe(2);
    const row = (
      await db.query<{
        raw: Record<string, string>;
        cost_sharing_parsed: object;
      }>("SELECT raw,cost_sharing_parsed FROM plan_benefit LIMIT 1")
    ).rows[0]!;
    expect(row.raw["BENEFIT NAME"]).toBeTruthy();
    expect(row.cost_sharing_parsed).toEqual(
      Object.fromEntries(
        [
          "CopayInnTier1",
          "CopayInnTier2",
          "CopayOutofNet",
          "CoinsInnTier1",
          "CoinsInnTier2",
          "CoinsOutofNet",
        ].map((k) => [k, null]),
      ),
    );
    expect(
      (await plansForCounty(db, "13057", 2026, "Individual")).length,
    ).toBeGreaterThan(0);
    const provenance = (
      await db.query<{ registry_evidence: Record<string, string> }>(
        `SELECT registry_evidence FROM source WHERE source_id=$1`,
        ["cms_sbe_puf:2026:GA:rate"],
      )
    ).rows[0]!;
    expect(provenance.registry_evidence.member).toBe("GARates05052026.csv");
  });
  it("reports catalog source and every issuer feed as unknown with explicit reason", async () => {
    const rows = (await dataAvailability(db)).filter((r) => r.state === "GA");
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        source: "cms_sbe_puf",
        provider_coverage: {
          status: "unknown",
          reason: "sbe_no_index_registry",
        },
        drug_coverage: { status: "unknown", reason: "sbe_no_index_registry" },
      });
  });
  it("negative: invalid filed rate is rejected and previous active catalog survives", async () => {
    await expect(
      importSbe(db, {
        year: 2026,
        state: "GA",
        dataDir: directory,
        files: inputs.map((file) => ({ ...file, source: undefined })),
      }),
    ).rejects.toThrow("source/member provenance");
    const broken = await mutation(inputs, directory, "rate", "29.55", "-1.00");
    const report = await importSbe(db, {
      year: 2026,
      state: "GA",
      dataDir: directory,
      files: broken,
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some(
        (c) => c.code === "rejected_source_rows" && c.count > 0,
      ),
    ).toBe(true);
    expect(
      (
        await db.query(
          "SELECT import_id FROM puf_active_catalog WHERE state='GA'",
        )
      ).rows[0]!.import_id,
    ).toBe(baseline.import_id);
  });
  it("negative: SBE ID collision cannot overwrite a federal state row", async () => {
    const federal = await Promise.all(
      IMPORT_KINDS.map(async (kind) => {
        const path = fileURLToPath(
            new URL(`../../fixtures/puf/import/${kind}.csv`, import.meta.url),
          ),
          b = await readFile(path);
        return {
          kind,
          path,
          format: "csv" as const,
          sha256: createHash("sha256").update(b).digest("hex"),
          bytes: b.length,
          url: "https://www.cms.gov/federal.csv",
          retrievedAt: "2026-11-08T00:00:00Z",
        };
      }),
    );
    const tx = await importPufs(db, {
      year: 2026,
      state: "TX",
      files: federal,
      dataDir: directory,
    });
    expect(tx.passed).toBe(true);
    const before = JSON.stringify(
      (
        await db.query(
          "SELECT * FROM plan WHERE state='TX' ORDER BY base_plan_id",
        )
      ).rows,
    );
    const plan = JSON.parse(
      await readFile(join(fixture, "provenance.json"), "utf8"),
    ).plans[0];
    const broken = await mutation(
      inputs,
      directory,
      "plan-attributes",
      plan,
      "11718TX0140001",
    );
    expect(
      (
        await importSbe(db, {
          year: 2026,
          state: "GA",
          files: broken,
          dataDir: directory,
        })
      ).passed,
    ).toBe(false);
    expect(
      JSON.stringify(
        (
          await db.query(
            "SELECT * FROM plan WHERE state='TX' ORDER BY base_plan_id",
          )
        ).rows,
      ),
    ).toBe(before);
    expect(
      (
        await db.query(
          "SELECT import_id FROM puf_active_catalog WHERE state='TX'",
        )
      ).rows[0]!.import_id,
    ).toBe(tx.import_id);
  });
  it("NY/VT premium and plan answers remain byte-identical after SBE loads", async () => {
    const graph = await bootstrapPlan(
      parseBootstrapOptions(["--states", "NY,VT", "--years", "2026"]),
      () => db,
      directory,
      migration.directory,
      [
        { state: "NY", year: 2026 },
        { state: "VT", year: 2026 },
      ],
    );
    const filedSteps = graph.filter((step) =>
      step.id.startsWith("state-filed-"),
    );
    expect(filedSteps).toHaveLength(2);
    for (const step of filedSteps)
      await expect(step.run()).rejects.toThrow(
        "state_filed_tier_publications_not_prepared",
      );
    for (const state of ["NY", "VT"] as const) {
      const file = join(directory, `${state}.json`);
      await writeFile(
        file,
        await readFile(
          new URL(
            `../../fixtures/state/${state.toLowerCase()}-2026.json`,
            import.meta.url,
          ),
        ),
      );
      await ingestStateRates(db, file, state, { verifyRaw: false });
    }
    const answers = async () => {
      const app = createApp(db, { premiumToken: "synthetic-sbe-control" });
      const out: string[] = [];
      for (const [county, identity] of [
        ["36061", { plan_ids: ["11177NY0220001"] }],
        ["50007", { plan_keys: ["BCBSVT:Gold Plan"] }],
      ] as const) {
        out.push(
          await (
            await app.request(`/v1/plans?county=${county}&year=2026`)
          ).text(),
        );
        const response = await app.request("/v1/premium-estimates", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-sbe-control",
          },
          body: JSON.stringify({
            county,
            ...identity,
            coverage_start: "2026-01-01",
            members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
          }),
        });
        expect(response.status).toBe(200);
        const bytes = await response.text();
        expect(JSON.parse(bytes).estimates[0].status).toBe("rated");
        out.push(bytes);
      }
      out.push(
        JSON.stringify(
          (await dataAvailability(db)).filter(
            (r) => r.state === "NY" || r.state === "VT",
          ),
        ),
      );
      return out;
    };
    const before = await answers();
    for (const step of filedSteps)
      expect(await step.run()).toMatchObject({
        skipped: true,
        reason: "current_active_snapshot",
      });
    expect(
      (
        await importSbe(db, {
          year: 2026,
          state: "GA",
          dataDir: directory,
          files: inputs,
        })
      ).passed,
    ).toBe(true);
    for (const state of ["NY", "VT"]) {
      // Labelled synthetic SBE scope replacements exercise the protected serving pointer.
      const supplemental = await Promise.all(
        inputs.map(async (file) => {
          const bytes = Buffer.from(
            (await readFile(file.path, "utf8")).replace(/GA/g, state),
          );
          const path = join(
            directory,
            `synthetic-protected-${state}-${file.kind}.csv`,
          );
          await writeFile(path, bytes);
          return {
            ...file,
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          };
        }),
      );
      const report = await importSbe(db, {
        year: 2026,
        state,
        dataDir: directory,
        files: supplemental,
      });
      expect(report.passed).toBe(true);
      expect(report.serving).toBe(false);
    }
    expect(
      (
        await db.query(
          "SELECT * FROM puf_active_catalog WHERE state IN ('NY','VT')",
        )
      ).rows,
    ).toEqual([]);
    expect(await answers()).toEqual(before);
  });
  it("bootstrap chooses SBE independently of federal publication acquisition", async () => {
    const steps = await bootstrapPlan(
      parseBootstrapOptions([
        "--states",
        "GA",
        "--years",
        "2026",
        "--with-drugs",
      ]),
      () => db,
      directory,
      migration.directory,
      [{ state: "GA", year: 2026 }],
    );
    expect(steps.find((s) => s.id === "puf-acquire-2026")!.skip_reason).toBe(
      "sbe_publications_selected",
    );
    expect(steps.find((s) => s.id === "puf-GA-2026")!.depends_on).toContain(
      "sbe-acquire-GA-2026",
    );
    expect(steps.some((s) => s.id === "qhp-discover-GA-2026")).toBe(false);
    expect(
      await steps.find((s) => s.id === "qhp-sbe-GA-2026")!.run(),
    ).toMatchObject({ reason: "sbe_no_index_registry" });
  });
});

it("discovers only explicit state/year bundles and fails ambiguous publications", () => {
  const html =
    '<h3>2026 SBE QHP PUF Datasets</h3><a href="/files/zip/georgiasbepuf2026.zip">Georgia</a><h3>2025 SBE QHP PUF Datasets</h3><a href="/files/zip/georgiasbepuf2025.zip">Georgia</a>';
  expect(discoverSbe(html, 2026)).toEqual([
    {
      state: "GA",
      year: 2026,
      url: "https://www.cms.gov/files/zip/georgiasbepuf2026.zip",
    },
  ]);
  expect(discoverSbe(html, 2027)).toEqual([]);
  expect(() =>
    discoverSbe(
      html.replace(
        "<h3>2025",
        '<a href="/files/zip/georgia-other.zip">bad</a><h3>2025',
      ),
      2026,
    ),
  ).toThrow("Ambiguous");
});
it("preserves blank-age family cells and rejects malformed county labels", () => {
  expect(
    normalizeSbeRow("rate", {
      rowNumber: 2,
      recordNumber: 1,
      fields: [],
      values: { AGE: "", COUPLE: "123.45" },
    }).values,
  ).toMatchObject({ Age: "Family Option", Couple: "123.45" });
  expect(
    normalizeSbeRow("rate", {
      rowNumber: 2,
      recordNumber: 1,
      fields: [],
      values: {
        "RATE EFFECTIVE DATE": "1/1/2026",
        "RATE EXPIRATION": "12/31/2026",
      },
    }).values,
  ).toMatchObject({
    RateEffectiveDate: "2026-01-01",
    RateExpirationDate: "2026-12-31",
  });
  expect(
    normalizeSbeRow("service-area", {
      rowNumber: 2,
      recordNumber: 1,
      fields: [],
      values: { "COVER ENTIRE STATE": "TRUE", "PARTIAL COUNTY": "FALSE" },
    }).values,
  ).toMatchObject({ CoverEntireState: "Yes", PartialCounty: "No" });
  expect(() =>
    normalizeSbeRow("service-area", {
      rowNumber: 2,
      recordNumber: 1,
      fields: [],
      values: { COUNTY: "No FIPS" },
    }),
  ).toThrow();
});

it("worker bootstrap defaults an SBE-only request without --years to the published PY2026", async () => {
  const output: string[] = [];
  const code = await runBootstrap(
    ["--states", "GA", "--dry-run"],
    () => {
      throw new Error("Dry run must not open the database");
    },
    {
      out: (message) => output.push(message),
      error: (message) => {
        throw new Error(message);
      },
    },
  );
  expect(code).toBe(0);
  const summary = JSON.parse(output.at(-1)!);
  expect(
    summary.steps.find(
      (step: { id: string }) => step.id === "sbe-acquire-GA-2026",
    ),
  ).toMatchObject({ status: "planned" });
  expect(
    summary.steps.some((step: { id: string }) => step.id.includes("2027")),
  ).toBe(false);
});
