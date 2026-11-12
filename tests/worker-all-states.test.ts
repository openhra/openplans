import type * as PufSource from "../src/ingest/puf/import-source.js";
import type * as PufBatch from "../src/ingest/puf/import-batch.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.js";
vi.mock("../src/db/migrate.js", () => ({
  migrate: vi.fn(),
  migrationsDirectory: "synthetic-migrations",
}));
vi.mock("../src/ingest/geo/index.js", () => ({ ingestGeo: vi.fn() }));
vi.mock("../src/ingest/puf/import-source.js", async (original) => ({
  ...(await original<typeof PufSource>()),
  cachedImportFiles: vi.fn(),
}));
vi.mock("../src/ingest/puf/import-batch.js", async (original) => ({
  ...(await original<typeof PufBatch>()),
  pufStates: vi.fn(),
  importAllStates: vi.fn(),
}));
import { runWorker } from "../src/worker/commands.js";
import { ingestGeo } from "../src/ingest/geo/index.js";
import { cachedImportFiles } from "../src/ingest/puf/import-source.js";
import { pufStates, importAllStates } from "../src/ingest/puf/import-batch.js";
import { migrate } from "../src/db/migrate.js";
import { CMS_COUNTY_SPELLINGS } from "../src/ingest/geo/states.js";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());
const output = () => ({ out: vi.fn(), error: vi.fn() });
const database = () => ({ close: vi.fn() }) as unknown as Database;
const report = {
  state: "AK",
  planYear: 2027,
  zctaCountyRows: 1,
  zctaCentroidRows: 1,
  ratingAreaRows: 1,
  snapshots: {
    relationship: "synthetic",
    centroids: "synthetic",
    ratingAreas: "synthetic",
  },
  ratingAreaBasis: "current_cms_table" as const,
};

it.each([[], ["--state", "TX"]])(
  "defaults the legacy invocation %j through the same dispatcher",
  async (...flags) => {
    const db = database(),
      log = output();
    vi.mocked(ingestGeo).mockResolvedValue({
      ...report,
      state: "TX",
      planYear: 2026,
    });
    expect(await runWorker(["ingest", "geo", ...flags], () => db, log)).toBe(0);
    expect(migrate).toHaveBeenCalledWith(db, "synthetic-migrations");
    expect(ingestGeo).toHaveBeenCalledWith(db, { state: "TX", planYear: 2026 });
    expect(JSON.parse(log.out.mock.calls[0]![0]).state).toBe("TX");
    expect(log.error).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  },
);

it("hides raw source and driver errors from a single-state geo import", async () => {
  const db = database(),
    log = output();
  vi.mocked(ingestGeo).mockRejectedValue(
    new Error("synthetic private driver details"),
  );
  expect(await runWorker(["ingest", "geo"], () => db, log)).toBe(1);
  expect(log.out).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith(
    "Geography TX PY2026 failed; previous import preserved",
  );
  expect(db.close).toHaveBeenCalledOnce();
});

it.each(["AK", "FL", "NY"])(
  "dispatches explicit state %s and year through runGeo",
  async (state) => {
    const db = database(),
      log = output();
    vi.mocked(ingestGeo).mockResolvedValue({ ...report, state });
    expect(
      await runWorker(
        ["ingest", "geo", "--state", state, "--year", "2027"],
        () => db,
        log,
      ),
    ).toBe(0);
    expect(ingestGeo).toHaveBeenCalledWith(db, { state, planYear: 2027 });
    expect(migrate).toHaveBeenCalledWith(db, "synthetic-migrations");
    if (state === "NY")
      expect(CMS_COUNTY_SPELLINGS.NY).toMatchObject({ deleware: "delaware" });
    expect(log.error).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  },
);

it("discovers geo batch states from the publication, continues past failures and closes", async () => {
  const db = database(),
    log = output();
  vi.mocked(cachedImportFiles).mockResolvedValue({
    files: [],
    manifestPath: "synthetic-manifest",
  });
  vi.mocked(pufStates).mockResolvedValue(["AK", "FL"]);
  vi.mocked(ingestGeo)
    .mockRejectedValueOnce(new Error("synthetic private driver details"))
    .mockResolvedValueOnce({ ...report, state: "FL" });
  expect(
    await runWorker(
      ["ingest", "geo", "--all-states", "--year", "2027"],
      () => db,
      log,
    ),
  ).toBe(1);
  expect(pufStates).toHaveBeenCalledWith([], 2027);
  expect(ingestGeo).toHaveBeenNthCalledWith(2, db, {
    state: "FL",
    planYear: 2027,
  });
  expect(log.error).toHaveBeenCalledWith(
    "Geography AK PY2027 failed; previous import preserved",
  );
  expect(JSON.parse(log.out.mock.calls[0]![0]).state).toBe("FL");
  expect(db.close).toHaveBeenCalledOnce();
});

it.each([
  ["--state", "AK", "--all-states"],
  ["--state", "XX"],
  ["--state"],
  ["extra"],
  ["--year", "2028"],
  ["--all-states", "--all-states"],
])("rejects invalid geo arguments before connecting: %j", async (...flags) => {
  const open = vi.fn(),
    log = output();
  expect(await runWorker(["ingest", "geo", ...flags], open, log)).toBe(1);
  expect(open).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith(
    "Usage: worker ingest geo [--year 2025|2026|2027] [--state XX | --all-states]",
  );
});

it.each([["--state", "TX"], ["--year", "2026"], ["--all-states"]])(
  "rejects %j on the national GeoNames source before connecting",
  async (...extra) => {
    const open = vi.fn(),
      log = output();
    expect(
      await runWorker(
        ["ingest", "geo", "--source", "geonames", ...extra],
        open,
        log,
      ),
    ).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "Usage: worker ingest geo --source geonames",
    );
  },
);

it("dispatches all-state PUF import, returning failure when any state failed", async () => {
  const db = database(),
    log = output();
  vi.mocked(importAllStates).mockResolvedValue({
    year: 2026,
    passed: false,
    results: [{ year: 2026, state: "AK", status: "FAILED" }],
  });
  expect(
    await runWorker(
      ["ingest", "puf", "import", "--all-states", "--year", "2026"],
      () => db,
      log,
    ),
  ).toBe(1);
  expect(importAllStates).toHaveBeenCalledWith(db, {
    year: 2026,
    onState: expect.any(Function),
  });
  expect(JSON.parse(log.out.mock.calls[0]![0]).passed).toBe(false);
  expect(db.close).toHaveBeenCalledOnce();
});

it.each([undefined, "12000", "0"])(
  "allows long PUF reconciliation while preserving explicit timeout %s",
  async (timeout) => {
    const db = database(),
      log = output(),
      open = vi.fn((_connection?: string) => db);
    // Labelled synthetic URI only; no connection is made and no credential is logged.
    const uri = new URL(
      "postgresql://synthetic:synthetic@db:5432/synthetic?application_name=synthetic-puf",
    );
    if (timeout !== undefined) uri.searchParams.set("query_timeout", timeout);
    vi.stubEnv("DATABASE_URL", uri.href);
    vi.mocked(importAllStates).mockResolvedValue({
      year: 2026,
      passed: true,
      results: [],
    });
    expect(
      await runWorker(
        ["ingest", "puf", "import", "--all-states", "--year", "2026"],
        open,
        log,
      ),
    ).toBe(0);
    const actual = new URL(open.mock.calls[0]![0]!);
    expect(actual.searchParams.get("query_timeout")).toBe(timeout ?? "300000");
    expect(actual.searchParams.get("application_name")).toBe("synthetic-puf");
    expect(process.env.DATABASE_URL).toBe(uri.href);
    expect(log.error).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  },
);
