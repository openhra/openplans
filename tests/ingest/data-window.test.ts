import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FeedSource } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { withDataPolicy } from "../../src/services/data-window.js";
import { resolveAnnualPolicy } from "../../src/domain/data-window.js";
import {
  requireImportRows,
  AnnualImportSkipped,
  planAnnualWork,
} from "../../src/ingest/data-window.js";
import { acquirePufs, runPufAcquire } from "../../src/ingest/puf/acquire.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import type { ImportFile } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import {
  importAllStates,
  partitionPufs,
} from "../../src/ingest/puf/import-batch.js";
import { importSbe } from "../../src/ingest/sbe/import.js";
import { acquireSbe } from "../../src/ingest/sbe/source.js";
import { importFormulary } from "../../src/ingest/qhp/formulary.js";
import { importProviders } from "../../src/ingest/qhp/provider.js";
import { ingestQhpBatch } from "../../src/ingest/qhp/formulary-batch.js";
import { discoverQhp } from "../../src/ingest/qhp/discover.js";
import { acquireQhpChildren } from "../../src/ingest/qhp/formulary-acquire.js";
import { discover, acquireArchive } from "../../src/ingest/medicare/acquire.js";
import type { CachedArchive } from "../../src/ingest/medicare/acquire.js";
import { importLandscape } from "../../src/ingest/medicare/landscape.js";
import { importPbp } from "../../src/ingest/medicare/pbp.js";
import { importStars } from "../../src/ingest/medicare/stars.js";
import { importCrosswalk } from "../../src/ingest/medicare/crosswalk.js";
import { importServiceArea } from "../../src/ingest/medicare/county-codes.js";
import {
  acquireSpuf,
  importSpuf,
  stageLargeTable,
} from "../../src/ingest/medicare/spuf.js";
import type { SpufArchive } from "../../src/ingest/medicare/spuf.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { ingestStateRates } from "../../src/ingest/state/index.js";
import { runWorker } from "../../src/worker/commands.js";
import { bootstrapPlan, executeBootstrap } from "../../src/worker/bootstrap.js";
import { preparedQhpFetcher } from "../../src/worker/qhp-profile.js";
import { runFeedSource } from "../../src/plugins/sources/feed.js";
import { planFreshness } from "../../src/fetch/freshness.js";
import { withMutantFile, importMutant } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

const at = <T>(run: () => T, date = "2027-01-01T00:00:00Z") =>
  withDataPolicy({ historyYears: 3 }, run, new Date(date));
const output = () => {
  const lines: string[] = [];
  return { lines, out: (value: string) => lines.push(value), error: vi.fn() };
};
function untouchedDatabase() {
  const query = vi.fn(async () => {
    throw new Error("synthetic unexpected database use");
  });
  const db = {
    query,
    exec: query,
    transaction: query,
    close: query,
  } as unknown as Database;
  return { db, query };
}
const scratch: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "openplans-annual-admission-"));
  scratch.push(path);
  return path;
}
afterEach(async () => {
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("uses the serving resolver with a build purpose without admitting an unfinished next year", () => {
  at(() => {
    expect(
      planAnnualWork("synthetic", [2024, 2025, 2026, 2027, 2028, 2029]),
    ).toEqual({
      years: [2026, 2027, 2028],
      allowed_years: [2026, 2027, 2028],
      skipped: [2024, 2025, 2029].map((year) => ({
        dataset: "synthetic",
        year,
        reason: "outside_data_window",
      })),
    });
    expect(
      resolveAnnualPolicy(
        3,
        [],
        { individual: [2028], medicare: [] },
        new Date("2027-01-01Z"),
      ).domains.individual.allowed_years,
    ).toEqual([2026, 2027]);
  });
});

it("skips an explicit fourth-year acquisition before any transport or cache access", async () => {
  const fetcher = vi.fn();
  await at(async () => {
    await expect(acquirePufs({ year: 2025, fetcher })).rejects.toBeInstanceOf(
      AnnualImportSkipped,
    );
    const transport = vi.fn();
    const archive: SpufArchive = {
      kind: "quarterly",
      year: 2025,
      label: "20251001",
      url: "https://data.cms.gov/synthetic.zip",
    };
    await expect(
      acquireSpuf(archive, { dependencies: { transport } }),
    ).rejects.toBeInstanceOf(AnnualImportSkipped);
    await expect(
      discover("landscape", 2025, { dependencies: { transport } }),
    ).rejects.toBeInstanceOf(AnnualImportSkipped);
    const medicare = {
      family: "landscape" as const,
      year: 2025,
      label: "202510",
      url: "https://www.cms.gov/synthetic.zip",
    };
    await expect(
      acquireArchive(medicare, { dependencies: { transport } }),
    ).rejects.toBeInstanceOf(AnnualImportSkipped);
    await expect(
      acquireSbe(
        { state: "CA", year: 2025, url: "https://www.cms.gov/synthetic.zip" },
        "/nonexistent",
      ),
    ).rejects.toBeInstanceOf(AnnualImportSkipped);
    expect(transport).not.toHaveBeenCalled();
  });
  expect(fetcher).not.toHaveBeenCalled();
});

async function rejectedFileContract(run: typeof importPufs) {
  const root = await directory();
  // Synthetic rejected source. Its body is deliberately invalid and must never be parsed or hashed.
  const path = join(root, "synthetic-fourth-year.csv");
  await writeFile(path, 'BusinessYear,StateCode\n"unterminated synthetic body');
  let payloadReads = 0;
  const files = IMPORT_KINDS.map((kind) => ({
    kind,
    get path() {
      payloadReads++;
      return path;
    },
    format: "csv",
    sha256: "0".repeat(64),
    bytes: 1,
    retrievedAt: "2025-01-01T00:00:00Z",
    url: "https://synthetic.example/fourth-year.csv",
  })) as ImportFile[];
  const { db, query } = untouchedDatabase();
  await at(async () => {
    const dry = output();
    const open = vi.fn();
    expect(
      await runWorker(
        [
          "ingest",
          "puf",
          "import",
          "--year",
          "2025",
          "--state",
          "TX",
          "--dry-run",
        ],
        open,
        dry,
      ),
    ).toBe(0);
    const manifest = JSON.parse(dry.lines[0]!) as {
      skipped: { dataset: string; year: number; reason: string }[];
    };
    expect(manifest.skipped).toEqual([
      { dataset: "puf", year: 2025, reason: "outside_data_window" },
    ]);
    await expect(
      run(db, { year: 2025, state: "TX", dataDir: root, files }),
    ).rejects.toMatchObject({ skip: manifest.skipped[0] });
    expect(open).not.toHaveBeenCalled();
  });
  expect(payloadReads).toBe(0);
  expect(query).not.toHaveBeenCalled();
}
it("skips a fourth-year source already on disk without even reading its header", async () => {
  await rejectedFileContract(importPufs);
});
it("negative control: removing the PUF resolver guard fails the zero-read/write contract", async () => {
  const file = new URL("../../src/ingest/puf/import.ts", import.meta.url);
  const mutant = replaceSyntax(
    await readFile(file, "utf8"),
    'requireImportYear("puf", options.year);',
    "",
  );
  await withMutantFile(file, mutant, async (url) => {
    const module = await importMutant<{ importPufs: typeof importPufs }>(
      url,
      "importPufs",
    );
    await expect(rejectedFileContract(module.importPufs)).rejects.toThrow();
  });
});

describe("direct annual importer admission", () => {
  const scope = { year: 2025, state: "TX", issuer: "00000" };
  const archive = {
    archive: { family: "landscape", year: 2025 },
    path: "/nonexistent",
  } as CachedArchive;
  const spuf = {
    archive: { kind: "quarterly", year: 2025 },
    path: "/nonexistent",
  } as Parameters<typeof importSpuf>[1];
  for (const [name, run] of [
    ["all-state PUF", (db: Database) => importAllStates(db, { year: 2025 })],
    ["PUF partitions", () => partitionPufs([], ["TX"], 2025, "/nonexistent")],
    ["state catalog", (db: Database) => importSbe(db, scope)],
    ["QHP discovery", (db: Database) => discoverQhp(db, scope)],
    ["QHP formulary", (db: Database) => importFormulary(db, scope)],
    ["QHP providers", (db: Database) => importProviders(db, scope)],
    [
      "QHP children",
      (db: Database) => acquireQhpChildren(db, scope, "provider_urls"),
    ],
    ["QHP batch", (db: Database) => ingestQhpBatch(db, "providers", scope)],
    ["rating areas", (db: Database) => ingestGeo(db, { planYear: 2025 })],
    ...[
      importLandscape,
      importPbp,
      importStars,
      importCrosswalk,
      importServiceArea,
    ].map((run) => [run.name, (db: Database) => run(db, archive)] as const),
    ["Part D", (db: Database) => importSpuf(db, spuf)],
    [
      "Part D staged pricing",
      (db: Database) => stageLargeTable(db, spuf, "pricing"),
    ],
  ] as const) {
    it(`refuses ${name} before payload or database access`, async () => {
      const { db, query } = untouchedDatabase();
      await at(async () => {
        await expect(run(db)).rejects.toBeInstanceOf(AnnualImportSkipped);
      });
      expect(query).not.toHaveBeenCalled();
    });
  }
});

it("prepared JSON documents skip their source rows and all database writes", async () => {
  const path = join(await directory(), "synthetic-excluded.json");
  await writeFile(path, '{"plan_year":2025,"rows":"synthetic invalid payload');
  const { db, query } = untouchedDatabase();
  await at(async () => {
    await expect(ingestStateRates(db, path, "NY")).rejects.toBeInstanceOf(
      AnnualImportSkipped,
    );
    await expect(ingestRatingRules(db, path)).rejects.toBeInstanceOf(
      AnnualImportSkipped,
    );
  });
  expect(query).not.toHaveBeenCalled();
});

it("CLI dry-run and execution produce the same skip manifest before opening the database", async () => {
  const open = vi.fn();
  for (const args of [
    ["ingest", "puf", "import", "--year", "2025", "--state", "TX"],
    [
      "ingest",
      "qhp",
      "providers",
      "--year",
      "2025",
      "--state",
      "TX",
      "--all-readable",
    ],
    ["ingest", "medicare", "import", "--year", "2025"],
  ]) {
    const dry = output(),
      real = output();
    await at(async () => {
      expect(await runWorker([...args, "--dry-run"], open, dry)).toBe(0);
      expect(await runWorker(args, open, real)).toBe(0);
    });
    expect(JSON.parse(dry.lines[0]!)).toEqual(JSON.parse(real.lines[0]!));
    expect(dry.error).not.toHaveBeenCalled();
    expect(real.error).not.toHaveBeenCalled();
  }
  expect(open).not.toHaveBeenCalled();
});

it("bootstrap dry-run and execution share the same synthetic rejected-source plan", async () => {
  const open = vi.fn();
  const options = {
    states: ["TX"],
    years: [2025],
    drugs: true,
    providers: true,
    geocode: true,
    nuccTaxonomy: true,
    dryRun: false,
  };
  await at(async () => {
    const steps = await bootstrapPlan(options, open, "/nonexistent");
    const dry = await executeBootstrap(steps, output(), true);
    const real = await executeBootstrap(steps, output());
    expect(dry.skipped).toEqual([
      { dataset: "bootstrap", year: 2025, reason: "outside_data_window" },
    ]);
    expect(real.skipped).toEqual(dry.skipped);
    expect(real.passed).toBe(true);
  });
  expect(open).not.toHaveBeenCalled();
});

it("refuses a source plugin's excluded year before planning, discovery fetches or storage", async () => {
  const plan = vi.fn(),
    open = vi.fn(),
    transport = vi.fn();
  const source: FeedSource = {
    kind: "feed",
    id: "synthetic-annual",
    publisher: "Synthetic fixture",
    hosts: ["synthetic.example"],
    dataScope: { kind: "annual", domain: "individual", years: () => [2025] },
    command: {
      argv: ["ingest", "synthetic-annual"],
      usage: "synthetic",
      args: z.tuple([]),
    },
    plan,
    stage: vi.fn(),
    validate: vi.fn(),
  };
  await at(async () => {
    const real = output(),
      dry = output();
    expect(
      await runFeedSource(source, [], open, {
        output: real,
        transport,
        now: () => new Date("2027-01-01Z"),
      }),
    ).toBe(1);
    expect(
      await runFeedSource(source, [], open, {
        output: dry,
        transport,
        now: () => new Date("2027-01-01Z"),
        dryRun: true,
      }),
    ).toBe(0);
    expect(JSON.parse(real.lines[0]!)).toEqual(JSON.parse(dry.lines[0]!));
    expect(real.error).toHaveBeenCalledWith(
      expect.stringContaining("outside_data_window"),
    );
  });
  expect(plan).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("refuses a prepared feed's requested year before attempting to read pinned bytes", async () => {
  const fetch = preparedQhpFetcher({
    schema: 1,
    providers: true,
    drugs: false,
    taxonomy_names: false,
    scopes: [{ state: "TX", year: 2025 }],
    provider_feeds: [],
    feed_raw: [
      {
        source: "qhp-00000-2025-index",
        url: "https://synthetic.example/index.json",
        sha256: "0".repeat(64),
        bytes: 1,
      },
    ],
  });
  await at(async () => {
    for (const source of [
      "qhp-00000-2025-index",
      "qhp-00000-2025-provider_urls",
      "qhp-provider-00000-2025-TX",
    ])
      await expect(
        fetch("https://synthetic.example/index.json", {
          expectedContent: "json",
          source,
          allowHosts: ["synthetic.example"],
          dataDir: "/nonexistent",
        }),
      ).rejects.toBeInstanceOf(AnnualImportSkipped);
  });
});

it("drops the leaving year from annual freshness jobs at UTC rollover", async () => {
  const target = {
    family: "cms-exchange-puf:2025",
    url: "https://download.cms.gov/marketplace-puf/2025/rate-puf.zip",
    mode: "head" as const,
  };
  const before = planFreshness(
    [target],
    new Map(),
    Date.parse("2026-12-31T23:59:59Z"),
  );
  const after = planFreshness([target], new Map(), Date.parse("2027-01-01Z"));
  expect(before[0]).toMatchObject({ reason: "not_admitted" });
  expect(after[0]).toMatchObject({
    reason: "outside_data_window",
    skipped: [
      { dataset: target.family, year: 2025, reason: "outside_data_window" },
    ],
  });
});

it("refuses a developer copy batch containing an excluded embedded plan year", () => {
  at(() => {
    expect(() =>
      requireImportRows("synthetic-copy", [
        { plan_year: 2026 },
        { plan_year: 2025 },
      ]),
    ).toThrow(AnnualImportSkipped);
    expect(() =>
      requireImportRows("synthetic-copy", [{ contract_year: 2025 }]),
    ).toThrow(AnnualImportSkipped);
    expect(() =>
      requireImportRows("synthetic-copy", [
        { vintage: 2020 },
        { plan_year: 2026 },
      ]),
    ).not.toThrow();
  });
});

it("does not treat a current feed's edition year as a plan year", async () => {
  const source: FeedSource = {
    kind: "feed",
    id: "synthetic-current",
    publisher: "Synthetic fixture",
    hosts: ["synthetic.example"],
    dataScope: { kind: "current" },
    command: {
      argv: ["ingest", "synthetic-current"],
      usage: "synthetic",
      args: z.tuple([z.literal("--year"), z.literal("2020")]),
    },
    plan: vi.fn(),
    stage: vi.fn(),
    validate: vi.fn(),
  };
  const out = output();
  expect(
    await at(() =>
      runFeedSource(
        source,
        ["--year", "2020"],
        vi.fn<() => Promise<Database>>(),
        {
          output: out,
          dryRun: true,
        },
      ),
    ),
  ).toBe(0);
  expect(JSON.parse(out.lines[0]!)).toEqual({
    current_generation: "synthetic-current",
    skipped: [],
  });
});

it("reports every default acquisition year when all of them have left the window", async () => {
  const out = output();
  await at(async () => {
    expect(await runPufAcquire(["--dry-run"], out)).toBe(0);
  }, "2029-01-01Z");
  expect(JSON.parse(out.lines[0]!)).toEqual({
    planned: [],
    skipped: [2026, 2027].map((year) => ({
      dataset: "puf",
      year,
      reason: "outside_data_window",
    })),
  });
});

it("does not run the cache rebuild hook after skipping a prepared source document", async () => {
  const path = join(await directory(), "synthetic-skipped-state.json");
  await writeFile(path, '{"plan_year":2025,"rows":"synthetic invalid payload');
  const open = vi.fn();
  const out = output();
  vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS", "on");
  try {
    expect(
      await at(() =>
        runWorker(
          ["ingest", "state", "--state", "NY", "--file", path],
          open,
          out,
        ),
      ),
    ).toBe(0);
    expect(JSON.parse(out.lines[0]!)).toEqual({
      skipped: [
        { dataset: "state-rates", year: 2025, reason: "outside_data_window" },
      ],
    });
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("Part D dry runs read metadata only and never open an import database", async () => {
  const root = await directory();
  const source = "cms-partd-spuf-quarterly";
  const url =
    "https://data.cms.gov/sites/default/files/2026-10/synthetic/SPUF_2026_20261007.zip";
  const hash = "0".repeat(64);
  await mkdir(join(root, "raw", source), { recursive: true });
  await writeFile(
    join(root, "raw", source, `${hash}.meta.json`),
    JSON.stringify({
      source,
      url,
      snapshot_id: hash,
      sha256: hash,
      fetched_at: "2026-11-01T00:00:00Z",
    }),
  );
  const open = vi.fn();
  vi.stubEnv("OPENPLANS_DATA_DIR", root);
  try {
    for (const args of [
      ["import", "--kind", "quarterly"],
      ["acquire", "--url", url],
    ]) {
      const out = output();
      expect(
        await at(
          () =>
            runWorker(
              ["ingest", "medicare", "part-d", ...args, "--dry-run"],
              open,
              out,
            ),
          "2026-11-19Z",
        ),
      ).toBe(0);
      expect(JSON.parse(out.lines[0]!)).toEqual({
        planned: [{ dataset: "partd-quarterly", year: 2026 }],
        skipped: [],
      });
      expect(out.error).not.toHaveBeenCalled();
    }
  } finally {
    vi.unstubAllEnvs();
  }
  expect(open).not.toHaveBeenCalled();
});

it("prepared document dry runs and excluded cache builds stop before opening a database", async () => {
  const path = join(await directory(), "synthetic-year-header.json");
  await writeFile(
    path,
    JSON.stringify({ plan_year: 2026, rows: "Synthetic header-only plan" }),
  );
  const open = vi.fn();
  for (const args of [
    ["ingest", "state", "--state", "NY", "--file", path],
    ["ingest", "rating-rules", "--file", path],
    ["prebuild", "lowest-premiums", "--years", "2025"],
  ]) {
    const out = output();
    expect(await at(() => runWorker([...args, "--dry-run"], open, out))).toBe(
      0,
    );
    expect(out.error).not.toHaveBeenCalled();
    expect(out.lines).toHaveLength(1);
  }
  expect(open).not.toHaveBeenCalled();
});

it("filters excluded years before matching a prepared profile to requested scopes", async () => {
  const root = await directory();
  const path = join(root, "synthetic-prepared.json");
  const open = vi.fn();
  for (const years of [[2026], [2025, 2026]]) {
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        providers: true,
        drugs: false,
        taxonomy_names: false,
        scopes: years.map((year) => ({ state: "TX", year })),
        provider_feeds: [
          { issuer: "00000", state: "TX", set: "qhp-00000-2026-index" },
        ],
        feed_raw: [
          {
            source: "qhp-00000-2026-index",
            url: "https://synthetic.example/index.json",
            sha256: "0".repeat(64),
            bytes: 1,
          },
        ],
      }),
    );
    const steps = await at(() =>
      bootstrapPlan(
        {
          states: ["TX"],
          years: [2025, 2026],
          providers: true,
          drugs: false,
          nuccTaxonomy: false,
          geocode: false,
          dryRun: true,
          qhpProfile: path,
          qhpCacheOnly: true,
        },
        open,
        root,
      ),
    );
    expect(steps.find((step) => step.id === "skip-2025")?.annual_skip).toEqual({
      dataset: "bootstrap",
      year: 2025,
      reason: "outside_data_window",
    });
    expect(steps.some((step) => step.id === "puf-TX-2026")).toBe(true);
    expect(steps.some((step) => step.id.includes("TX-2025"))).toBe(false);
  }
  expect(open).not.toHaveBeenCalled();
});
