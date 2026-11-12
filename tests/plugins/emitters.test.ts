import { PGlite } from "@electric-sql/pglite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  EventType,
  WorkerCommandSpec,
  WorkerContext,
} from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import * as geoSources from "../../src/ingest/geo/sources.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import {
  checkEventPayloads,
  readOutbox,
} from "../../src/plugins/testing/events.js";
import type { OutboxRow } from "../../src/plugins/testing/events.js";
import {
  createCoreEvents,
  emitPluginLoaded,
  ingestCommandWords,
  ingestReason,
  ingestScope,
  withIngestEvents,
} from "../../src/plugins/worker.js";
import { emitApiPluginLoaded, loadApiPlugins } from "../../src/plugins/api.js";
import { ingestSources } from "../../src/worker/ingest-sources.js";
import type * as IngestSourcesModule from "../../src/worker/ingest-sources.js";
import type * as WorkerModule from "../../src/plugins/worker.js";
import type {
  CoreEvents,
  PluginWorkerCommand,
} from "../../src/plugins/worker.js";
import { runWorker } from "../../src/worker/commands.js";
import { syntheticZip } from "../fixtures/fetch/generate.mjs";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Every plugin, source, command and event in this file is synthetic.
let db: Database;
let directory: string;
let cleanupMigrations: () => Promise<void>;
// Own synthetic data dir, set explicitly so no test reads the real
// OPENPLANS_DATA_DIR from the environment.
let baseDataDir: string;

beforeAll(async () => {
  baseDataDir = await mkdtemp(join(tmpdir(), "openplans-emitters-data-"));
  vi.stubEnv("OPENPLANS_DATA_DIR", baseDataDir);
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  directory = core.directory;
  cleanupMigrations = core.cleanup;
  await migrate(db, directory);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(baseDataDir, { recursive: true, force: true });
  await db.close();
  await cleanupMigrations();
});
beforeEach(async () => {
  await db.exec("DELETE FROM plugin_event_outbox");
});

/** The shared test database, never closed by the code under test. */
const shared = (): Database => ({ ...db, close: async () => {} });

const output = () => {
  const lines: string[] = [],
    errors: string[] = [];
  return {
    lines,
    errors,
    out: (line: string) => void lines.push(line),
    error: (line: string) => void errors.push(line),
  };
};

function testEvents(open: () => Database = shared) {
  const logs: Record<string, unknown>[] = [];
  const events = createCoreEvents({ open, log: (entry) => logs.push(entry) });
  return { events, logs };
}

const plugin = "@synthetic/emitters";
function pluginCommand(
  run: WorkerCommandSpec["run"],
  extra: Partial<WorkerCommandSpec> = {},
): PluginWorkerCommand {
  return {
    plugin,
    spec: {
      argv: ["ingest", "synthetic-feed"],
      usage: "Usage: worker ingest synthetic-feed [--state XX] [--year YYYY]",
      source: "synthetic-source",
      run,
      ...extra,
    },
    writer: true,
    emits: false,
    config: {} as PluginWorkerCommand["config"],
  };
}
const writerOf = (ctx: WorkerContext) =>
  (ctx.db as unknown as { writer: Database }).writer;

/** Strict catalog parse, the catalog scanner, and no path or URL in any value. */
function checkPayloads(rows: readonly OutboxRow[]): void {
  const types = [...new Set(rows.map((row) => row.event_type))];
  expect(
    checkEventPayloads(
      Object.fromEntries(
        types.map((type) => [type, eventPayloadSchemas[type as EventType]]),
      ),
    ),
  ).toEqual([]);
  for (const row of rows) {
    const schema = eventPayloadSchemas[row.event_type as EventType];
    expect(schema.safeParse(row.payload).success).toBe(true);
    const strings = JSON.stringify(row.payload).match(/"(?:[^"\\]|\\.)*"/g);
    for (const value of strings ?? []) {
      const text = JSON.parse(value) as string;
      // A scoped package name (@scope/name) is the only slash allowed.
      if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(text))
        expect(text).not.toMatch(/[/\\]/);
    }
  }
}

async function activateSnapshot(writer: Database, id: string): Promise<void> {
  await writer.query(
    `INSERT INTO source (source_id, publisher, source_kind)
     VALUES ('synthetic-source', 'Synthetic publisher', 'synthetic')
     ON CONFLICT (source_id) DO NOTHING`,
  );
  await writer.query(
    `INSERT INTO snapshot (snapshot_id, source_id, sha256, retrieved_at, expected_children, validation_state)
     VALUES ($1, 'synthetic-source', repeat('a', 64), now(), 0, 'PARSED')`,
    [id],
  );
  await writer.query(
    "UPDATE snapshot SET validation_state='ACTIVE', activated_at=now() WHERE snapshot_id=$1",
    [id],
  );
}

describe("ingest events from the worker command wrapper", () => {
  it("a synthetic ingest command that exits 1 writes ingest.started and ingest.failed", async () => {
    const { events, logs } = testEvents();
    const out = output();
    const command = pluginCommand(async (_args, ctx) => {
      await ctx.db.reader.query("SELECT 1");
      return 1;
    });
    const code = await runWorker(
      ["ingest", "synthetic-feed", "--state", "TX", "--year", "2026"],
      shared,
      out,
      directory,
      [command],
      { events },
    );
    expect(code).toBe(1);
    const rows = await readOutbox(db);
    expect(rows.map((row) => [row.event_type, row.emitted_by])).toEqual([
      ["ingest.started", "worker"],
      ["ingest.failed", "worker"],
    ]);
    expect(rows[0]!.payload).toEqual({
      sourceId: "synthetic-source",
      command: ["ingest", "synthetic-feed"],
      scope: { state: "TX", year: 2026 },
    });
    expect(rows[1]!.payload).toEqual({
      sourceId: "synthetic-source",
      command: ["ingest", "synthetic-feed"],
      reasonCode: "exit_1",
    });
    checkPayloads(rows);
    expect(logs).toEqual([]);
    expect(out).toMatchObject({ lines: [], errors: [] });
  });

  it("exit 0 writes ingest.completed with a duration and the snapshots the run activated", async () => {
    const { events } = testEvents();
    const command = pluginCommand(async (_args, ctx) => {
      await activateSnapshot(writerOf(ctx), "synthetic-source.run-1");
      return 0;
    });
    const out = output();
    const code = await runWorker(
      ["ingest", "synthetic-feed", "--year", "2027"],
      shared,
      out,
      directory,
      [command],
      { events },
    );
    expect(code).toBe(0);
    const rows = await readOutbox(db);
    const types = rows.map((row) => row.event_type);
    expect(types).toContain("ingest.started");
    expect(types).toContain("ingest.completed");
    // The database trigger adds its own snapshot.activated row.
    expect(types).toContain("snapshot.activated");
    const completed = rows.find((row) => row.event_type === "ingest.completed")!
      .payload as { durationMs: number; snapshotIds: string[] };
    expect(Number.isInteger(completed.durationMs)).toBe(true);
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.snapshotIds).toEqual(["synthetic-source.run-1"]);
    expect(
      rows.find((row) => row.event_type === "ingest.started")!.payload,
    ).toEqual({
      sourceId: "synthetic-source",
      command: ["ingest", "synthetic-feed"],
      scope: { year: 2027 },
    });
    checkPayloads(rows);
  });

  it("a usage error emits nothing and never connects", async () => {
    const { events } = testEvents();
    const open = vi.fn(shared);
    const out = output();
    // Core usage path: the geo command rejects the flag before it opens anything.
    expect(
      await runWorker(["ingest", "geo", "--bogus"], open, out, directory, [], {
        events,
      }),
    ).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(await readOutbox(db)).toEqual([]);
    expect(out.errors).toEqual([
      "Usage: worker ingest geo [--year 2025|2026|2027] [--state XX | --all-states]",
    ]);
  });

  it("a core ingest command reports its declared source, subcommand words and scope", async () => {
    const { events } = testEvents();
    const out = output();
    const code = await runWorker(
      ["ingest", "puf", "lineage", "--year", "2026"],
      shared,
      out,
      directory,
      [],
      { events },
    );
    const rows = await readOutbox(db);
    expect(rows[0]).toMatchObject({
      event_type: "ingest.started",
      payload: {
        sourceId: "cms-exchange-puf",
        command: ["ingest", "puf", "lineage"],
        scope: { year: 2026 },
      },
    });
    expect(rows.at(-1)!.event_type).toBe(
      code === 0 ? "ingest.completed" : "ingest.failed",
    );
    checkPayloads(rows);
  });

  it("exit code, stdout and stderr are the same with and without events", async () => {
    const cases: [string[], PluginWorkerCommand[]][] = [
      [["ingest", "puf", "lineage", "--year", "2026"], []],
      [["ingest", "geo", "--bogus"], []],
      [
        ["ingest", "synthetic-feed", "--state", "TX"],
        [
          pluginCommand(async (_args, ctx) => {
            ctx.log({ step: "synthetic", rows: 3 });
            await ctx.db.reader.query("SELECT 1");
            return 2;
          }),
        ],
      ],
      [["record-policy", "list"], []],
    ];
    for (const [argv, plugins] of cases) {
      const plain = output();
      const plainCode = await runWorker(
        argv,
        shared,
        plain,
        directory,
        plugins,
      );
      const { events } = testEvents();
      const withEvents = output();
      const eventCode = await runWorker(
        argv,
        shared,
        withEvents,
        directory,
        plugins,
        { events },
      );
      expect([eventCode, withEvents.lines, withEvents.errors]).toEqual([
        plainCode,
        plain.lines,
        plain.errors,
      ]);
    }
  });

  it("the command words never carry flag values such as paths", () => {
    expect(
      ingestCommandWords(
        ["ingest", "state"],
        ["--state", "NY", "--file", "/synthetic/prepared-2026.json"],
      ),
    ).toEqual(["ingest", "state"]);
    expect(
      ingestCommandWords(["ingest", "sbe"], ["import", "--year", "2026"]),
    ).toEqual(["ingest", "sbe", "import"]);
    expect(ingestScope(["--state", "tx", "--year", "26"])).toEqual({});
    expect(ingestScope(["--all-states", "--year", "2027"])).toEqual({
      year: 2027,
    });
  });

  it("reason codes come from known error shapes, never from the text", () => {
    expect(ingestReason("worker x timed out after 50 ms")?.code).toBe(
      "timeout",
    );
    expect(
      ingestReason(
        "worker ingest failed; PostgreSQL 42P01: relation [redacted] does not exist",
      )?.code,
    ).toBe("postgres_42P01");
    expect(
      ingestReason(
        JSON.stringify({
          source: "synthetic-source",
          code: "feed_run_failed",
          reason: "fetch_admission_denied",
          detail: "Synthetic held host",
        }),
      )?.code,
    ).toBe("fetch_admission_denied");
    expect(ingestReason(JSON.stringify({ reason: "has spaces" }))).toBe(
      undefined,
    );
    expect(ingestReason("Usage: worker ingest rxnorm")?.code).toBe("usage");
    expect(
      ingestReason("Geography TX PY2026 failed; previous import preserved")
        ?.code,
    ).toBe("import_failed_previous_preserved");
    expect(ingestReason("synthetic progress line")).toBe(undefined);
  });
});

describe("outbox write failures never fail the command", () => {
  it("a failed outbox insert is logged with type and class only; the command result is unchanged", async () => {
    const broken = (): Database => ({
      ...shared(),
      transaction: async () => {
        throw new Error("synthetic outbox failure synthetic-secret");
      },
    });
    const { events, logs } = testEvents(broken);
    const plain = output();
    const command = pluginCommand(async (_args, ctx) => {
      await ctx.db.reader.query("SELECT 1");
      return 0;
    });
    const plainCode = await runWorker(
      ["ingest", "synthetic-feed"],
      shared,
      plain,
      directory,
      [command],
    );
    const out = output();
    const code = await runWorker(
      ["ingest", "synthetic-feed"],
      shared,
      out,
      directory,
      [command],
      { events },
    );
    expect([code, out.lines, out.errors]).toEqual([
      plainCode,
      plain.lines,
      plain.errors,
    ]);
    expect(code).toBe(0);
    expect(await readOutbox(db)).toEqual([]);
    expect(logs.map((entry) => [entry.event, entry.event_type])).toEqual([
      ["outbox_insert_failed", "ingest.started"],
      ["outbox_insert_failed", "ingest.completed"],
    ]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("synthetic-source");
    expect(logged).not.toContain("synthetic-secret");
  });

  it("an events database that cannot open is logged and the command still exits as before", async () => {
    const { events, logs } = testEvents(() => {
      throw new Error("synthetic connect failure");
    });
    const out = output();
    const code = await runWorker(
      ["ingest", "synthetic-feed"],
      shared,
      out,
      directory,
      [
        pluginCommand(async (_args, ctx) => {
          await ctx.db.reader.query("SELECT 1");
          return 3;
        }),
      ],
      { events },
    );
    expect(code).toBe(3);
    expect(out.errors).toEqual([]);
    expect(logs).toEqual([
      {
        event: "core_emit_failed",
        event_type: "ingest.started",
        error_class: "Error",
      },
      {
        event: "core_emit_failed",
        event_type: "ingest.failed",
        error_class: "Error",
      },
    ]);
  });

  it("mutant: rethrowing from the core emitter fails the command, and this test catches it", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/worker.ts", import.meta.url),
      'event: "core_emit_failed",',
      'event: "core_emit_failed", ...(() => { throw error; })(),',
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof WorkerModule;
      const events = loaded.createCoreEvents({
        open: () => {
          throw new Error("synthetic connect failure");
        },
        log: () => {},
      });
      const outcome = await loaded
        .withIngestEvents(
          { argv: ["ingest", "synthetic-feed"], source: "synthetic-source" },
          [],
          output(),
          events,
          async ({ opened }) => {
            opened(shared());
            return 0;
          },
        )
        .then(
          (code) => `exit ${code}`,
          () => "rejected",
        );
      expect(outcome).toBe("rejected");
    } finally {
      await mutant.cleanup();
    }
  });

  it("mutant: emitting on a usage-only run is caught", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/worker.ts", import.meta.url),
      'reason?.code === "usage"',
      "false",
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof WorkerModule;
      const emitted: string[] = [];
      const events: CoreEvents = {
        emit: async (input) => void emitted.push(input.type),
        read: async () => undefined,
        close: async () => {},
      };
      await loaded.withIngestEvents(
        { argv: ["ingest", "geo"], source: "census-geographies" },
        ["--bogus"],
        output(),
        events,
        async ({ output: io }) => {
          io.error("Usage: worker ingest geo");
          return 1;
        },
      );
      expect(emitted).not.toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("mutant: flag values in the command words put a path in the payload, and checkPayloads catches it", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/worker.ts", import.meta.url),
      "if (!wordPattern.test(arg)) break;",
      "void wordPattern;",
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof WorkerModule;
      const words = loaded.ingestCommandWords(
        ["ingest", "state"],
        ["--state", "NY", "--file", "/synthetic/prepared-2026.json"],
      );
      const row: OutboxRow = {
        event_id: "00000000-0000-0000-0000-000000000000",
        event_type: "ingest.failed",
        idempotency_key: "synthetic",
        emitted_by: "worker",
        payload: {
          sourceId: "state-rates:NY:2026",
          command: words,
          reasonCode: "exit_1",
        },
      };
      expect(() => checkPayloads([row])).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("record-policy set", () => {
  it("emits one record_policy.changed with the stored values; output unchanged", async () => {
    const { rows: policies } = await db.query<{ name: string }>(
      "SELECT name FROM record_policy ORDER BY name LIMIT 1",
    );
    const name = policies[0]!.name;
    const argv = ["record-policy", "set", name, "--ttl", "30 days"];
    const plain = output();
    const plainCode = await runWorker(argv, shared, plain, directory);
    const { events, logs } = testEvents();
    const out = output();
    const code = await runWorker(argv, shared, out, directory, [], { events });
    expect([code, out.lines, out.errors]).toEqual([
      plainCode,
      plain.lines,
      plain.errors,
    ]);
    expect(code).toBe(0);
    const rows = await readOutbox(db);
    const stored = (
      await db.query<{ stale_window: string }>(
        "SELECT stale_window::text FROM record_policy WHERE name=$1",
        [name],
      )
    ).rows[0]!;
    expect(rows.map((row) => [row.event_type, row.payload])).toEqual([
      [
        "record_policy.changed",
        { policy: name, ttl: "30 days", staleWindow: stored.stale_window },
      ],
    ]);
    checkPayloads(rows);
    expect(logs).toEqual([]);
    // list and expire emit nothing.
    await runWorker(
      ["record-policy", "list"],
      shared,
      output(),
      directory,
      [],
      {
        events,
      },
    );
    expect(await readOutbox(db)).toHaveLength(1);
  });
});

describe("plugin.loaded", () => {
  it("writes one row per set of loaded plugins", async () => {
    const { events } = testEvents();
    const plugins = [
      { name: "@synthetic/b", version: "1.0.0" },
      { name: "@synthetic/a", version: "0.2.0" },
    ];
    await emitPluginLoaded(events, plugins);
    await emitPluginLoaded(events, [...plugins].reverse());
    await emitPluginLoaded(events, []);
    await emitPluginLoaded(undefined, plugins);
    const rows = await readOutbox(db);
    expect(rows.map((row) => [row.event_type, row.payload])).toEqual([
      ["plugin.loaded", { plugins }],
    ]);
    checkPayloads(rows);
  });
});

/**
 * Two overlapping synthetic runs, each activating its own snapshot, and one snapshot activated
 * outside any run while both are open. Returns each run's ingest.completed snapshot ids.
 */
async function overlappingRuns(
  run: typeof withIngestEvents,
  tag: string,
): Promise<string[][]> {
  const { events } = testEvents();
  const command = {
    argv: ["ingest", "synthetic-feed"],
    source: "synthetic-source",
  };
  let releaseA!: () => void;
  const aMayFinish = new Promise<void>((resolve) => (releaseA = resolve));
  let markWritten!: () => void;
  const aHasWritten = new Promise<void>((resolve) => (markWritten = resolve));
  // Run A writes outside a transaction; the tracker gives each write one of its own.
  const a = run(command, [], output(), events, async ({ opened }) => {
    await activateSnapshot(opened(shared()), `synthetic-source.${tag}-a`);
    markWritten();
    await aMayFinish;
    return 0;
  });
  await aHasWritten;
  await activateSnapshot(shared(), `synthetic-source.${tag}-none`);
  // Run B writes inside its own transaction.
  const b = run(command, [], output(), events, async ({ opened }) => {
    await opened(shared()).transaction(async (tx) => {
      await tx.query(
        `INSERT INTO snapshot (snapshot_id, source_id, sha256, retrieved_at, expected_children, validation_state)
         VALUES ($1, 'synthetic-source', repeat('b', 64), now(), 0, 'PARSED')`,
        [`synthetic-source.${tag}-b`],
      );
      await tx.query(
        "UPDATE snapshot SET validation_state='ACTIVE', activated_at=now() WHERE snapshot_id=$1",
        [`synthetic-source.${tag}-b`],
      );
    });
    return 0;
  });
  expect(await b).toBe(0);
  releaseA();
  expect(await a).toBe(0);
  const rows = (await readOutbox(db)).filter(
    (row) => row.event_type === "ingest.completed",
  );
  checkPayloads(rows);
  return rows
    .map((row) => (row.payload as { snapshotIds: string[] }).snapshotIds)
    .sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
}

describe("ingest.completed lists only its own run's snapshots", () => {
  it("two concurrent runs each list the snapshot they activated, never the other's or an untracked one", async () => {
    expect(await overlappingRuns(withIngestEvents, "overlap")).toEqual([
      ["synthetic-source.overlap-a"],
      ["synthetic-source.overlap-b"],
    ]);
  });

  it("the tracker leaves results, errors and output unchanged", async () => {
    let next = 0;
    const writes = pluginCommand(async (_args, ctx) => {
      const writer = writerOf(ctx);
      await activateSnapshot(writer, `synthetic-source.same-${next++}`);
      const read = await writer.query<{ answer: number }>(
        "SELECT 41 + 1 AS answer",
      );
      ctx.log({ answer: read.rows[0]!.answer });
      await writer
        .query("UPDATE snapshot SET bogus_column = 1")
        .catch((error: Error) => ctx.log({ failed: error.message }));
      return 0;
    });
    const plain = output();
    const plainCode = await runWorker(
      ["ingest", "synthetic-feed"],
      shared,
      plain,
      directory,
      [writes],
    );
    const { events } = testEvents();
    const out = output();
    const code = await runWorker(
      ["ingest", "synthetic-feed"],
      shared,
      out,
      directory,
      [writes],
      { events },
    );
    expect([code, out.lines, out.errors]).toEqual([
      plainCode,
      plain.lines,
      plain.errors,
    ]);
    expect(plain.errors).toHaveLength(2);
    const completed = (await readOutbox(db)).find(
      (row) => row.event_type === "ingest.completed",
    )!.payload as { snapshotIds: string[] };
    expect(completed.snapshotIds).toEqual(["synthetic-source.same-1"]);
  });

  it.each([
    [
      "the tracker is bypassed",
      "return trackIngestRun(database, runId);",
      "return database;",
    ],
    [
      "the run filter is dropped",
      "r.run_id = $1 AND",
      "(r.run_id = $1 OR true) AND",
    ],
  ])(
    "mutant: %s, and the concurrent-run test catches it",
    async (_, from, to) => {
      const url = new URL("../../src/plugins/worker.ts", import.meta.url);
      // The mutation matcher compares whole tokens, so SQL changes replace the whole literal.
      const literal =
        /`SELECT s\.snapshot_id FROM ingest_run_snapshot[^`]*`/.exec(
          await readFile(url, "utf8"),
        )![0];
      const mutant = from.startsWith("return")
        ? await plantMutant(url, from, to)
        : await plantMutant(url, literal, literal.replace(from, to));
      try {
        const loaded = (await import(
          pathToFileURL(mutant.path).href
        )) as typeof WorkerModule;
        const tag = `mutant-${to.length}`;
        expect(await overlappingRuns(loaded.withIngestEvents, tag)).not.toEqual(
          [[`synthetic-source.${tag}-a`], [`synthetic-source.${tag}-b`]],
        );
      } finally {
        await mutant.cleanup();
      }
    },
  );
});

describe("ingest event source ids", () => {
  it("core commands report the registry source id their arguments name, or the documented label", () => {
    const year = ["--year", "2026"];
    expect(ingestSources.pufImport([...year, "--state", "TX"])).toBe(
      "cms-exchange-puf:2026:TX",
    );
    expect(ingestSources.pufImport([...year, "--all-states"])).toBe(
      "cms-exchange-puf",
    );
    expect(ingestSources.sbe(["import", ...year, "--state", "NV"])).toBe(
      "cms_sbe_puf:2026:NV",
    );
    expect(ingestSources.sbe(["import", ...year, "--state", "GA"])).toBe(
      "cms-sbe-puf",
    );
    expect(ingestSources.sbe(["acquire", ...year, "--state", "NV"])).toBe(
      "cms-sbe-puf",
    );
    expect(ingestSources.state(["--state", "NY", "--file", "/x.json"])).toBe(
      "state-rates:NY:2026",
    );
    expect(
      ingestSources.qhpProviders([
        ...year,
        "--state",
        "TX",
        "--issuer",
        "12345",
      ]),
    ).toBe("qhp-provider-12345-2026-TX");
    expect(
      ingestSources.qhpFormulary([...year, "--state", "TX", "--all-readable"]),
    ).toBe("qhp-formulary");
    expect(ingestSources.medicare(["import", ...year, "--family", "pbp"])).toBe(
      "cms-medicare-pbp",
    );
    expect(ingestSources.medicare(["import", ...year])).toBe("cms-medicare");
    expect(
      ingestSources.medicare(["part-d", "import", "--kind", "monthly"]),
    ).toBe("cms-partd-spuf-monthly");
    expect(ingestSources.geo(["--source", "geonames"])).toBe(
      "geonames-us-postal",
    );
    expect(ingestSources.geo(["--state", "TX"])).toBe("census-geographies");
    expect(
      ingestSources.medicare(["import", ...year, "--family", "constructor"]),
    ).toBe("cms-medicare");
    expect([
      ingestSources.rxnorm,
      ingestSources.nppes,
      ingestSources.geocode,
      ingestSources.taxonomy,
      ingestSources.qhpDiscover,
    ]).toEqual([
      "nlm-rxnorm-prescribe",
      "cms-nppes",
      "census-geocoder-batch",
      "nucc-provider-taxonomy",
      "qhp-registry",
    ]);
    // A flag value that is not an id never becomes part of one.
    expect(ingestSources.pufImport([...year, "--state", "/x/TX"])).toBe(
      "cms-exchange-puf",
    );
  });

  it("runWorker reports the resolved id in every event of a core run", async () => {
    const { events } = testEvents();
    await runWorker(
      ["ingest", "state", "--state", "NY", "--file", "/synthetic/missing.json"],
      shared,
      output(),
      directory,
      [],
      { events },
    );
    const rows = await readOutbox(db);
    expect(rows.map((row) => row.event_type)).toEqual([
      "ingest.started",
      "ingest.failed",
    ]);
    for (const row of rows)
      expect(row.payload).toMatchObject({ sourceId: "state-rates:NY:2026" });
    checkPayloads(rows);
  });

  it("mutant: dropping the id shape check lets a flag value into the id, and this test catches it", async () => {
    const mutant = await plantMutant(
      new URL("../../src/worker/ingest-sources.ts", import.meta.url),
      "return value !== undefined && shape.test(value) ? value : undefined;",
      "return value;",
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof IngestSourcesModule;
      expect(
        loaded.ingestSources.pufImport(["--year", "2026", "--state", "/x/TX"]),
      ).not.toBe("cms-exchange-puf");
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("plugin.loaded from the API host", () => {
  const plugins = [
    { name: "@synthetic/b", version: "1.0.0" },
    { name: "@synthetic/a", version: "0.2.0" },
  ];

  it("writes one row per plugin set, shared with the worker, emitted by api", async () => {
    const logs: Record<string, unknown>[] = [];
    await emitApiPluginLoaded(plugins, shared, (entry) => logs.push(entry));
    await emitApiPluginLoaded([...plugins].reverse(), shared);
    await emitPluginLoaded(testEvents().events, plugins);
    const rows = await readOutbox(db);
    expect(
      rows.map((row) => [row.event_type, row.emitted_by, row.payload]),
    ).toEqual([["plugin.loaded", "api", { plugins }]]);
    checkPayloads(rows);
    expect(logs).toEqual([]);
  });

  it("hands the API's setup subscriptions to its emits: non-durable ones hear plugin.loaded", async () => {
    const heard: string[] = [];
    const subscription = (durable: boolean) => ({
      plugin: "@synthetic/listener",
      spec: {
        type: "plugin.loaded" as const,
        subscriber: `@synthetic/listener-${durable ? "durable" : "local"}`,
        durable,
        handler: async (event: { type: string }) => {
          heard.push(`${durable}:${event.type}`);
        },
      },
    });
    await emitApiPluginLoaded(plugins, shared, undefined, [
      subscription(false),
      subscription(true),
    ]);
    // The durable one is left to the worker's delivery.
    expect(heard).toEqual(["false:plugin.loaded"]);
  });

  it("an unreachable database is one log line, and no plugins means no connection", async () => {
    const logs: Record<string, unknown>[] = [];
    const open = vi.fn((): Database => {
      throw new Error("synthetic connect failure synthetic-secret");
    });
    await emitApiPluginLoaded([], open);
    expect(open).not.toHaveBeenCalled();
    await expect(
      emitApiPluginLoaded(plugins, open, (entry) => logs.push(entry)),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([
      {
        event: "core_emit_failed",
        event_type: "plugin.loaded",
        error_class: "Error",
      },
    ]);
  });

  it("loads nothing without configured plugins, and reports a configured one", async () => {
    const none = await loadApiPlugins({ env: {} });
    expect(none.plugins).toEqual([]);
    expect(none.registries).toBeUndefined();
    const scratch = await mkdtemp(join(tmpdir(), "openplans-api-plugins-"));
    try {
      const file = join(scratch, "index.mjs");
      await writeFile(
        file,
        `// Synthetic API plugin fixture.
export default {
  manifest: { name: "@synthetic/api-routes", version: "0.0.1", apiVersion: "0.1", kinds: ["routes"] },
  setup() {},
};
`,
      );
      const loaded = await loadApiPlugins({
        env: { OPENPLANS_PLUGINS: file },
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      });
      expect(loaded.plugins).toEqual([
        { name: "@synthetic/api-routes", version: "0.0.1" },
      ]);
      expect(loaded.registries).toEqual({
        routes: [],
        cacheStores: {},
        sources: [],
      });
      await loaded.teardown();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("mutant: emitting as the worker is caught", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/api.ts", import.meta.url),
      'host: "api"',
      'host: "worker"',
    );
    try {
      const loaded = (await import(pathToFileURL(mutant.path).href)) as {
        emitApiPluginLoaded: typeof emitApiPluginLoaded;
      };
      await loaded.emitApiPluginLoaded(plugins, shared);
      const rows = await readOutbox(db);
      expect(rows.map((row) => row.emitted_by)).not.toEqual(["api"]);
    } finally {
      await mutant.cleanup();
    }
  });
});

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/puf/import/", import.meta.url),
);
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

// The same cached acquisition as tests/worker-bootstrap.test.ts.
async function cachedPufs(dataDirectory: string) {
  const root = join(dataDirectory, "raw", "cms-exchange-puf");
  await mkdir(root, { recursive: true });
  const files = [];
  for (const kind of IMPORT_KINDS) {
    const bytes = syntheticZip([
      {
        name: `${kind}.csv`,
        body: await readFile(join(fixtureDirectory, `${kind}.csv`), "utf8"),
      },
    ]);
    const hash = sha(bytes),
      url = `https://download.cms.gov/marketplace-puf/2026/${kind}-puf.zip`;
    await mkdir(join(root, hash));
    await writeFile(join(root, hash, "payload"), bytes);
    await writeFile(
      join(root, `${hash}.meta.json`),
      JSON.stringify({
        source: "cms-exchange-puf",
        sha256: hash,
        url,
        bytes: bytes.length,
        fetched_at: "2026-11-07T00:00:00Z",
      }),
    );
    files.push({
      kind,
      year: 2026,
      status: "ok",
      snapshot_id: hash,
      sha256: hash,
      bytes: bytes.length,
      url,
    });
  }
  await writeFile(
    join(root, "manifest-2026-11-07.json"),
    JSON.stringify({ schema_version: 1, dry_run: false, files }),
  );
  return files;
}

describe("synthetic data dir", () => {
  it("points OPENPLANS_DATA_DIR at the test's own temp dir", () => {
    expect(process.env.OPENPLANS_DATA_DIR).toBe(baseDataDir);
    expect(baseDataDir.startsWith(tmpdir())).toBe(true);
  });
});

describe("bootstrap readiness", () => {
  it("the existing corrupt-acquisition failure emits readiness.failed for the failed step", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "openplans-emitters-bootstrap-"),
    );
    const pg = new PGlite(),
      local = testDatabase(pg),
      core = await coreMigrations();
    const acquire = vi
      .spyOn(geoSources, "acquireGeo")
      .mockResolvedValue(await geoFiles());
    const open = () => ({ ...local, close: async () => {} });
    try {
      const files = await cachedPufs(dataDirectory);
      await writeFile(
        join(
          dataDirectory,
          "raw",
          "cms-exchange-puf",
          files[0]!.sha256,
          "payload",
        ),
        "synthetic corrupt acquisition",
      );
      vi.stubEnv("OPENPLANS_DATA_DIR", dataDirectory);
      const logs: Record<string, unknown>[] = [];
      const events = createCoreEvents({
        open,
        log: (entry) => logs.push(entry),
      });
      const out = output();
      const code = await runWorker(
        ["bootstrap", "--states", "TX", "--years", "2026"],
        open,
        out,
        core.directory,
        [],
        { events },
      );
      expect(code).toBe(1);
      const summary = JSON.parse(out.lines.at(-1)!);
      expect(summary.failed).toEqual(["puf-acquire-2026"]);
      const failedStep = summary.steps.find(
        (step: { id: string }) => step.id === "puf-acquire-2026",
      );
      const rows = (await readOutbox(local)).filter(
        (row) => row.event_type === "readiness.failed",
      );
      expect(rows.map((row) => row.payload)).toEqual([
        { check: "bootstrap.puf-acquire-2026", reasonCode: failedStep.reason },
      ]);
      expect(rows[0]!.emitted_by).toBe("worker");
      checkPayloads(rows);
      expect(logs).toEqual([]);
      expect(out.errors).toEqual([]);
    } finally {
      acquire.mockRestore();
      vi.stubEnv("OPENPLANS_DATA_DIR", baseDataDir);
      await local.close();
      await core.cleanup();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
