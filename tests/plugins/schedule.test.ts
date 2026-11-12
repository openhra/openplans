import { PGlite } from "@electric-sql/pglite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ScheduleSpec } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import * as Registries from "../../src/plugins/registries.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import type { PluginWorkerCommand } from "../../src/plugins/worker.js";
import { runWorker } from "../../src/worker/commands.js";
import {
  CORE_SCHEDULES,
  CronError,
  cronMatches,
  parseCron,
  runScheduleTick,
} from "../../src/worker/schedule.js";
import type * as ScheduleModule from "../../src/worker/schedule.js";
import type { Dispatch, ScheduledCommand } from "../../src/worker/schedule.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { concurrentSessions } from "../worker-events-sessions.js";

// Synthetic schedules only.
let pg: PGlite;
let db: Database;
let cleanupMigrations: () => Promise<void>;
beforeAll(async () => {
  pg = new PGlite();
  db = testDatabase(pg);
  const core = await coreMigrations();
  cleanupMigrations = core.cleanup;
  await migrate(db, core.directory);
});
afterAll(async () => {
  await db.close();
  await cleanupMigrations();
});
beforeEach(async () => {
  await db.exec("DELETE FROM plugin_state; DELETE FROM plugin_event_outbox;");
});

describe("cron parser", () => {
  // 2026-11-11 is a Wednesday (day 3).
  const cases: [string, string, boolean][] = [
    ["* * * * *", "2026-11-11T12:34:56Z", true],
    ["34 12 * * *", "2026-11-11T12:34:00Z", true],
    ["34 12 * * *", "2026-11-11T12:35:00Z", false],
    ["*/15 * * * *", "2026-11-11T12:45:00Z", true],
    ["*/15 * * * *", "2026-11-11T12:46:00Z", false],
    ["5/20 * * * *", "2026-11-11T12:45:00Z", true],
    ["5/20 * * * *", "2026-11-11T12:40:00Z", false],
    ["0-10/5 * * * *", "2026-11-11T12:10:00Z", true],
    ["0-10/5 * * * *", "2026-11-11T12:15:00Z", false],
    ["0 9-17 * * 1-5", "2026-11-11T13:00:00Z", true],
    ["0 9-17 * * 1-5", "2026-11-14T13:00:00Z", false],
    ["0 0 * * 0", "2026-11-15T00:00:00Z", true],
    ["0 0 * * 7", "2026-11-15T00:00:00Z", true],
    ["0 0 1,15 * *", "2026-11-15T00:00:00Z", true],
    ["0 0 1,15 * *", "2026-11-14T00:00:00Z", false],
    ["0 0 * 12 *", "2026-11-01T00:00:00Z", false],
    ["0 0 * 11 *", "2026-11-01T00:00:00Z", true],
    // Both day fields restricted: either matches.
    ["0 0 13 * 3", "2026-11-11T00:00:00Z", true],
    ["0 0 13 * 3", "2026-11-13T00:00:00Z", true],
    ["0 0 13 * 3", "2026-11-12T00:00:00Z", false],
    // Only one restricted: both must match.
    ["0 0 11 * *", "2026-11-11T00:00:00Z", true],
    ["0 0 * * 4", "2026-11-11T00:00:00Z", false],
    ["59 23 31 12 *", "2026-12-31T23:59:00Z", true],
  ];
  it.each(cases)("%s at %s is %s", (expression, time, expected) => {
    expect(cronMatches(parseCron(expression), new Date(time))).toBe(expected);
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 13 *",
    "* * * * 8",
    "5-1 * * * *",
    "*/0 * * * *",
    "1-2-3 * * * *",
    "*/5/2 * * * *",
    ", * * * *",
    "a * * * *",
    "* * * JAN *",
    "-1 * * * *",
    "01 * * * *",
    "@hourly",
  ])("refuses %j", (expression) => {
    expect(() => parseCron(expression)).toThrow(CronError);
  });
});

describe("core schedules", () => {
  it("deliver-events runs every minute and its name is reserved", () => {
    expect(CORE_SCHEDULES).toEqual([
      {
        name: "deliver-events",
        cron: "* * * * *",
        command: ["deliver-events"],
        maxRunMs: 55_000,
      },
    ]);
    expect(CORE_SCHEDULES.map(({ name }) => name)).toEqual(
      Registries.CORE_SCHEDULE_NAMES,
    );
  });

  const register = (spec: ScheduleSpec) => {
    const registrar = Registries.stagingRegistrar(
      Registries.emptyRegistries(),
      {
        name: "@synthetic/scheduler",
        version: "0.0.1",
        apiVersion: "0.1",
        kinds: ["schedules"],
      },
      "worker",
      Registries.emptySeen(),
    );
    try {
      registrar.context.schedules.add(spec);
    } catch {
      // Read below.
    }
    return registrar.refusal()?.code;
  };
  it("refuses a plugin schedule that takes a core name or starts the scheduler", () => {
    const base = { cron: "* * * * *", maxRunMs: 1_000 };
    expect(register({ ...base, name: "deliver-events", command: ["x"] })).toBe(
      "plugin_registration_collision",
    );
    expect(
      register({ ...base, name: "loop", command: ["schedule", "run"] }),
    ).toBe("plugin_registration_invalid");
    expect(
      register({ ...base, name: "fine", command: ["synthetic", "x"] }),
    ).toBeUndefined();
  });
});

const T = Date.parse("2026-11-11T12:00:00.000Z");
const minute =
  (n: number, seconds = 0) =>
  () =>
    new Date(T + n * 60_000 + seconds * 1_000);
const every = (name: string, maxRunMs = 5_000): ScheduledCommand => ({
  plugin: "@synthetic/scheduler",
  spec: { name, cron: "* * * * *", command: ["synthetic", name], maxRunMs },
});

describe("schedule ticks", () => {
  it("runs only schedules whose cron matches this minute", async () => {
    const ran: string[][] = [];
    const dispatch: Dispatch = async (argv) => {
      ran.push(argv);
      return 0;
    };
    const hourly: ScheduledCommand = {
      plugin: "@synthetic/scheduler",
      spec: {
        name: "hourly",
        cron: "0 * * * *",
        command: ["synthetic", "hourly"],
        maxRunMs: 1_000,
      },
    };
    expect(
      await runScheduleTick(db, [every("a"), hourly], dispatch, {
        now: minute(1),
      }),
    ).toEqual({ a: "ran" });
    expect(
      await runScheduleTick(db, [every("a"), hourly], dispatch, {
        now: minute(2),
      }),
    ).toEqual({ a: "ran" });
    expect(
      await runScheduleTick(db, [hourly], dispatch, { now: minute(60) }),
    ).toEqual({ hourly: "ran" });
    expect(ran).toEqual([
      ["synthetic", "a"],
      ["synthetic", "a"],
      ["synthetic", "hourly"],
    ]);
  });

  it("the lock prevents a second run while the first holds it, and the tick record after", async () => {
    const sessions = concurrentSessions(pg);
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<number>((resolve) => (finish = () => resolve(0)));
    let runs = 0;
    const slow: Dispatch = async () => {
      runs += 1;
      started();
      return gate;
    };
    const first = runScheduleTick(sessions, [every("guarded")], slow, {
      now: minute(5),
    });
    await running;
    const second = await runScheduleTick(sessions, [every("guarded")], slow, {
      now: minute(5, 30),
    });
    expect(second).toEqual({ guarded: "locked" });
    finish();
    expect(await first).toEqual({ guarded: "ran" });
    const third = await runScheduleTick(sessions, [every("guarded")], slow, {
      now: minute(5, 45),
    });
    expect(third).toEqual({ guarded: "already_ran" });
    expect(runs).toBe(1);
    const next = await runScheduleTick(
      sessions,
      [every("guarded")],
      async () => 0,
      {
        now: minute(6),
      },
    );
    expect(next).toEqual({ guarded: "ran" });
    const { rows } = await db.query(
      "SELECT plugin, key, value FROM plugin_state WHERE key = 'core:schedule:guarded'",
    );
    expect(rows).toEqual([
      {
        plugin: "openplans",
        key: "core:schedule:guarded",
        value: { tick: new Date(T + 6 * 60_000).toISOString() },
      },
    ]);
  });

  it("mutant: without the lock check the second runner runs the schedule again", async () => {
    const mutant = await plantMutant(
      new URL("../../src/worker/schedule.ts", import.meta.url),
      'if (!rows[0]?.locked) return "locked" as const;',
      "",
    );
    try {
      const source = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof ScheduleModule;
      const sessions = concurrentSessions(pg);
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      let finish!: () => void;
      const gate = new Promise<number>(
        (resolve) => (finish = () => resolve(0)),
      );
      let runs = 0;
      const slow: Dispatch = async () => {
        runs += 1;
        started();
        return runs === 1 ? gate : 0;
      };
      const first = source.runScheduleTick(sessions, [every("guarded")], slow, {
        now: minute(7),
      });
      await running;
      // The emulated sessions do not hide uncommitted rows, so clear the first runner's record as
      // PostgreSQL's isolation would.
      await db.exec(
        "DELETE FROM plugin_state WHERE key = 'core:schedule:guarded'",
      );
      const second = await source.runScheduleTick(
        sessions,
        [every("guarded")],
        slow,
        {
          now: minute(7, 30),
        },
      );
      finish();
      await first;
      expect(second).toEqual({ guarded: "ran" });
      expect(runs).toBe(2);
    } finally {
      await mutant.cleanup();
    }
  });

  it("mutant: without the tick record a later runner repeats the minute", async () => {
    const mutant = await plantMutant(
      new URL("../../src/worker/schedule.ts", import.meta.url),
      "new Date(previous).getTime() >= tick.getTime()",
      "false",
    );
    try {
      const source = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof ScheduleModule;
      let runs = 0;
      const dispatch: Dispatch = async () => {
        runs += 1;
        return 0;
      };
      await source.runScheduleTick(db, [every("twice")], dispatch, {
        now: minute(8),
      });
      await source.runScheduleTick(db, [every("twice")], dispatch, {
        now: minute(8, 30),
      });
      expect(runs).toBe(2);
    } finally {
      await mutant.cleanup();
    }
  });

  it("stops waiting at maxRunMs and aborts the run's signal", async () => {
    let signal: AbortSignal | undefined;
    let limit: number | undefined;
    const hang: Dispatch = (_argv, run) => {
      signal = run.signal;
      limit = run.timeoutMs;
      return new Promise<number>(() => {});
    };
    const started = performance.now();
    expect(
      await runScheduleTick(db, [every("hang", 50)], hang, { now: minute(9) }),
    ).toEqual({ hang: "timed_out" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect([signal?.aborted, limit]).toEqual([true, 50]);
  });

  it("reports a failing command and an invalid cron", async () => {
    const bad: ScheduledCommand = {
      plugin: "@synthetic/scheduler",
      spec: { name: "bad", cron: "61 * * * *", command: ["x"], maxRunMs: 10 },
    };
    expect(
      await runScheduleTick(db, [every("fails"), bad], async () => 3, {
        now: minute(10),
      }),
    ).toEqual({ fails: "failed", bad: "invalid" });
  });
});

describe("worker schedule run", () => {
  const command: PluginWorkerCommand = {
    plugin: "@synthetic/scheduler",
    spec: {
      argv: ["synthetic", "tick"],
      usage: "Usage: worker synthetic tick",
      run: async () => {
        ticks += 1;
        return 0;
      },
    },
    writer: false,
    config: {} as PluginWorkerCommand["config"],
  };
  let ticks = 0;
  const run = async (args: string[], signal?: AbortSignal) => {
    const out: string[] = [];
    const err: string[] = [];
    // The scheduler holds a transaction while the command runs on its own connection; one PGlite
    // session can only do that through the simulated sessions.
    const sessions = concurrentSessions(pg);
    const code = await runWorker(
      args,
      () => ({ ...sessions, close: async () => {} }),
      { out: (l) => out.push(l), error: (l) => err.push(l) },
      undefined,
      [command],
      {
        schedules: [
          {
            plugin: "@synthetic/scheduler",
            spec: {
              name: "synthetic-tick",
              cron: "* * * * *",
              command: ["synthetic", "tick"],
              maxRunMs: 5_000,
            },
          },
          {
            plugin: "@synthetic/scheduler",
            spec: {
              name: "synthetic-nested",
              cron: "* * * * *",
              command: ["schedule", "run"],
              maxRunMs: 5_000,
            },
          },
        ],
        run: signal ? { signal } : undefined,
      },
    );
    return { code, out, err };
  };

  it("runs core and plugin schedules in process; a schedule cannot start the scheduler", async () => {
    ticks = 0;
    const result = await run(["schedule", "run"]);
    expect(JSON.parse(result.out.at(-1)!)).toEqual({
      "deliver-events": "ran",
      "synthetic-tick": "ran",
      "synthetic-nested": "failed",
    });
    expect(result.code).toBe(1);
    expect(ticks).toBe(1);
  });

  it("--loop ends after its tick when the stop signal is aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const result = await run(["schedule", "run", "--loop"], stop.signal);
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
  });

  it("prints usage on bad arguments", async () => {
    for (const args of [
      ["schedule"],
      ["schedule", "go"],
      ["schedule", "run", "--forever"],
    ]) {
      const result = await run(args);
      expect(result).toEqual({
        code: 1,
        out: [],
        err: ["Usage: worker schedule run [--loop]"],
      });
    }
  });
});
