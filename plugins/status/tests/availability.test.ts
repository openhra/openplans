import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { loadConfig } from "../../../src/config/index.js";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../../src/ingest/rating-rules/index.js";
import { loadPlugins } from "../../../src/plugins/index.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import { fixtureFiles as geoFiles } from "../../../tests/ingest/geo/helpers.js";
import { fixtureFiles } from "../../../tests/api/helpers.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";
import { AVAILABILITY_KINDS, AVAILABILITY_STATUSES } from "../src/views.js";

// One fixture database answers both routes: the PUF import fixture with rates, rating
// geography and rating rules, plus synthetic manifest rows the core derives further.
const OPERATOR = "synthetic-operator-secret";
const indexFile = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const readFile = fileURLToPath(new URL("../src/read.ts", import.meta.url));
const shipped = fileURLToPath(
  new URL("../../../data/access/federal-publishers.json", import.meta.url),
);
const API_KEYS = {
  catalog: "catalog_status",
  premium: "premium_status",
  provider: "provider_status",
  formulary: "formulary_status",
} as const;

let db: Database;
let directory: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  db = testDatabase(new PGlite());
  directory = await mkdtemp(join(tmpdir(), "openplans-status-availability-"));
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  const imported = await importPufs(db, {
    year: 2026,
    state: "TX",
    files: await fixtureFiles(directory),
    dataDir: directory,
  });
  expect(imported.status).toBe("ACTIVE");
  await ingestRatingRules(db);
  // Synthetic manifest rows: one not yet verified, one stale with a partial premium.
  await db.exec(`
    INSERT INTO source (source_id, publisher, source_kind)
      VALUES ('synthetic-status', 'Synthetic publisher', 'synthetic');
    INSERT INTO snapshot (snapshot_id, source_id, sha256, retrieved_at, expected_children,
        fetched_children, validation_state, activated_at, raw_path, requested_url)
      VALUES ('synthetic-status.1', 'synthetic-status', '${"c".repeat(64)}', now(), 0, 0,
        'ACTIVE', now(), '/srv/synthetic/raw/status', 'https://synthetic.invalid/status');
    INSERT INTO data_availability (state, plan_year, market, issuer_id, catalog_status,
        premium_status, provider_status, formulary_status, snapshot_id) VALUES
      ('VT', 2025, 'individual', '22222', 'not_yet_verified', 'not_yet_verified',
        'not_yet_verified', 'not_yet_verified', 'synthetic-status.1'),
      ('VT', 2025, 'individual', NULL, 'stale', 'partial', 'unknown', 'unknown',
        'synthetic-status.1');
  `);
});
afterAll(async () => {
  await db.close();
  await cleanup();
  await rm(directory, { recursive: true, force: true });
});

async function api(file = indexFile) {
  const lines: string[] = [];
  const config = loadConfig(
    { OPENPLANS_OPERATOR_TOKEN: OPERATOR },
    { version: 1, plugins: [{ package: file }] },
  );
  const loaded = await loadPlugins(config, "api", {
    env: {},
    statusHost: { database: db },
    manifestPaths: [shipped],
    writeLog: (line) => lines.push(line),
    exit: (code) => {
      throw new Error(`exit ${code}: ${lines.join(" ")}`);
    },
  });
  return createApp(
    db,
    { premiumToken: undefined, trustedProxies: [] },
    {
      store: new MemoryCache(1024 * 1024),
      config,
      plugins: loaded.registries,
    },
  );
}

type Kind = (typeof AVAILABILITY_KINDS)[number];
type Statuses = Record<Kind, string>;
const scope = (row: {
  state: string;
  year: number;
  market: string | null;
  issuer_id: string | null;
}) => [row.state, row.year, row.market, row.issuer_id].join("|");

/** Both answers from the same database: the API rows by scope, and the plugin's two views. */
async function answers(file = indexFile) {
  const app = await api(file);
  const apiRows = (await (
    await app.request("/v1/data-availability")
  ).json()) as Record<string, unknown>[];
  const fromApi = new Map<string, Statuses>(
    apiRows.map((row) => [
      scope({
        state: String(row.state),
        year: Number(row.plan_year),
        market: row.market === null ? null : String(row.market),
        issuer_id: row.issuer_id === null ? null : String(row.issuer_id),
      }),
      Object.fromEntries(
        AVAILABILITY_KINDS.map((kind) => [kind, String(row[API_KEYS[kind]])]),
      ) as Statuses,
    ]),
  );
  const publicBody = await (await app.request("/status.json")).json();
  const operatorBody = await (
    await app.request("/status/operator.json", {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    })
  ).json();
  const fromPlugin = new Map<string, Statuses>(
    (
      operatorBody.data.issuers as (Statuses & {
        state: string;
        year: number;
        market: string | null;
        issuer_id: string | null;
      })[]
    ).map((row) => [
      scope(row),
      Object.fromEntries(
        AVAILABILITY_KINDS.map((kind) => [kind, row[kind]]),
      ) as Statuses,
    ]),
  );
  return { apiRows, fromApi, fromPlugin, publicBody };
}

/** The public view's numbers, recomputed from the API rows. */
function expectedPublic(apiRows: Record<string, unknown>[]) {
  const counts = Object.fromEntries(
    AVAILABILITY_KINDS.map((kind) => [
      kind,
      Object.fromEntries(AVAILABILITY_STATUSES.map((s) => [s, 0])),
    ]),
  ) as Record<Kind, Record<string, number>>;
  for (const row of apiRows)
    for (const kind of AVAILABILITY_KINDS)
      counts[kind][String(row[API_KEYS[kind]])]! += 1;
  return {
    states: new Set(apiRows.map((row) => row.state)).size,
    years: [...new Set(apiRows.map((row) => Number(row.plan_year)))].sort(
      (a, b) => a - b,
    ),
    status_counts: counts,
  };
}

/** Every disagreement between the plugin and the API, by scope and status kind. */
function disagreements(result: Awaited<ReturnType<typeof answers>>) {
  const out: string[] = [];
  for (const key of new Set([
    ...result.fromApi.keys(),
    ...result.fromPlugin.keys(),
  ])) {
    const a = result.fromApi.get(key);
    const p = result.fromPlugin.get(key);
    if (!a || !p) {
      out.push(`${key}: ${a ? "missing from status" : "missing from api"}`);
      continue;
    }
    for (const kind of AVAILABILITY_KINDS)
      if (a[kind] !== p[kind])
        out.push(`${key} ${kind}: ${p[kind]} != ${a[kind]}`);
  }
  if (
    JSON.stringify(result.publicBody.data) !==
    JSON.stringify(expectedPublic(result.apiRows))
  )
    out.push("public data summary");
  return out;
}

describe("status availability matches /v1/data-availability", () => {
  it("the fixture is one where the stored table and the derived statuses differ", async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT state, plan_year, market, issuer_id, catalog_status, premium_status,
              provider_status, formulary_status FROM data_availability`,
    );
    const { fromApi } = await answers();
    const differing = rows.filter((row) => {
      const derived = fromApi.get(
        scope({
          state: String(row.state),
          year: Number(row.plan_year),
          market: String(row.market),
          issuer_id: row.issuer_id === null ? null : String(row.issuer_id),
        }),
      );
      return (
        !derived ||
        AVAILABILITY_KINDS.some((kind) => derived[kind] !== row[API_KEYS[kind]])
      );
    });
    expect(differing.length).toBeGreaterThan(0);
    // The imported issuer rates, as quotes do: premium is derived, not stored.
    expect(
      [...fromApi.values()].some(
        (statuses) => statuses.premium === "available",
      ),
    ).toBe(true);
  });

  it("agrees for every scope on every status the public view shows", async () => {
    const result = await answers();
    expect(result.fromApi.size).toBeGreaterThan(2);
    expect(result.fromPlugin.size).toBe(result.apiRows.length);
    expect(disagreements(result)).toEqual([]);
    expect(result.publicBody.data).toEqual(expectedPublic(result.apiRows));
  });

  it("planted mutant: the plugin reading the stored table again fails the agreement", async () => {
    const read = await plantMutant(
      readFile,
      "const service = host.dataAvailability;",
      `const service = async (session: SqlSession) =>
        (await session.query(
          "SELECT state, plan_year AS year, market, issuer_id, catalog_status AS catalog, " +
            "premium_status AS premium, provider_status AS provider, " +
            "formulary_status AS formulary, snapshot_id FROM data_availability",
        )).rows as never[];`,
    );
    const index = await plantMutant(
      indexFile,
      'import { readStatus } from "./read.js";',
      `import { readStatus } from ${JSON.stringify(read.path)};`,
    );
    try {
      const found = disagreements(await answers(index.path));
      // The rehearsal's symptom: stored premium `unsupported` where the API rates it.
      expect(found).toContainEqual(
        expect.stringMatching(/ premium: unsupported != available$/),
      );
      expect(found).toContain("public data summary");
    } finally {
      await index.cleanup();
      await read.cleanup();
    }
  });
});
