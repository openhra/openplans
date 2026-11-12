import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FeedSource } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import { feedWorkerCommands } from "../../src/plugins/sources/index.js";
import { runFeedSource } from "../../src/plugins/sources/feed.js";
import type { FeedRunOptions } from "../../src/plugins/sources/feed.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { loadWorkerPlugins } from "../../src/plugins/worker.js";
import type { PluginWorkerCommand } from "../../src/plugins/worker.js";
import { runWorker } from "../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const fixture = new URL("../fixtures/plugins/synthetic-feed/", import.meta.url);
const { default: syntheticFeed, source: syntheticSource } = (await import(
  new URL("index.mjs", fixture).href
)) as {
  default: { setup(ctx: unknown): void };
  source: FeedSource;
};
const HOST = "feed.synthetic.test";
const terms = "Synthetic publisher permits scoped automated feed collection.";
const robots = "User-agent: *\nDisallow: /private\n";
const items = [
  { code: "S1", label: "Synthetic item one" },
  { code: "S2", label: "Synthetic item two" },
];
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let pg: PGlite;
let db: Database;
let scratch: string;
let manifestPath: string;
let cleanupMigrations: () => Promise<void>;
let requests: string[];
let out: string[];
let err: string[];

function publisher(host: string): PublisherPolicy {
  return {
    host,
    state: "allowed",
    evidence: [
      {
        url: `https://${host}/terms`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}/feed/index.json`],
    permittedPaths: ["/feed"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}

const bodies: Record<string, string> = {
  "/robots.txt": robots,
  "/terms": terms,
  "/feed/index.json": JSON.stringify({ files: ["/feed/items.json"] }),
  "/feed/items.json": JSON.stringify(items),
};
const transport: Transport = async (url) => {
  requests.push(url.href);
  const body = bodies[url.pathname] ?? "";
  return {
    status: body ? 200 : 404,
    headers: {},
    body: Readable.from([body]),
  };
};

const options = (): FeedRunOptions => ({
  declaredHosts: [HOST],
  dataDir: scratch,
  manifestPaths: [manifestPath],
  transport,
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  sleep: async () => {},
  maxAttempts: 1,
  output: {
    out: (line) => out.push(line),
    error: (line) => err.push(line),
  },
});
const ingest = (
  name: string,
  run: typeof runFeedSource = runFeedSource,
  source: FeedSource = syntheticSource,
) => run(source, ["--case", name], db, options());

const seen = () =>
  ((
    globalThis as { syntheticFeedSeen?: Record<string, unknown>[] }
  ).syntheticFeedSeen ??= []);
const snapshots = async () =>
  (
    await db.query<{ snapshot_id: string; validation_state: string }>(
      "SELECT snapshot_id, validation_state FROM snapshot WHERE source_id='synthetic-feed' ORDER BY created_at, snapshot_id",
    )
  ).rows;
const outbox = async () =>
  (
    await db.query<{
      event_type: string;
      emitted_by: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT event_type, emitted_by, payload FROM plugin_event_outbox ORDER BY emitted_at, event_type",
    )
  ).rows;
const stagedRows = async () =>
  (
    await db.query<{
      item_code: string;
      snapshot_id: string;
      sourced_by: string;
      sourced_slug: string;
      sourced_at: string | null;
    }>(
      "SELECT item_code, snapshot_id, sourced_by, sourced_slug, sourced_at::text FROM synthetic_feed_item ORDER BY item_code",
    )
  ).rows;
const failure = () => err.map((line) => JSON.parse(line)).at(-1);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-feed-"));
  manifestPath = join(scratch, "access.json");
  const manifest: AdmissionManifest = {
    version: 1,
    publishers: [publisher(HOST)],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const core = await coreMigrations();
  cleanupMigrations = core.cleanup;
  await cp(
    fileURLToPath(new URL("migration.sql", fixture)),
    join(core.directory, "9000_synthetic_feed.sql"),
  );
  pg = new PGlite();
  db = testDatabase(pg);
  await migrate(db, core.directory);
}, 120_000);
afterAll(async () => {
  await pg?.close();
  await cleanupMigrations?.();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  requests = [];
  out = [];
  err = [];
  seen().length = 0;
  await db.exec(`
    DELETE FROM synthetic_feed_item;
    DELETE FROM synthetic_feed_untracked;
    DELETE FROM quality_issue WHERE source_id = 'synthetic-feed';
    DELETE FROM snapshot WHERE source_id = 'synthetic-feed';
    DELETE FROM plugin_event_outbox;
  `);
});

describe("feed source lifecycle", () => {
  it("activates a happy run, with provenance from the row trigger", async () => {
    expect(await ingest("happy")).toBe(0);
    const [snapshot] = await snapshots();
    expect(snapshot).toMatchObject({ validation_state: "ACTIVE" });
    expect(out.map((line) => JSON.parse(line))).toEqual([
      {
        source: "synthetic-feed",
        snapshot_ids: [snapshot!.snapshot_id],
        rows: 2,
      },
    ]);
    const rows = await stagedRows();
    expect(rows.map((row) => row.item_code)).toEqual(["S1", "S2"]);
    for (const row of rows) {
      expect(row.sourced_by).toBe("synthetic-feed");
      expect(row.sourced_slug).toBe(snapshot!.snapshot_id);
      expect(row.sourced_at).not.toBeNull();
    }
    // Validate and beforeActivate ran while the snapshot was still PARSED.
    expect(seen()).toEqual([
      { hook: "validate", case: "happy", states: ["PARSED"] },
      { hook: "beforeActivate", case: "happy", states: ["PARSED"] },
    ]);
    // The snapshot trigger from migration 1000 emitted the activation, rows unknown.
    expect(await outbox()).toEqual([
      {
        event_type: "snapshot.activated",
        emitted_by: "db",
        payload: {
          sourceId: "synthetic-feed",
          snapshotId: snapshot!.snapshot_id,
          rows: null,
        },
      },
    ]);
    const receipt = (
      await db.query<Record<string, unknown>>(
        "SELECT requested_url, final_url, sha256, uncompressed_bytes, expected_children, fetched_children, retrieved_at IS NOT NULL AS retrieved FROM snapshot WHERE snapshot_id=$1",
        [snapshot!.snapshot_id],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      requested_url: `https://${HOST}/feed/items.json`,
      final_url: `https://${HOST}/feed/items.json`,
      sha256: digest(JSON.stringify(items)),
      expected_children: 1,
      fetched_children: 1,
      retrieved: true,
    });
    expect(
      (
        await db.query<{ publisher: string; source_kind: string }>(
          "SELECT publisher, source_kind FROM source WHERE source_id='synthetic-feed'",
        )
      ).rows,
    ).toEqual([{ publisher: "Synthetic test publisher", source_kind: "feed" }]);
  });

  it("quarantines a validate failure and leaves the earlier snapshot ACTIVE", async () => {
    expect(await ingest("happy")).toBe(0);
    const [earlier] = await snapshots();
    const before = await stagedRows();
    seen().length = 0;
    await db.exec("DELETE FROM plugin_event_outbox");

    expect(await ingest("invalid")).toBe(1);
    expect(failure()).toEqual({
      source: "synthetic-feed",
      code: "feed_run_failed",
      reason: "synthetic_invalid",
    });
    const after = await snapshots();
    expect(after).toHaveLength(2);
    expect(
      after.find((row) => row.snapshot_id === earlier!.snapshot_id),
    ).toEqual({
      snapshot_id: earlier!.snapshot_id,
      validation_state: "ACTIVE",
    });
    const failed = after.find(
      (row) => row.snapshot_id !== earlier!.snapshot_id,
    );
    expect(failed?.validation_state).toBe("QUARANTINED");
    // The failed stage deleted and rewrote rows; the rollback kept the earlier ones.
    expect(await stagedRows()).toEqual(before);
    // validate saw its own snapshot unactivated; beforeActivate never ran.
    expect(seen()).toEqual([
      { hook: "validate", case: "invalid", states: ["PARSED"] },
    ]);
    expect(await outbox()).toEqual([
      {
        event_type: "snapshot.quarantined",
        emitted_by: "db",
        payload: {
          sourceId: "synthetic-feed",
          snapshotId: failed!.snapshot_id,
          reasonCode: "synthetic_invalid",
        },
      },
    ]);
  });

  it("refuses a plan URL outside the source's hosts before any request", async () => {
    expect(await ingest("offhost")).toBe(1);
    expect(failure()).toMatchObject({ reason: "fetch_host_not_allowed" });
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  it("still checks every plan URL against the manifest after the host checks pass", async () => {
    expect(await ingest("unpermitted")).toBe(1);
    expect(failure()).toMatchObject({ reason: "fetch_admission_denied" });
    // Only the discovery-free plan ran; the refused file was never requested.
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  // The contract the undeclared-host test and its mutant share.
  const refusedUndeclared = async (code: number) => {
    expect(code).toBe(1);
    expect(failure()).toEqual({
      source: "synthetic-feed",
      code: "feed_run_failed",
      reason: "source_host_undeclared",
    });
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  };
  const undeclared = (run: typeof runFeedSource) =>
    run(syntheticSource, ["--case", "happy"], db, {
      ...options(),
      declaredHosts: [],
    });

  it("refuses a source host the plugin did not declare, before any request", async () => {
    await refusedUndeclared(await undeclared(runFeedSource));
    // Left out, the declared hosts are none.
    err = [];
    const { declaredHosts: _, ...rest } = options();
    await refusedUndeclared(
      await runFeedSource(syntheticSource, ["--case", "happy"], db, rest),
    );
  });

  it("is caught when the declared-host check is removed (planted mutant)", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/sources/feed.ts", import.meta.url),
      "if (hosts.some((host) => !declared.includes(host)))",
      "if (hosts.length < 0 && declared.length < 0)",
    );
    try {
      const module = (await import(mutant.path)) as {
        runFeedSource: typeof runFeedSource;
      };
      const code = await undeclared(module.runFeedSource);
      await expect(refusedUndeclared(code)).rejects.toThrow();
      // The run went ahead against an undeclared host.
      expect(code).toBe(0);
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses a declared host no reviewed manifest admits, before planning or opening the database", async () => {
    const open = vi.fn(async () => db);
    const source = {
      ...syntheticSource,
      hosts: [HOST, "unreviewed.synthetic.test"],
    };
    expect(
      await runFeedSource(source, ["--case", "happy"], open, {
        ...options(),
        declaredHosts: source.hosts,
      }),
    ).toBe(1);
    expect(failure()).toEqual({
      source: "synthetic-feed",
      code: "feed_run_failed",
      reason: "fetch_admission_denied",
      detail:
        "Publisher host is not in a reviewed access manifest; add an operator manifest entry to collect from it",
    });
    expect(open).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(seen()).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  it("opens a lazily given database only after the plan", async () => {
    const open = vi.fn(async () => db);
    expect(
      await runFeedSource(
        syntheticSource,
        ["--case", "happy"],
        open,
        options(),
      ),
    ).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    err = [];
    expect(
      await runFeedSource(
        syntheticSource,
        ["--case", "happy"],
        async () => {
          throw new Error("no database");
        },
        options(),
      ),
    ).toBe(1);
    expect(failure()).toMatchObject({ reason: "database_unavailable" });
  });

  it("overwrites provenance a plugin tries to set (row trigger negative control)", async () => {
    expect(await ingest("forge")).toBe(0);
    const [snapshot] = await snapshots();
    const rows = await stagedRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sourced_by).toBe("synthetic-feed");
      expect(row.sourced_slug).toBe(snapshot!.snapshot_id);
      expect(row.sourced_at?.startsWith("2001")).toBe(false);
    }
  });

  it("fails readiness when a touched table has no change trigger", async () => {
    expect(await ingest("untracked")).toBe(1);
    expect(failure()).toMatchObject({
      reason: "readiness_change_trigger_missing",
    });
    expect((await snapshots()).map((row) => row.validation_state)).toEqual([
      "QUARANTINED",
    ]);
    expect(
      (await db.query("SELECT 1 FROM synthetic_feed_untracked")).rows,
    ).toEqual([]);
  });

  it("fails readiness when a required table gets no rows", async () => {
    expect(await ingest("empty")).toBe(1);
    expect(failure()).toMatchObject({ reason: "readiness_no_rows" });
    expect((await snapshots()).map((row) => row.validation_state)).toEqual([
      "QUARANTINED",
    ]);
  });

  it("gives the plugin no fetch once planning is over", async () => {
    const before = requests.length;
    expect(await ingest("late-fetch")).toBe(1);
    expect(failure()).toMatchObject({ reason: "stage_failed" });
    // Robots, terms, the discovery page and the one planned file; nothing from stage.
    expect(requests.slice(before).map((url) => new URL(url).pathname)).toEqual([
      "/robots.txt",
      "/terms",
      "/feed/index.json",
      "/feed/items.json",
    ]);
  });

  it("prints usage and touches nothing on bad arguments", async () => {
    expect(
      await runFeedSource(syntheticSource, ["--bogus"], db, options()),
    ).toBe(1);
    expect(err).toEqual(["Usage: worker ingest synthetic-feed --case NAME"]);
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  describe("content-addressed cache", () => {
    const original = bodies["/feed/items.json"]!;
    const changed = JSON.stringify([
      { code: "S9", label: "Synthetic item nine" },
    ]);
    const itemsUrl = `https://${HOST}/feed/items.json`;
    let dataDir: string;
    beforeEach(async () => {
      dataDir = await mkdtemp(join(scratch, "content-"));
      bodies["/feed/items.json"] = original;
    });
    const run = (name: string, runner: typeof runFeedSource = runFeedSource) =>
      runner(syntheticSource, ["--case", name], db, {
        ...options(),
        dataDir,
      });
    const rawPaths = async () =>
      (
        await db.query<{ raw_path: string }>(
          "SELECT raw_path FROM snapshot WHERE source_id='synthetic-feed' ORDER BY created_at, snapshot_id",
        )
      ).rows.map((row) => row.raw_path);
    const codes = async () => (await stagedRows()).map((row) => row.item_code);

    it("stores the file under its hash and reuses it on the next run without a request", async () => {
      const sha = digest(original);
      expect(await run("content")).toBe(0);
      expect(requests).toEqual([
        `https://${HOST}/robots.txt`,
        `https://${HOST}/terms`,
        itemsUrl,
      ]);
      expect(
        (await readdir(join(dataDir, "raw", "synthetic-feed"))).sort(),
      ).toEqual([sha, `${sha}.meta.json`]);
      const payload = join(dataDir, "raw", "synthetic-feed", sha, "payload");
      expect(await rawPaths()).toEqual([payload]);

      requests = [];
      expect(await run("content")).toBe(0);
      // Robots and terms are read for the session; the file itself is not requested again.
      expect(requests).not.toContain(itemsUrl);
      expect(await rawPaths()).toEqual([payload, payload]);
      expect(
        (await readdir(join(dataDir, "raw", "synthetic-feed"))).sort(),
      ).toEqual([sha, `${sha}.meta.json`]);
      expect(await codes()).toEqual(["S1", "S2"]);
    });

    // The contract the changed-hash test and its mutant share.
    const changedHash = async (runner: typeof runFeedSource) => {
      expect(await run("content", runner)).toBe(0);
      bodies["/feed/items.json"] = changed;
      (globalThis as { syntheticFeedPin?: string }).syntheticFeedPin =
        digest(changed);
      requests = [];
      const code = await run("content-pinned", runner);
      return async () => {
        expect(code).toBe(0);
        expect(requests).toContain(itemsUrl);
        expect(await codes()).toEqual(["S9"]);
        expect(
          (await readdir(join(dataDir, "raw", "synthetic-feed"))).sort(),
        ).toEqual(
          [
            digest(original),
            `${digest(original)}.meta.json`,
            digest(changed),
            `${digest(changed)}.meta.json`,
          ].sort(),
        );
      };
    };

    it("downloads again when the plan names a different hash", async () => {
      await (
        await changedHash(runFeedSource)
      )();
    });

    it("is caught when reuse ignores the plan's changed hash (planted mutant)", async () => {
      const mutant = await plantMutant(
        new URL("../../src/plugins/sources/feed.ts", import.meta.url),
        "file.expectedSha256 ??",
        "undefined ??",
      );
      try {
        const module = (await import(mutant.path)) as {
          runFeedSource: typeof runFeedSource;
        };
        const contract = await changedHash(module.runFeedSource);
        await expect(contract()).rejects.toThrow();
        // The mutant served the earlier copy's rows.
        expect(await codes()).toEqual(["S1", "S2"]);
      } finally {
        await mutant.cleanup();
      }
    });

    it("keeps run-id storage when the plan does not ask for the content cache", async () => {
      expect(await ingest("happy")).toBe(0);
      // An identical copy from an earlier test's run may be reused; either way it sits under a
      // run receipt id, not under its hash.
      expect((await rawPaths())[0]).toMatch(
        /\/raw\/synthetic-feed\/synthetic-feed\.\d{8}T\d{6}Z\.[0-9a-f]{8}\.1\/payload$/,
      );
    });
  });

  it("is caught when activation moves before validate (planted mutant)", async () => {
    const file = new URL("../../src/plugins/sources/feed.ts", import.meta.url);
    const validation = `      const verdict = await hook("validate_failed", () =>`;
    // Activation planted ahead of validate, inside the same transaction.
    const mutant = await plantMutant(
      file,
      validation,
      `      await tx.query("UPDATE snapshot SET validation_state='ACTIVE', activated_at=now() WHERE snapshot_id = ANY($1::text[])", [snapshotIds]);
${validation}`,
    );
    try {
      const module = (await import(mutant.path)) as {
        runFeedSource: typeof runFeedSource;
      };
      expect(await ingest("happy")).toBe(0);
      const [earlier] = await snapshots();
      seen().length = 0;
      expect(await ingest("invalid", module.runFeedSource)).toBe(1);
      // The quarantine test's ordering assertion fails under the mutant.
      expect(seen()).not.toEqual([
        { hook: "validate", case: "invalid", states: ["PARSED"] },
      ]);
      expect(seen()).toEqual([
        { hook: "validate", case: "invalid", states: ["ACTIVE"] },
      ]);
      expect((await snapshots())[0]).toEqual({
        snapshot_id: earlier!.snapshot_id,
        validation_state: "ACTIVE",
      });
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("feed sources as worker commands", () => {
  const keepOpen = (): Database => ({ ...db, close: async () => {} });
  const collected = async () => {
    const sources: FeedSource[] = [];
    syntheticFeed.setup({
      sources: { add: (source: FeedSource) => sources.push(source) },
    } as never);
    return sources.map((spec) => ({
      plugin: "@synthetic/feed",
      spec,
      network: [HOST],
    }));
  };
  const worker = async (
    args: string[],
    commands: readonly PluginWorkerCommand[],
  ) => runWorker(args, keepOpen, options().output!, undefined, commands);

  it("runs `worker ingest <source>` through the worker dispatch", async () => {
    const commands = feedWorkerCommands(
      await collected(),
      new Set(["@synthetic/feed"]),
      {} as never,
      options(),
    );
    expect(commands.map(({ spec }) => spec.argv)).toEqual([
      ["ingest", "synthetic-feed"],
    ]);
    expect(
      await worker(["ingest", "synthetic-feed", "--case", "happy"], commands),
    ).toBe(0);
    expect((await snapshots()).map((row) => row.validation_state)).toEqual([
      "ACTIVE",
    ]);
  });

  it("passes the plugin's declared network hosts to the run", async () => {
    const commands = feedWorkerCommands(
      (await collected()).map((entry) => ({ ...entry, network: [] })),
      new Set(["@synthetic/feed"]),
      {} as never,
      options(),
    );
    expect(
      await worker(["ingest", "synthetic-feed", "--case", "happy"], commands),
    ).toBe(1);
    expect(failure()).toMatchObject({ reason: "source_host_undeclared" });
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  it("refuses a feed plugin that did not declare staging writes", async () => {
    const commands = feedWorkerCommands(
      await collected(),
      new Set(),
      {} as never,
      options(),
    );
    expect(
      await worker(["ingest", "synthetic-feed", "--case", "happy"], commands),
    ).toBe(1);
    expect(failure()).toEqual({
      plugin: "@synthetic/feed",
      code: "feed_source_requires_staging",
    });
    expect(requests).toEqual([]);
    expect(await snapshots()).toEqual([]);
  });

  it("registers feed sources from the plugin loader as worker commands", async () => {
    const loaded = await loadWorkerPlugins({
      env: {
        OPENPLANS_PLUGINS: fileURLToPath(new URL("index.mjs", fixture)),
        OPENPLANS_ACCESS_MANIFEST: manifestPath,
      },
      writeLog: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });
    try {
      expect(
        loaded.commands.map(({ plugin, spec, writer }) => ({
          plugin,
          argv: spec.argv,
          writer,
        })),
      ).toEqual([
        {
          plugin: "@synthetic/feed",
          argv: ["ingest", "synthetic-feed"],
          writer: true,
        },
      ]);
      // Without injected options the run uses the shipped manifests, which never admit the
      // synthetic host; the off-host plan is refused before any request either way.
      expect(
        await worker(
          ["ingest", "synthetic-feed", "--case", "offhost"],
          loaded.commands,
        ),
      ).toBe(1);
      expect(await snapshots()).toEqual([]);
    } finally {
      await loaded.teardown();
    }
  });
});
