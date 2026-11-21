import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfigView, loadConfig } from "../../src/config/index.js";
import type { Environment } from "../../src/config/index.js";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { coreApplicationVersion } from "../../src/plugins/status-host.js";
import {
  recordUsageReportVersion,
  readUsageReportState,
  schedulerSeen,
} from "../../src/usage-report/state.js";
import {
  startupLine,
  startUsageReport,
} from "../../src/usage-report/startup.js";
import { usageReportSchema } from "../../src/usage-report/schema.js";
import type * as CliModule from "../../src/usage-report/cli.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { readFile, readdir } from "node:fs/promises";

const loaded = vi.hoisted(() => ({ sender: 0 }));
vi.mock("../../src/usage-report/send.js", async (importOriginal) => {
  loaded.sender += 1;
  return importOriginal();
});

const configFor = (env: Environment = {}) => loadConfig(env);
const WRITE = /\b(insert|update|delete|create|alter|drop|truncate)\b/i;

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (m: string) => out.push(m), error: (m: string) => err.push(m) },
  };
}

/** A database that records every statement it is asked to run. */
function watched(db: Database) {
  const statements: string[] = [];
  const seen = <T extends (sql: string, ...rest: never[]) => unknown>(f: T) =>
    ((sql: string, ...rest: never[]) => {
      statements.push(sql);
      return f(sql, ...rest);
    }) as T;
  const wrapped: Database = {
    ...db,
    query: seen(db.query.bind(db)),
    exec: seen(db.exec.bind(db)),
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          ...tx,
          query: seen(tx.query.bind(tx)),
          exec: seen(tx.exec.bind(tx)),
        }),
      ),
    close: async () => {},
  };
  return { db: wrapped, statements };
}

const keep = (database: Database): Database => ({
  ...database,
  close: async () => {},
});
let db: Database;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  vi.resetModules();
  loaded.sender = 0;
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await migrate(db, core.directory);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.close();
  await cleanup();
});

const cli = async () => import("../../src/usage-report/cli.js");

describe("usageReport configuration", () => {
  it("is off by default and on only for the exact value on", () => {
    expect(configFor().usageReport.enabled).toBe(false);
    for (const value of [
      "yes",
      "1",
      "true",
      "ON",
      "On",
      " on",
      "on ",
      "",
      "off",
    ])
      expect(
        configFor({ OPENPLANS_USAGE_REPORT: value }).usageReport.enabled,
        value,
      ).toBe(false);
    expect(
      configFor({ OPENPLANS_USAGE_REPORT: "on" }).usageReport.enabled,
    ).toBe(true);
  });

  it("takes the file key, and the variable wins over it", () => {
    const file = { version: 1, usageReport: { enabled: true } };
    expect(loadConfig({}, file).usageReport.enabled).toBe(true);
    expect(
      loadConfig({ OPENPLANS_USAGE_REPORT: "off" }, file).usageReport.enabled,
    ).toBe(false);
  });

  it("accepts only an https address without user info or a query", () => {
    const url = (value: string) =>
      loadConfig({}, { version: 1, usageReport: { url: value } });
    expect(configFor().usageReport.url).toBe(
      "https://openplans.openhra.com/v1/usage-reports",
    );
    expect(url("https://collector.example/v1/x").usageReport.url).toContain(
      "collector.example",
    );
    for (const bad of [
      "http://collector.example/x",
      `https://user:secret${"@"}collector.example/x`,
      "https://collector.example/x?token=1",
      "https://collector.example/x?",
      "not a url",
    ])
      expect(() => url(bad), bad).toThrow();
  });

  it("does not hand the address to plugins", () => {
    const view = coreConfigView(configFor({ OPENPLANS_USAGE_REPORT: "on" }));
    expect(view.usageReport).toEqual({ enabled: true });
  });
});

describe("startup line", () => {
  it("is plain, always logged and names only the host and path", () => {
    const lines: string[] = [];
    startUsageReport(configFor(), (line) => lines.push(line));
    expect(lines).toEqual(["usage report: off (see docs/usage-report.md)"]);
    const on = configFor({ OPENPLANS_USAGE_REPORT: "on" });
    expect(startupLine(on)).toBe(
      "usage report: on; daily to https://openplans.openhra.com/v1/usage-reports; see docs/usage-report.md",
    );
  });
});

describe("off by default", () => {
  it("registers no timer, loads no sender and writes nothing at start or in show", async () => {
    const timers = [
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
    ];
    const open = vi.fn(() => {
      throw new Error("the database must not be opened");
    });
    const { runUsageReport } = await cli();
    startUsageReport(configFor(), () => {});
    const sink = output();
    expect(await runUsageReport(["show"], configFor(), open, sink.io)).toBe(0);
    expect(sink.out[0]!.split("\n")[0]).toBe("state: off");
    expect(sink.out.join("\n")).not.toContain("usage_report.failed");
    expect(
      (JSON.parse(sink.out.at(-1)!) as { install_id: unknown }).install_id,
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(loaded.sender).toBe(0);
    for (const spy of timers) expect(spy).not.toHaveBeenCalled();
    expect((await db.query("SELECT * FROM usage_report_state")).rows).toEqual(
      [],
    );
  });

  it("starting the API code path adds no sender import to any other module", async () => {
    const importers: string[] = [];
    const walk = async (folder: URL) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const url = new URL(
          entry.name + (entry.isDirectory() ? "/" : ""),
          folder,
        );
        if (entry.isDirectory()) await walk(url);
        else if (entry.name.endsWith(".ts")) {
          const source = await readFile(url, "utf8");
          if (/usage-report\/send|\.\/send\.js/.test(source))
            importers.push(url.pathname.split("/src/")[1]!);
        }
      }
    };
    await walk(new URL("../../src/", import.meta.url));
    expect(importers.filter((name) => name !== "usage-report/lazy.ts")).toEqual(
      [],
    );
  });
});

describe("worker usage-report", () => {
  it("is a registered core command with its own usage line", async () => {
    const { coreWorkerCommands } = await import("../../src/worker/commands.js");
    const command = coreWorkerCommands.find(
      (entry) => entry.argv.join(" ") === "usage-report",
    );
    expect(command?.usage).toBe(
      "Usage: worker usage-report show | send --dry-run | reset",
    );
  });

  it("show with the report on reads state and never writes", async () => {
    const { runUsageReport } = await cli();
    await recordUsageReportVersion(db, "0.0.1");
    await recordUsageReportVersion(db, coreApplicationVersion()!);
    const probe = watched(db);
    const sink = output();
    const on = configFor({ OPENPLANS_USAGE_REPORT: "on" });
    expect(await runUsageReport(["show"], on, () => probe.db, sink.io)).toBe(0);
    expect(sink.out[0]!.split("\n")[0]).toBe("state: on");
    expect(probe.statements.length).toBeGreaterThan(0);
    expect(probe.statements.filter((sql) => WRITE.test(sql))).toEqual([]);
    const report = usageReportSchema.parse(JSON.parse(sink.out.at(-1)!));
    expect(report.previous_version).toBe("0.0.1");
    expect(report.last_migration?.from).toBe("0.0.1");
    expect(loaded.sender).toBe(0);
  });

  it("send --dry-run prints the body, loads the sender and sends nothing", async () => {
    const { runUsageReport } = await cli();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network is not allowed"));
    const sink = output();
    expect(
      await runUsageReport(
        ["send", "--dry-run"],
        configFor({ OPENPLANS_USAGE_REPORT: "on" }),
        () => keep(db),
        sink.io,
      ),
    ).toBe(0);
    expect(sink.out[0]).toBe("dry run: nothing is sent");
    usageReportSchema.parse(JSON.parse(sink.out.at(-1)!));
    expect(loaded.sender).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses send without --dry-run and unknown forms", async () => {
    const { runUsageReport } = await cli();
    for (const args of [["send"], ["send", "--now"], ["show", "x"], []]) {
      const sink = output();
      expect(
        await runUsageReport(args, configFor(), () => keep(db), sink.io),
      ).toBe(1);
      expect(sink.out).toEqual([]);
    }
    expect(loaded.sender).toBe(0);
  });

  it("reset clears the state and says so when there is none", async () => {
    const { runUsageReport } = await cli();
    const sink = output();
    expect(
      await runUsageReport(["reset"], configFor(), () => keep(db), sink.io),
    ).toBe(0);
    expect(sink.out).toEqual(["usage report: no state to clear"]);
    await recordUsageReportVersion(db, "0.4.16");
    expect(
      await runUsageReport(["reset"], configFor(), () => keep(db), sink.io),
    ).toBe(0);
    expect(sink.out.at(-1)).toBe("usage report: state cleared");
    expect(await readUsageReportState(db)).toBeNull();
  });
});

describe("state", () => {
  it("keeps the previous version across restarts and upgrades", async () => {
    expect(await readUsageReportState(db)).toBeNull();
    await recordUsageReportVersion(db, "0.4.15");
    await recordUsageReportVersion(db, "0.4.15");
    expect((await readUsageReportState(db))?.previousVersion).toBeNull();
    await recordUsageReportVersion(db, "0.4.16");
    await recordUsageReportVersion(db, "0.4.16");
    const state = await readUsageReportState(db);
    expect(state?.version).toBe("0.4.16");
    expect(state?.previousVersion).toBe("0.4.15");
  });

  it("detects the scheduler from a recent core schedule tick", async () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(await schedulerSeen(db, now)).toBe(false);
    const tick = (at: string) =>
      db.query(
        `INSERT INTO plugin_state (plugin, key, value)
         VALUES ('openplans', 'core:schedule:deliver-events', jsonb_build_object('tick', $1::text))
         ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value`,
        [at],
      );
    await tick("2026-11-10T12:00:00Z");
    expect(await schedulerSeen(db, now)).toBe(false);
    await tick("2026-11-21T11:59:00Z");
    expect(await schedulerSeen(db, now)).toBe(true);
  });
});

describe("planted mutants", () => {
  const config = new URL("../../src/config/index.ts", import.meta.url);
  const cliFile = new URL("../../src/usage-report/cli.ts", import.meta.url);

  it("default flipped on is caught", async () => {
    const source = (await readFile(config, "utf8")).replace(
      "enabled: z.boolean().default(false),\n      url:",
      "enabled: z.boolean().default(true),\n      url:",
    );
    expect(source).toContain("default(true),\n      url:");
    await withMutantFile(config, source, async (file) => {
      const mutant = await importMutant<{ loadConfig: typeof loadConfig }>(
        file,
        "loadConfig",
      );
      expect(mutant.loadConfig({}).usageReport.enabled).toBe(true);
      expect(configFor().usageReport.enabled).toBe(false);
    });
  });

  it("a value other than exactly on enabling it is caught", async () => {
    const source = (await readFile(config, "utf8")).replace(
      'if (onlyOn.has(name)) return value === "on";',
      'if (onlyOn.has(name)) return value !== "off";',
    );
    expect(source).toContain('value !== "off";');
    await withMutantFile(config, source, async (file) => {
      const mutant = await importMutant<{ loadConfig: typeof loadConfig }>(
        file,
        "loadConfig",
      );
      expect(
        mutant.loadConfig({ OPENPLANS_USAGE_REPORT: "yes" }).usageReport
          .enabled,
      ).toBe(true);
      expect(
        configFor({ OPENPLANS_USAGE_REPORT: "yes" }).usageReport.enabled,
      ).toBe(false);
    });
  });

  it("show writing to the database is caught", async () => {
    const source = (await readFile(cliFile, "utf8")).replace(
      "const { facts, state } = await gatherUsageReportFacts({ config, db });",
      `await db?.query("INSERT INTO usage_report_state (singleton, version) VALUES (true, '0.0.0') ON CONFLICT DO NOTHING");
    const { facts, state } = await gatherUsageReportFacts({ config, db });`,
    );
    expect(source).toContain("INSERT INTO usage_report_state");
    await withMutantFile(cliFile, source, async (file) => {
      const mutant = await importMutant<typeof CliModule>(
        file,
        "runUsageReport",
      );
      const probe = watched(db);
      const sink = output();
      await mutant.runUsageReport(
        ["show"],
        configFor({ OPENPLANS_USAGE_REPORT: "on" }),
        () => probe.db,
        sink.io,
      );
      expect(probe.statements.filter((sql) => WRITE.test(sql))).not.toEqual([]);
    });
  });
});
