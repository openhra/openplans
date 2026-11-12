import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pluginManifestSchema } from "@openplans/plugin-sdk";
import type { FeedSource } from "@openplans/plugin-sdk";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import type { PublisherPolicy, Transport } from "../../../src/fetch/index.js";
import { runTaxonomyIngest } from "../../../src/plugins/core-plugin.js";
import { runFeedSource } from "../../../src/plugins/sources/feed.js";
import type { FeedRunOptions } from "../../../src/plugins/sources/feed.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import { coreWorkerCommands, runWorker } from "../../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";
import plugin, {
  createTaxonomySource,
  discoverRelease,
  importTaxonomy,
  TAXONOMY_USAGE,
} from "../src/index.js";

// Pacing has its own tests; these runs need no wall-clock waits.
vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

// The CSV is the committed fixture, a small cut of the official file. The files page, robots
// and terms bodies are synthetic stand-ins served by the injected transport.
const fixture = fileURLToPath(
  new URL("../../../tests/fixtures/taxonomy/nucc.csv", import.meta.url),
);
const shipped = fileURLToPath(
  new URL("../../../data/access/federal-publishers.json", import.meta.url),
);
const csvUrl = "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv";
const pagePath =
  "/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57";
const page =
  '<p>current</p><a href="/images/stories/CSV/nucc_taxonomy_261.csv">Version 26.1 7/1/26</a>' +
  '<a href="/images/stories/CSV/nucc_taxonomy_251.csv">Version 25.1</a>';
const robots = "User-agent: *\nAllow: /\n";
const terms = "Synthetic operator-reviewed terms";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
/** A fetch receipt for the fixture CSV, as `fetchToCache` writes one. */
const receipt = (sha256: string) => ({
  snapshot_id: sha256,
  source: "nucc-provider-taxonomy",
  url: csvUrl,
  final_url: csvUrl,
  redirect_chain: [],
  status: 200,
  content_type: "text/csv",
  etag: null,
  last_modified: null,
  sha256,
  bytes: csv.length,
  fetched_at: "2026-11-07T00:00:00Z",
});
const TIMESTAMPS = [
  "created_at",
  "updated_at",
  "sourced_at",
  "retrieved_at",
  "activated_at",
];

let csv: Buffer;
let core: Awaited<ReturnType<typeof coreMigrations>>;
let scratch: string;
let operator: string;
let requests: string[];
let out: string[];
let err: string[];

const transport: Transport = async (url) => {
  requests.push(url.pathname);
  const served: Record<string, string | Buffer> = {
    "/robots.txt": robots,
    "/terms": terms,
    [pagePath]: page,
    [new URL(csvUrl).pathname]: csv,
  };
  const body = served[url.pathname];
  return {
    status: body === undefined ? 404 : 200,
    headers: {},
    body: Readable.from([Buffer.from(body ?? "")]),
  };
};
const output = {
  out: (line: string) => out.push(line),
  error: (line: string) => err.push(line),
};
const runOptions = (
  dataDir: string,
  manifestPaths = [shipped, operator],
): FeedRunOptions => ({
  declaredHosts: plugin.manifest.capabilities?.network ?? [],
  dataDir,
  manifestPaths,
  transport,
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  sleep: async () => {},
  maxAttempts: 1,
});

async function freshDatabase(): Promise<{ pg: PGlite; db: Database }> {
  const pg = new PGlite();
  const db = testDatabase(pg);
  await migrate(db, core.directory);
  // The command closes the database it opened; these tests keep using it.
  return { pg, db: { ...db, close: async () => {} } };
}
const rows = async (db: Database, sql: string) =>
  (await db.query(sql)).rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !TIMESTAMPS.includes(key)),
    ),
  );
/** Everything the import writes, minus wall-clock timestamps. */
const written = async (db: Database, snapshotId: string) => ({
  source: await rows(
    db,
    "SELECT * FROM source WHERE source_id='nucc-provider-taxonomy'",
  ),
  snapshot: await rows(
    db,
    `SELECT * FROM snapshot WHERE snapshot_id='${snapshotId}'`,
  ),
  taxonomy: await rows(db, "SELECT * FROM provider_taxonomy ORDER BY code"),
});

beforeAll(async () => {
  csv = await readFile(fixture);
  core = await coreMigrations();
  scratch = await mkdtemp(join(tmpdir(), "openplans-nucc-taxonomy-"));
  operator = join(scratch, "operator.json");
  const nucc = (
    JSON.parse(await readFile(shipped, "utf8")) as {
      publishers: PublisherPolicy[];
    }
  ).publishers.find((entry) => entry.host === "www.nucc.org")!;
  await writeFile(
    operator,
    JSON.stringify({
      version: 1,
      publishers: [
        {
          ...nucc,
          state: "allowed",
          robots: {
            url: "https://www.nucc.org/robots.txt",
            status: 200,
            sha256: digest(robots),
            checkedAt: new Date().toISOString(),
          },
          jobCaps: { maxRequests: 10, maxTransferBytes: 10 * 1024 ** 2 },
          terms: {
            url: "https://www.nucc.org/terms",
            disposition: "allowed",
            sha256: digest(terms),
            reviewedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      ],
    }),
  );
}, 60_000);
afterAll(async () => {
  await core.cleanup();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
  out = [];
  err = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("NUCC taxonomy import", () => {
  it("imports published classification/display names and preserves version provenance", async () => {
    const { pg, db } = await freshDatabase();
    try {
      const sha256 = digest(csv);
      const result = await importTaxonomy(db, {
        version: "26.1",
        url: csvUrl,
        path: fixture,
        metadata: receipt(sha256),
      });
      expect(result).toMatchObject({ version: "26.1", codes: 3 });
      const row = (
        await db.query(
          `SELECT * FROM provider_taxonomy WHERE code='207Q00000X'`,
        )
      ).rows[0];
      expect(row).toMatchObject({
        classification: "Family Medicine",
        display_name: "Family Medicine Physician",
        specialization: null,
        version: "26.1",
      });
    } finally {
      await pg.close();
    }
  }, 60_000);

  it("discovers the version attached to the current official download link", () => {
    expect(discoverRelease(page)).toMatchObject({
      version: "26.1",
      url: csvUrl,
    });
  });
});

describe("worker ingest taxonomy on the feed lifecycle", () => {
  it("keeps the usage line and opens nothing on other arguments", async () => {
    const command = coreWorkerCommands.find(
      ({ argv }) => argv.join(" ") === "ingest taxonomy",
    );
    expect(command?.usage).toBe(TAXONOMY_USAGE);
    for (const flags of [
      [],
      ["--wrong"],
      ["--accept-nucc-terms", "--accept-nucc-terms"],
    ]) {
      err = [];
      const open = vi.fn();
      expect(await runTaxonomyIngest(flags, open, output, core.directory)).toBe(
        1,
      );
      expect(err).toEqual([TAXONOMY_USAGE]);
      expect(open).not.toHaveBeenCalled();
    }
  });

  // The contract the refusal tests and their mutant share.
  const refusesWithoutClearance = (
    code: number,
    opened: boolean,
    dataDir: Promise<string[]>,
  ) =>
    dataDir.then((files) => {
      expect(code).toBe(1);
      expect(opened).toBe(false);
      expect(requests).toEqual([]);
      expect(files).toEqual([]);
      expect(out).toEqual([]);
      expect(err.map((line) => JSON.parse(line))).toEqual([
        {
          source: "nucc-provider-taxonomy",
          code: "feed_run_failed",
          reason: "fetch_admission_denied",
          detail:
            "Publisher host is held by its reviewed manifest (terms-restricted)",
        },
      ]);
    });

  it("fails with the shipped manifest's reason and writes nothing without an operator manifest", async () => {
    const dataDir = await mkdtemp(join(scratch, "refused-"));
    const open = vi.fn();
    const code = await runTaxonomyIngest(
      ["--accept-nucc-terms"],
      open,
      output,
      core.directory,
      runOptions(dataDir, [shipped]),
    );
    await refusesWithoutClearance(
      code,
      open.mock.calls.length > 0,
      readdir(dataDir),
    );
    // The worker's default manifests are the shipped ones when no operator manifest is set.
    vi.stubEnv("OPENPLANS_DATA_DIR", dataDir);
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    err = [];
    const workerOpen = vi.fn();
    const workerCode = await runWorker(
      ["ingest", "taxonomy", "--accept-nucc-terms"],
      workerOpen,
      output,
      core.directory,
    );
    await refusesWithoutClearance(
      workerCode,
      workerOpen.mock.calls.length > 0,
      readdir(dataDir),
    );
  });

  it("negative control: without the feed core's host check the refusal contract fails", async () => {
    // The check lives in runFeedSource now, so every feed source gets it.
    const before =
      'if (refusal) return fail("fetch_admission_denied", refusal.message);';
    const feed = new URL(
      "../../../src/plugins/sources/feed.ts",
      import.meta.url,
    );
    const { pg, db } = await freshDatabase();
    const mutant = await plantMutant(feed, before, "void refusal;");
    try {
      const run = async (runner: typeof runFeedSource) => {
        err = [];
        requests = [];
        const dataDir = await mkdtemp(join(scratch, "mutant-"));
        const open = vi.fn(async () => db);
        const code = await runner(
          createTaxonomySource(),
          ["--accept-nucc-terms"],
          open,
          { ...runOptions(dataDir, [shipped]), output },
        );
        return refusesWithoutClearance(
          code,
          open.mock.calls.length > 0,
          readdir(dataDir),
        );
      };
      // The unmutated core holds the contract when the source runs on it directly.
      await run(runFeedSource);
      const module = (await import(mutant.path)) as {
        runFeedSource: typeof runFeedSource;
      };
      await expect(run(module.runFeedSource)).rejects.toThrow();
    } finally {
      await pg.close();
      await mutant.cleanup();
    }
  }, 60_000);

  it("refuses the source when the plugin's declared hosts leave out www.nucc.org", async () => {
    const dataDir = await mkdtemp(join(scratch, "undeclared-"));
    const open = vi.fn();
    expect(
      await runFeedSource(
        createTaxonomySource(),
        ["--accept-nucc-terms"],
        open,
        {
          ...runOptions(dataDir),
          declaredHosts: [],
          output,
        },
      ),
    ).toBe(1);
    expect(err.map((line) => JSON.parse(line))).toEqual([
      {
        source: "nucc-provider-taxonomy",
        code: "feed_run_failed",
        reason: "source_host_undeclared",
      },
    ]);
    expect(open).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  // Direct import of the same CSV path, as the command did before it ran on the feed lifecycle.
  async function sameAsDirectImport(feed: Database, sha256: string) {
    const [content] = (
      await feed.query<{ raw_path: string }>(
        "SELECT raw_path FROM snapshot WHERE sha256=$1 ORDER BY snapshot_id LIMIT 1",
        [sha256],
      )
    ).rows;
    const direct = await freshDatabase();
    try {
      const legacy = await importTaxonomy(direct.db, {
        version: "26.1",
        url: csvUrl,
        path: content?.raw_path ?? "",
        metadata: receipt(sha256),
      });
      expect(await written(feed, sha256)).toEqual(
        await written(direct.db, sha256),
      );
      return legacy;
    } finally {
      await direct.pg.close();
    }
  }

  it("writes the same rows, snapshot and output line as the direct import, then reuses the cached CSV", async () => {
    const { pg, db } = await freshDatabase();
    try {
      const dataDir = await mkdtemp(join(scratch, "ingest-"));
      const sha256 = digest(csv);
      expect(
        await runTaxonomyIngest(
          ["--accept-nucc-terms"],
          () => db,
          output,
          core.directory,
          runOptions(dataDir),
        ),
      ).toBe(0);
      expect(err).toEqual([]);
      // The old test's expectation, as the exact line the command prints.
      expect(out).toEqual([
        `{"version":"26.1","source_url":"${csvUrl}","snapshot_id":"${sha256}","codes":3}`,
      ]);
      expect(requests).toEqual([
        "/robots.txt",
        "/terms",
        pagePath,
        new URL(csvUrl).pathname,
      ]);
      const legacy = await sameAsDirectImport(db, sha256);
      expect(out[0]).toBe(JSON.stringify(legacy));
      // The CSV is kept under its hash, as the direct import kept it, not under the run id.
      const raw = join(dataDir, "raw", "nucc-provider-taxonomy");
      expect((await readdir(raw)).sort()).toEqual([
        sha256,
        `${sha256}.meta.json`,
      ]);
      expect(
        (
          await db.query<{ raw_path: string }>(
            "SELECT DISTINCT raw_path FROM snapshot WHERE source_id='nucc-provider-taxonomy'",
          )
        ).rows,
      ).toEqual([{ raw_path: join(raw, sha256, "payload") }]);
      // Provenance comes from the release snapshot; the feed's run receipt carries no rows.
      expect(
        (
          await db.query(
            "SELECT DISTINCT sourced_by, sourced_slug FROM provider_taxonomy",
          )
        ).rows,
      ).toEqual([
        { sourced_by: "nucc-provider-taxonomy", sourced_slug: sha256 },
      ]);
      const receipts = (
        await db.query<{ snapshot_id: string; validation_state: string }>(
          "SELECT snapshot_id, validation_state FROM snapshot WHERE source_id='nucc-provider-taxonomy' AND snapshot_id<>$1",
          [sha256],
        )
      ).rows;
      expect(receipts).toEqual([
        {
          snapshot_id: expect.stringMatching(
            /^nucc-provider-taxonomy\.\d{8}T\d{6}Z\.[0-9a-f]{8}\.1$/,
          ),
          validation_state: "ACTIVE",
        },
      ]);

      out = [];
      requests = [];
      expect(
        await runTaxonomyIngest(
          ["--accept-nucc-terms"],
          () => db,
          output,
          core.directory,
          runOptions(dataDir),
        ),
      ).toBe(0);
      expect(out).toEqual([JSON.stringify(legacy)]);
      expect(requests).toEqual(["/robots.txt", "/terms", pagePath]);
      await sameAsDirectImport(db, sha256);
    } finally {
      await pg.close();
    }
  }, 60_000);

  it.each([
    [
      "rows filed under the run receipt",
      "metadata: file.metadata",
      "metadata: { ...file.metadata, sha256: file.snapshotId }",
    ],
    [
      "the source left as kind 'feed'",
      `"UPDATE source SET source_kind='taxonomy' WHERE source_id=$1 AND source_kind='feed'"`,
      `"SELECT $1::text"`,
    ],
  ])(
    "negative control: the direct-import comparison catches %s",
    async (_name, before, after) => {
      const mutant = await plantMutant(
        new URL("../src/source.ts", import.meta.url),
        before,
        after,
      );
      const { pg, db } = await freshDatabase();
      try {
        const module = (await import(mutant.path)) as {
          createTaxonomySource: typeof createTaxonomySource;
        };
        const dataDir = await mkdtemp(join(scratch, "stage-mutant-"));
        const code = await runFeedSource(
          module.createTaxonomySource(),
          ["--accept-nucc-terms"],
          db,
          { ...runOptions(dataDir), output },
        );
        // A refusal before staging would make this control pass for the wrong reason.
        expect(err.join("\n")).not.toMatch(/source_host_undeclared|admission/);
        // Either the run fails or its rows differ from the direct import.
        const contract = async () => {
          expect(code).toBe(0);
          await sameAsDirectImport(db, digest(csv));
        };
        await expect(contract()).rejects.toThrow();
      } finally {
        await pg.close();
        await mutant.cleanup();
      }
    },
    60_000,
  );

  it("quarantines the run and keeps the earlier release when the CSV is invalid", async () => {
    const { pg, db } = await freshDatabase();
    const good = csv;
    try {
      const dataDir = await mkdtemp(join(scratch, "invalid-"));
      const ingest = () =>
        runTaxonomyIngest(
          ["--accept-nucc-terms"],
          () => db,
          output,
          core.directory,
          runOptions(dataDir),
        );
      expect(await ingest()).toBe(0);
      const before = await written(db, digest(good));
      csv = Buffer.from(
        "Code,Classification,Specialization,Display Name\nnot-a-code,X,,Y\n",
      );
      await rm(join(dataDir, "raw"), { recursive: true, force: true });
      out = [];
      err = [];
      expect(await ingest()).toBe(1);
      expect(out).toEqual([]);
      expect(err.map((line) => JSON.parse(line))).toEqual([
        {
          source: "nucc-provider-taxonomy",
          code: "feed_run_failed",
          reason: "stage_failed",
        },
      ]);
      expect(await written(db, digest(good))).toEqual(before);
    } finally {
      csv = good;
      await pg.close();
    }
  }, 60_000);
});

describe("package", () => {
  it("registers one feed source with a valid manifest", () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    const added: FeedSource[] = [];
    void plugin.setup({
      sources: { add: (source: FeedSource) => added.push(source) },
    } as never);
    expect(
      added.map(({ id, hosts, command }) => [id, hosts, command.argv]),
    ).toEqual([
      ["nucc-provider-taxonomy", ["www.nucc.org"], ["ingest", "taxonomy"]],
    ]);
  });
});
