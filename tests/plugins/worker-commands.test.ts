import { PGlite } from "@electric-sql/pglite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Database } from "../../src/db/database.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import {
  loadWorkerPlugins,
  matchWorkerCommand,
} from "../../src/plugins/worker.js";
import type { PluginWorkerCommand } from "../../src/plugins/worker.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import * as Registries from "../../src/plugins/registries.js";
import type { PluginHost } from "../../src/plugins/registries.js";
import { coreWorkerCommands, runWorker } from "../../src/worker/commands.js";
import { testDatabase } from "../pglite.js";

// Synthetic plugins written at test time. They carry no source data.
const scratch = await mkdtemp(join(tmpdir(), "openplans-worker-plugins-"));
// Synthetic data dir, set explicitly so the real OPENPLANS_DATA_DIR is never read.
vi.stubEnv("OPENPLANS_DATA_DIR", join(scratch, "data"));
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

const plugin = async (name: string, body: string) => {
  const directory = join(scratch, name);
  await mkdir(directory, { recursive: true });
  const file = join(directory, "index.mjs");
  await writeFile(file, `// Synthetic worker plugin fixture.\n${body}\n`);
  return file;
};
const seen = () =>
  ((
    globalThis as { syntheticWorkerContexts?: Record<string, unknown>[] }
  ).syntheticWorkerContexts ??= []);
const manifest = (name: string, writes?: string[]) =>
  JSON.stringify({
    name: `@synthetic/${name}`,
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["workerCommands"],
    ...(writes ? { capabilities: { writes } } : {}),
  });
const record = `
const record = (entry) => {
  globalThis.syntheticWorkerContexts ??= [];
  globalThis.syntheticWorkerContexts.push(entry);
};`;

const hello = await plugin(
  "hello",
  `${record}
export default {
  manifest: ${manifest("hello")},
  setup(ctx) {
    ctx.workerCommands.add({
      argv: ["plugin", "hello"],
      usage: "Usage: worker plugin hello [NAME]",
      queryTimeoutMs: 12345,
      async run(args, ctx) {
        const rows = (await ctx.db.reader.query("SELECT 41 + 1 AS answer")).rows;
        let readerWrite = "allowed";
        try {
          await ctx.db.reader.exec("CREATE TABLE synthetic_reader_write (id int)");
        } catch {
          readerWrite = "refused";
        }
        record({ command: "hello", args, hasWriter: "writer" in ctx.db, answer: rows[0].answer, readerWrite });
        return args.length === 0 ? 0 : 3;
      },
    });
    ctx.workerCommands.add({
      argv: ["plugin", "quiet"],
      usage: "Usage: worker plugin quiet",
      async run(args) {
        record({ command: "quiet", args });
        return 0;
      },
    });
    ctx.workerCommands.add({
      argv: ["plugin", "boom"],
      usage: "Usage: worker plugin boom",
      async run() {
        throw new Error("synthetic failure with a private detail");
      },
    });
  },
};`,
);
const stager = await plugin(
  "stager",
  `${record}
export default {
  manifest: ${manifest("stager", ["staging"])},
  setup(ctx) {
    ctx.workerCommands.add({
      argv: ["plugin", "stage"],
      usage: "Usage: worker plugin stage",
      async run(args, ctx) {
        await ctx.db.writer.exec("CREATE TABLE synthetic_staged (id int)");
        await ctx.db.writer.query("INSERT INTO synthetic_staged VALUES ($1)", [7]);
        const rows = (await ctx.db.reader.query("SELECT id FROM synthetic_staged")).rows;
        record({ command: "stage", hasWriter: "writer" in ctx.db, rows });
        return 0;
      },
    });
  },
};`,
);
const shadow = (name: string, argv: string[]) =>
  plugin(
    name,
    `export default {
  manifest: ${manifest(name)},
  setup(ctx) {
    ctx.workerCommands.add({ argv: ${JSON.stringify(argv)}, usage: "Usage: worker x", async run() { return 0; } });
  },
};`,
  );

class Exit extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}
const load = async (...files: string[]) => {
  const lines: string[] = [];
  const loaded = await loadWorkerPlugins({
    env: { OPENPLANS_PLUGINS: files.join(",") },
    writeLog: (line) => lines.push(line),
    exit: (code) => {
      throw new Exit(code);
    },
  });
  return { loaded, lines };
};

// The loader itself, on any host, with exit captured instead of ending the process.
const loadOn = async (host: PluginHost, ...files: string[]) => {
  const lines: string[] = [];
  try {
    await loadPlugins(
      loadConfig({ OPENPLANS_PLUGINS: files.join(",") }),
      host,
      {
        writeLog: (line) => lines.push(line),
        exit: (code) => {
          throw new Exit(code);
        },
      },
    );
    return { lines };
  } catch (error) {
    if (error instanceof Exit) return { exit: error.code, lines };
    throw error;
  }
};

interface Run {
  code: number;
  out: string[];
  err: string[];
  opened: (string | undefined)[];
}
it("points OPENPLANS_DATA_DIR at the test's own temp dir", () => {
  expect(process.env.OPENPLANS_DATA_DIR).toBe(join(scratch, "data"));
});
const savedUrl = process.env.DATABASE_URL;
beforeEach(() => {
  seen().length = 0;
  process.env.DATABASE_URL = "postgres://synthetic@localhost:5432/synthetic";
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});
const run = async (
  args: string[],
  commands: readonly PluginWorkerCommand[],
): Promise<Run> => {
  const result: Run = { code: 0, out: [], err: [], opened: [] };
  const openDatabase = (connectionString?: string): Database => {
    result.opened.push(connectionString);
    return testDatabase(new PGlite());
  };
  result.code = await runWorker(
    args,
    openDatabase,
    { out: (line) => result.out.push(line), error: (l) => result.err.push(l) },
    undefined,
    commands,
  );
  return result;
};
const timeoutOf = (connection: string | undefined) =>
  connection === undefined
    ? undefined
    : new URL(connection).searchParams.get("query_timeout");

describe("core worker commands", () => {
  it("registers every existing command with its query timeout", () => {
    expect(
      Object.fromEntries(
        coreWorkerCommands.map(({ argv, queryTimeoutMs }) => [
          argv.join(" "),
          queryTimeoutMs ?? null,
        ]),
      ),
    ).toEqual({
      migrate: 3_600_000,
      status: null,
      "record-policy": 3_600_000,
      "backfill row-provenance": 3_600_000,
      "backfill rate-plan-count": 3_600_000,
      bootstrap: null,
      "ingest sbe": 300_000,
      "ingest state": null,
      "ingest qhp": null,
      "ingest qhp providers": null,
      "ingest qhp formulary": null,
      "ingest qhp discover": null,
      "ingest geocode": null,
      "ingest nppes": null,
      "ingest rxnorm": null,
      "ingest medicare": 3_600_000,
      "ingest taxonomy": null,
      "ingest rating-rules": null,
      "ingest puf": null,
      "ingest puf import": 300_000,
      "ingest puf lineage": 300_000,
      "ingest puf acquire": null,
      "ingest geo": null,
      "deliver-events": 60_000,
      schedule: 60_000,
      "backup-args": null,
      "backup-restored": 3_600_000,
      emit: null,
    });
    for (const { usage } of coreWorkerCommands)
      expect(usage).toMatch(/^Usage: worker /);
  });

  it("matches the argv prefixes the loader reserves", () => {
    expect(coreWorkerCommands.map(({ argv }) => argv)).toEqual(
      Registries.CORE_WORKER_ARGV,
    );
  });

  it("keeps the usage line and exit code on no match", async () => {
    for (const args of [[], ["unknown"], ["status", "extra"], ["ingest"]]) {
      const result = await run(args, []);
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        "Usage: worker migrate [--check|--size-evidence] | status | record-policy list|set|expire | backup-args [--tar|--manifest] | backup-restored --manifest FILE | backfill row-provenance [--table NAME] [--blocks N] | backfill rate-plan-count | ingest puf|qhp|nppes|rxnorm|taxonomy|geo|medicare",
      ]);
      expect(result.opened).toEqual([]);
    }
  });
});

describe("longest argv prefix", () => {
  // Registered short first, so only the sort can pick the longer prefix.
  const table = [
    { argv: ["ingest", "qhp"], id: "qhp" },
    { argv: ["ingest", "qhp", "discover"], id: "discover" },
  ];
  const picks = (match: typeof matchWorkerCommand) =>
    [
      ["ingest", "qhp", "discover", "--year", "2026"],
      ["ingest", "qhp", "discover"],
      ["ingest", "qhp"],
      ["ingest", "qhp", "other"],
      ["ingest"],
    ].map((args) => match(table, args)?.id ?? null);
  const expected = ["discover", "discover", "qhp", "qhp", null];

  it("picks ingest qhp discover over ingest qhp", () => {
    expect(picks(matchWorkerCommand)).toEqual(expected);
  });

  it("dispatches the core commands by the longest prefix", async () => {
    const short = await run(["ingest", "qhp"], []);
    expect(short.err).toEqual(["ingest qhp: not implemented"]);
    const long = await run(["ingest", "qhp", "discover"], []);
    expect(long.err).toEqual([
      "Usage: worker ingest qhp discover --year YYYY --state ST",
    ]);
    expect([short.code, long.code, short.opened, long.opened]).toEqual([
      1,
      1,
      [],
      [],
    ]);
  });

  it("is caught when the sort is dropped (planted mutant)", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/worker.ts", import.meta.url),
      "ordered.sort((a, b) => b.argv.length - a.argv.length);",
      "",
    );
    try {
      const module = (await import(mutant.path)) as {
        matchWorkerCommand: typeof matchWorkerCommand;
      };
      expect(picks(module.matchWorkerCommand)).not.toEqual(expected);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("plugin worker commands", () => {
  it("runs a plugin command with its own query timeout and no writer", async () => {
    const { loaded, lines } = await load(hello);
    expect(lines).toEqual([]);
    const result = await run(["plugin", "hello"], loaded.commands);
    expect(result.code).toBe(0);
    expect(result.opened.map(timeoutOf)).toEqual(["12345"]);
    expect(seen()).toEqual([
      {
        command: "hello",
        args: [],
        hasWriter: false,
        answer: 42,
        readerWrite: "refused",
      },
    ]);
    const extra = await run(["plugin", "hello", "world"], loaded.commands);
    expect(extra.code).toBe(3);
    expect(seen()[1]).toMatchObject({ args: ["world"] });
    await loaded.teardown();
  });

  it("gives db.writer only to a plugin that declared staging writes", async () => {
    const { loaded } = await load(hello, stager);
    expect(
      loaded.commands.map(({ plugin, writer }) => [plugin, writer]),
    ).toEqual([
      ["@synthetic/hello", false],
      ["@synthetic/hello", false],
      ["@synthetic/hello", false],
      ["@synthetic/stager", true],
    ]);
    const result = await run(["plugin", "stage"], loaded.commands);
    expect(result.code).toBe(0);
    expect(result.opened).toEqual([undefined]);
    expect(seen()).toEqual([
      { command: "stage", hasWriter: true, rows: [{ id: 7 }] },
    ]);
  });

  it("uses the pool default without a declared timeout and connects only on use", async () => {
    const { loaded } = await load(hello);
    const quiet = await run(["plugin", "quiet", "a"], loaded.commands);
    expect([quiet.code, quiet.opened, seen()]).toEqual([
      0,
      [],
      [{ command: "quiet", args: ["a"] }],
    ]);
    delete process.env.DATABASE_URL;
    const hi = await run(["plugin", "hello"], loaded.commands);
    expect(hi.opened).toEqual([undefined]);
  });

  it("reports a failing command without its error text", async () => {
    const { loaded } = await load(hello);
    const result = await run(["plugin", "boom"], loaded.commands);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["worker plugin boom failed"]);
  });

  it("leaves core dispatch unchanged when plugins are loaded", async () => {
    const { loaded } = await load(hello);
    const result = await run(["ingest", "puf"], loaded.commands);
    expect(result.err).toEqual(["ingest puf: not implemented"]);
    const none = await run(["plugin"], loaded.commands);
    expect(none.err[0]).toMatch(/^Usage: worker migrate /);
  });

  it.each([
    ["repeat", ["migrate"]],
    ["extend", ["ingest", "qhp", "extra"]],
    ["shorten", ["ingest"]],
  ])(
    "refuses at load, on every host, a plugin that would %s a core argv",
    async (name, argv) => {
      const file = await shadow(name, argv);
      for (const host of ["api", "worker", "stdio"] as const) {
        const result = await loadOn(host, file);
        expect(result.exit).toBe(1);
        expect(result.lines).toEqual([
          JSON.stringify({
            plugin: `@synthetic/${name}`,
            code: "plugin_registration_collision",
          }),
        ]);
      }
      await expect(load(file)).rejects.toMatchObject({ code: 1 });
    },
  );

  it("still refuses a core argv at dispatch for a hand-built command list", async () => {
    const command: PluginWorkerCommand = {
      plugin: "@synthetic/hand-built",
      spec: { argv: ["status"], usage: "Usage: worker x", run: async () => 0 },
      writer: false,
      config: {} as PluginWorkerCommand["config"],
    };
    const result = await run(["plugin", "hello"], [command]);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      JSON.stringify({
        plugin: "@synthetic/hand-built",
        code: "plugin_registration_collision",
      }),
    ]);
    expect(result.opened).toEqual([]);
  });

  it("is caught at load only through the core argv check (planted mutant)", async () => {
    const register = (module: typeof Registries) => {
      const registrar = module.stagingRegistrar(
        module.emptyRegistries(),
        {
          name: "@synthetic/shadow",
          version: "0.0.1",
          apiVersion: "0.1",
          kinds: ["workerCommands"],
        },
        "worker",
        module.emptySeen(),
      );
      try {
        registrar.context.workerCommands.add({
          argv: ["ingest", "qhp"],
          usage: "Usage: worker x",
          run: async () => 0,
        });
      } catch {
        // The refusal is read below.
      }
      return registrar.refusal()?.code;
    };
    expect(register(Registries)).toBe("plugin_registration_collision");
    const mutant = await plantMutant(
      new URL("../../src/plugins/registries.ts", import.meta.url),
      "CORE_WORKER_ARGV.some((core) => argvOverlaps(core, spec.argv))",
      "false",
    );
    try {
      const module = (await import(mutant.path)) as typeof Registries;
      expect(register(module)).toBeUndefined();
    } finally {
      await mutant.cleanup();
    }
  });

  it("loads nothing without plugins or with a configuration that does not parse", async () => {
    for (const env of [{}, { OPENPLANS_CONFIG: "relative.json" }]) {
      const loaded = await loadWorkerPlugins({ env });
      expect(loaded.commands).toEqual([]);
      await loaded.teardown();
    }
  });

  it("exits through the loader on a plugin refusal", async () => {
    const twin = await shadow("twin", ["plugin", "hello"]);
    await expect(load(hello, twin)).rejects.toMatchObject({ code: 1 });
  });
});
