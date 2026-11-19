import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createDatabase, type Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";

const serverUrl = process.env.WORKER_CONCURRENCY_POSTGRES_URL;
const childPath = fileURLToPath(
  new URL("./worker-concurrency-child.mjs", import.meta.url),
);
const modules = {
  delivery: new URL("../../dist/worker/deliver-events.js", import.meta.url),
  schedule: new URL("../../dist/worker/schedule.js", import.meta.url),
  ingest: new URL("../../dist/ingest/nppes/import.js", import.meta.url),
};
type Operation = keyof typeof modules;
interface Message {
  type: string;
  pid?: number;
  backend?: number;
  code?: string;
  result?: Record<string, unknown>;
}
interface Worker {
  process: ChildProcess;
  messages: Message[];
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Postgres worker checkpoint timed out");
}
const terminal = (worker: Worker) =>
  worker.messages.find((m) => m.type === "result" || m.type === "failure");
const waitFor = (worker: Worker, type: string) =>
  until(() => {
    const failure = worker.messages.find((m) => m.type === "failure");
    if (failure) throw new Error(`Worker failed: ${failure.code}`);
    return worker.messages.find((m) => m.type === type);
  });

// Compare persisted data and provenance; creation/update clocks differ between runs.
async function ingestRows(db: Database) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "npi_provider",
    "npi_taxonomy",
    "npi_address",
    "npi_state_scope",
    "npi_deactivation",
  ]) {
    const { rows } = await db.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg((to_jsonb(t)-'created_at'-'updated_at')::text, E'\\n' ORDER BY (to_jsonb(t)-'created_at'-'updated_at')::text),'')) AS digest
      FROM ${table} t`);
    result[table] = rows[0];
  }
  return result;
}

describe.skipIf(!serverUrl)(
  "worker races across processes on disposable PostgreSQL",
  () => {
    const template = `race_template_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Client;
    let db: Database;
    let url: string;
    let name: string;
    let expectedIngestRows: Record<string, unknown>;
    const children: Worker[] = [];

    function start(
      operation: Operation,
      module = modules[operation].href,
      pause = false,
      minute = 0,
    ): Worker {
      // Do not pass inherited application configuration or credentials to the worker.
      const env = Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", "TZ"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]!]],
        ),
      );
      const processChild = fork(childPath, [], {
        env,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const worker: Worker = { process: processChild, messages: [] };
      processChild.on("message", (message: Message) =>
        worker.messages.push(message),
      );
      processChild.on("error", () =>
        worker.messages.push({ type: "failure", code: "child_process_error" }),
      );
      processChild.on("exit", (code) => {
        if (!terminal(worker))
          worker.messages.push({ type: "failure", code: `child_exit_${code}` });
      });
      children.push(worker);
      processChild.send({
        type: "start",
        url,
        module,
        operation,
        pause,
        minute,
      });
      return worker;
    }

    async function fresh() {
      name = `race_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      const parsed = new URL(serverUrl!);
      parsed.pathname = `/${name}`;
      url = parsed.href;
      db = createDatabase(url);
    }
    async function stopChildren() {
      await Promise.all(
        children.splice(0).map(async ({ process: child }) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((resolve) =>
            child.once("exit", () => resolve()),
          );
          child.kill("SIGKILL");
          await exited;
        }),
      );
    }
    async function drop() {
      await stopChildren();
      await db?.close();
      if (name)
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }

    beforeAll(async () => {
      const parsed = new URL(serverUrl!);
      if (
        parsed.hostname !== "127.0.0.1" ||
        parsed.pathname !== "/openplans_worker_concurrency" ||
        process.env.OPENPLANS_POSTGIS_REQUIRED !== "1" ||
        !/^openplans-(gate-postgis|fa14-nightly|postgis-tests)-[a-zA-Z0-9_.-]+$/.test(
          process.env.OPENPLANS_POSTGIS_CONTAINER ?? "",
        )
      )
        throw new Error(
          "Worker races require the disposable lanes PostGIS container",
        );
      admin = new pg.Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${template}`);
      parsed.pathname = `/${template}`;
      const migrated = createDatabase(parsed.href);
      try {
        await migrate(migrated);
      } finally {
        await migrated.close();
      }
      // A serial import of the same published cuts is the complete-row baseline.
      await fresh();
      try {
        const baseline = start("ingest");
        const done = await waitFor(baseline, "result");
        expect(done.result?.outcome).toBe("imported");
        expectedIngestRows = await ingestRows(db);
        expect(
          (expectedIngestRows.npi_provider as { count: number }).count,
        ).toBeGreaterThan(0);
        expect(
          (expectedIngestRows.npi_address as { count: number }).count,
        ).toBeGreaterThan(0);
        expect(
          (expectedIngestRows.npi_taxonomy as { count: number }).count,
        ).toBeGreaterThan(0);
      } finally {
        await drop();
      }
    }, 60_000);
    beforeEach(fresh);
    afterEach(drop);
    afterAll(async () => {
      await stopChildren();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
        await admin.end();
      }
    });

    async function overlap(
      operation: Operation,
      module = modules[operation].href,
    ) {
      const a = start(operation, module, true);
      try {
        await waitFor(a, "holding");
        const b = start(operation, module);
        const readyA = await waitFor(a, "ready");
        const readyB = await waitFor(b, "ready");
        expect(readyA.pid).not.toBe(readyB.pid);
        expect(readyA.backend).not.toBe(readyB.backend);
        let blocked = false;
        // Wait for B's outcome, its delivery callback, or a server-confirmed wait on A.
        await until(asyncCheckpoint);
        async function asyncCheckpoint(): Promise<true | undefined> {
          if (terminal(b)) return true;
          if (b.messages.some((m) => m.type === "effect")) return true;
          const { rows } = await db.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [readyA.backend, readyB.backend],
          );
          blocked = rows[0]!.blocked;
          return blocked ? true : undefined;
        }
        a.process.send({ type: "release" });
        const results = await Promise.all([
          until(() => terminal(a)),
          until(() => terminal(b)),
        ]);
        const effects = [...a.messages, ...b.messages].filter(
          (m) => m.type === "effect",
        ).length;
        console.info(
          "postgres-concurrency:",
          JSON.stringify({
            operation,
            mutant: module !== modules[operation].href,
            processes: [readyA.pid, readyB.pid],
            backends: [readyA.backend, readyB.backend],
            effects,
            blocked,
            outcomes: results.map(
              (r) =>
                r.code ??
                r.result?.outcome ??
                r.result?.["synthetic-concurrency"] ??
                r.result?.delivered,
            ),
          }),
        );
        return { results, blocked, effects };
      } finally {
        if (a.process.connected) a.process.send({ type: "release" });
      }
    }

    async function seedDelivery() {
      const id = randomUUID();
      await db.query(`INSERT INTO plugin_state(plugin,key,value) VALUES('@synthetic/concurrency',
      'core:subscriber:synthetic-shared:cache.flushed','{"installedAt":"2026-11-11T11:00:00Z"}')`);
      await db.query(
        `INSERT INTO plugin_event_outbox(event_id,event_type,idempotency_key,emitted_by,emitted_at,payload)
      VALUES($1,'cache.flushed','synthetic-race','worker','2026-11-11T11:30:00Z','{"reason":"operator"}')`,
        [id],
      );
      await db.query(
        `INSERT INTO plugin_event_delivery(event_id,subscriber,next_attempt_at)
      VALUES($1,'synthetic-shared','2026-11-11T11:30:00Z')`,
        [id],
      );
    }
    function deliveryContract(race: Awaited<ReturnType<typeof overlap>>) {
      expect(race.results.every((r) => r.type === "result")).toBe(true);
      expect(race.effects).toBe(1);
      expect(race.results.map((r) => r.result?.delivered).sort()).toEqual([
        0, 1,
      ]);
      expect(race.blocked).toBe(false);
    }
    function scheduleContract(race: Awaited<ReturnType<typeof overlap>>) {
      expect(race.results.map((r) => r.type)).toEqual(["result", "result"]);
      expect(
        race.results.map((r) => r.result?.["synthetic-concurrency"]),
      ).toEqual(["ran", "locked"]);
      expect(race.effects).toBe(1);
    }
    async function ingestContract(race: Awaited<ReturnType<typeof overlap>>) {
      expect(race.results.map((r) => r.type)).toEqual(["result", "result"]);
      expect(race.results.map((r) => r.result?.outcome).sort()).toEqual([
        "imported",
        "noop",
      ]);
      expect(race.blocked).toBe(true);
      expect(await ingestRows(db)).toEqual(expectedIngestRows);
      expect(
        (await db.query("SELECT count(*)::int AS count FROM npi_import_run"))
          .rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await db.query(
            "SELECT validation_state FROM snapshot WHERE source_id='cms-nppes'",
          )
        ).rows,
      ).toEqual([{ validation_state: "ACTIVE" }]);
    }

    it("two delivery workers claim one row exactly once without waiting", async () => {
      await seedDelivery();
      deliveryContract(await overlap("delivery"));
      expect(
        (
          await db.query(
            "SELECT attempts, delivered_at IS NOT NULL AS delivered FROM plugin_event_delivery",
          )
        ).rows,
      ).toEqual([{ attempts: 1, delivered: true }]);
    });
    it("overlapping schedule processes run once per minute, including after the winner commits", async () => {
      scheduleContract(await overlap("schedule"));
      const replay = start("schedule");
      expect((await waitFor(replay, "result")).result).toEqual({
        "synthetic-concurrency": "already_ran",
      });
      expect(replay.messages.filter((m) => m.type === "effect")).toHaveLength(
        0,
      );
      const next = start("schedule", modules.schedule.href, false, 1);
      expect((await waitFor(next, "result")).result).toEqual({
        "synthetic-concurrency": "ran",
      });
      expect(next.messages.filter((m) => m.type === "effect")).toHaveLength(1);
    });
    it("concurrent ingest of the same NPPES source preserves every row and imports once", async () => {
      await ingestContract(await overlap("ingest"));
    });

    it.each([
      ["delivery", '"FOR UPDATE OF d SKIP LOCKED"', '""'],
      [
        "schedule",
        "\"SELECT pg_try_advisory_xact_lock(hashtext('schedule:' || $1)) AS locked\"",
        '"SELECT true AS locked WHERE $1::text IS NOT NULL"',
      ],
      ["ingest", '"SELECT pg_advisory_xact_lock(1869636978)"', '"SELECT 1"'],
    ] as const)(
      "mutant: removing the %s lock fails the same concurrency contract",
      async (operation, from, to) => {
        const mutant = await plantMutant(modules[operation], from, to);
        try {
          if (operation === "delivery") await seedDelivery();
          const race = await overlap(
            operation,
            pathToFileURL(mutant.path).href,
          );
          if (operation === "delivery") {
            expect(race.effects).toBe(2);
            expect(() => deliveryContract(race)).toThrow();
          } else if (operation === "schedule") {
            expect(race.effects).toBe(2);
            expect(() => scheduleContract(race)).toThrow();
          } else {
            expect(race.results.map((r) => r.type)).toContain("failure");
            expect(race.results.find((r) => r.type === "failure")?.code).toBe(
              "23505",
            );
            await expect(ingestContract(race)).rejects.toThrow();
          }
        } finally {
          await mutant.cleanup();
        }
      },
    );
  },
);
