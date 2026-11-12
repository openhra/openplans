import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BlobStoreFactory,
  DbProviderFactory,
} from "@openplans/plugin-sdk";
import { loadConfig } from "../../src/config/index.js";
import {
  configureHostBlobStore,
  hostBlobStore,
} from "../../src/fetch/blob/index.js";
import {
  openHostDatabase,
  startHostStorage,
} from "../../src/plugins/host-storage.js";
import { providerTables } from "../../src/plugins/providers.js";

// The built entry points, started as production starts them. The database address is synthetic
// and unreachable; the synthetic providers never connect anywhere.
const dist = (path: string) =>
  fileURLToPath(new URL(`../../dist/${path}`, import.meta.url));
const fixture = fileURLToPath(
  new URL(
    "../fixtures/plugins/synthetic-host-storage/index.mjs",
    import.meta.url,
  ),
);
const DB_MARKER = "synthetic-host-db opened";
const BLOB_MARKER = "synthetic-host-blobs selected";
const refusal = (reason: string) =>
  JSON.stringify({
    plugin: "@openplans/core",
    code: "plugin_provider_unknown",
    reason,
  });

const children = new Set<ChildProcess>();
const cleanup: string[] = [];
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-host-storage-"));
  cleanup.push(directory);
});
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const path of cleanup) await rm(path, { force: true, recursive: true });
  configureHostBlobStore(undefined);
});

async function configFile(name: string, settings: object): Promise<string> {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify({ version: 1, ...settings }));
  return path;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/**
 * Starts one entry point. The API is stopped once it listens, stdio once it answers
 * `initialize`; the worker runs `status` to its end.
 */
function run(
  entry: "api" | "worker" | "stdio",
  env: Record<string, string>,
  file = dist(
    { api: "api/server.js", worker: "worker/cli.js", stdio: "mcp/stdio.js" }[
      entry
    ],
  ),
): Promise<Run> {
  return freePort().then((port) => start(entry, env, file, port));
}

function start(
  entry: "api" | "worker" | "stdio",
  env: Record<string, string>,
  file: string,
  port: number,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      entry === "worker" ? [file, "status"] : [file],
      {
        env: {
          PATH: process.env.PATH,
          HOST: "127.0.0.1",
          PORT: String(port),
          DATABASE_URL:
            "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
          OPENPLANS_MCP_ALLOW_PERSONALIZED: "0",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${entry} did not finish: ${stderr}`));
    }, 20_000);
    child.stdout.on("data", (data) => {
      stdout += String(data);
      if (entry === "api" && stdout.includes("listening"))
        child.kill("SIGTERM");
      if (entry === "stdio" && stdout.includes('"id":1')) child.stdin.end();
    });
    child.stderr.on("data", (data) => (stderr += String(data)));
    child.once("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
    if (entry === "stdio")
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "synthetic-stdio-client", version: "1" },
            capabilities: {},
          },
        }) + "\n",
      );
    else child.stdin.end();
  });
}

/** A copy of a built entry point next to the original, so its relative imports resolve. */
async function mutant(
  path: string,
  edit: (source: string) => string,
): Promise<string> {
  const original = await readFile(dist(path), "utf8");
  const changed = edit(original);
  expect(changed).not.toBe(original);
  const file = dist(path.replace(/([^/]+)$/, ".host-storage-mutant-$1"));
  cleanup.push(file);
  await writeFile(file, changed);
  return file;
}

// The planted bypass: every database open goes straight to the pg pool, as before this change.
const bypass = (source: string) =>
  source
    .replace(
      /^((?:#!.*\n)?)/,
      '$1import { createDatabase as bypassCreate } from "../db/database.js";\n' +
        "const bypassOpen = (config, connection) => bypassCreate(connection ?? config.db.connectionString?.reveal());\n",
    )
    .replaceAll("openHostDatabase(", "bypassOpen(");

const synthetic = (settings: object) => ({
  plugins: [{ package: fixture }],
  ...settings,
});

describe("entry points select storage providers from config (design 5.7)", () => {
  const cases = [
    {
      entry: "api" as const,
      settings: {
        db: { provider: "synthetic-host-db" },
        blobs: { provider: "synthetic-host-blobs" },
      },
      markers: [DB_MARKER, BLOB_MARKER],
    },
    {
      entry: "worker" as const,
      settings: {
        db: { provider: "synthetic-host-db" },
        blobs: { provider: "synthetic-host-blobs" },
      },
      markers: [DB_MARKER, BLOB_MARKER],
    },
    // The stdio host keeps no blob stores, so only its database provider is selected.
    {
      entry: "stdio" as const,
      settings: { db: { provider: "synthetic-host-db" } },
      markers: [DB_MARKER],
    },
  ];

  it.each(cases)(
    "$entry opens the synthetic providers named in the config file",
    async ({ entry, settings, markers }) => {
      const path = await configFile(`select-${entry}`, synthetic(settings));
      const result = await run(entry, { OPENPLANS_CONFIG: path });
      for (const marker of markers) expect(result.stderr).toContain(marker);
    },
    30_000,
  );

  it.each(cases)(
    "negative control: $entry bypassing the registry never opens the synthetic database",
    async ({ entry, settings }) => {
      const path = await configFile(`bypass-${entry}`, synthetic(settings));
      const file = await mutant(
        {
          api: "api/server.js",
          worker: "worker/cli.js",
          stdio: "mcp/stdio.js",
        }[entry],
        bypass,
      );
      const result = await run(entry, { OPENPLANS_CONFIG: path }, file);
      expect(result.stderr).not.toContain(DB_MARKER);
    },
    30_000,
  );

  it.each([
    ["api", "db.provider", { db: { provider: "synthetic-missing" } }],
    ["api", "blobs.provider", { blobs: { provider: "synthetic-missing" } }],
    ["worker", "db.provider", { db: { provider: "synthetic-missing" } }],
    ["worker", "blobs.provider", { blobs: { provider: "synthetic-missing" } }],
    ["stdio", "db.provider", { db: { provider: "synthetic-missing" } }],
    ["stdio", "blobs.provider", { blobs: { provider: "synthetic-missing" } }],
  ] as const)(
    "%s refuses an unknown %s without plugins: one line, exit 1",
    async (entry, reason, settings) => {
      const path = await configFile(`unknown-${entry}-${reason}`, {
        plugins: [],
        ...settings,
      });
      const result = await run(entry, { OPENPLANS_CONFIG: path });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${refusal(reason)}\n`);
    },
    30_000,
  );

  it("refuses an unknown provider with plugins loaded, through the loader", async () => {
    const path = await configFile(
      "unknown-with-plugins",
      synthetic({ db: { provider: "synthetic-missing" } }),
    );
    const result = await run("api", { OPENPLANS_CONFIG: path });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`${refusal("db.provider")}\n`);
  }, 30_000);

  it("negative control: a host check that accepts an unknown provider starts the API", async () => {
    const checker = await mutant("plugins/host-storage.js", (source) =>
      source
        .replace("if (missing) {", "if (false) {")
        .replace("config.db.provider,", '"pg",'),
    );
    const file = await mutant("api/server.js", (source) =>
      source.replace(
        '"../plugins/host-storage.js"',
        JSON.stringify(`../plugins/${checker.split("/").pop()}`),
      ),
    );
    const path = await configFile("unknown-accepted", {
      plugins: [],
      db: { provider: "synthetic-missing" },
    });
    const result = await run("api", { OPENPLANS_CONFIG: path }, file);
    expect(result.stderr).not.toContain(refusal("db.provider"));
    expect(result.stdout).toContain("listening");
  }, 30_000);

  it("without a config file, the API output is unchanged and pg stays selected", async () => {
    const result = await run("api", {});
    expect(result.stdout).toMatch(/^OpenPlans API listening on port \d+\n$/);
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("startHostStorage and openHostDatabase", () => {
  const opened: (string | undefined)[] = [];
  const syntheticDb: DbProviderFactory = ({ connectionString }) => {
    opened.push(connectionString);
    return { synthetic: true } as never;
  };
  const syntheticBlobs: BlobStoreFactory = () =>
    ({
      put: async () => {},
      publish: async () => {},
      get: async () => undefined,
      stat: async () => undefined,
      list: async () => [],
    }) as never;
  const tables = providerTables(undefined, {
    dbProviders: { "synthetic-db": syntheticDb },
    blobStores: { "synthetic-blobs": syntheticBlobs },
  });
  const config = (settings: object) =>
    loadConfig(
      { DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/x" },
      { version: 1, ...settings },
    );

  it("opens the configured provider with the configured or given connection", () => {
    const selected = config({ db: { provider: "synthetic-db" } });
    expect(openHostDatabase(selected, undefined, { tables })).toEqual({
      synthetic: true,
    });
    openHostDatabase(selected, "postgresql://synthetic@127.0.0.1:1/y", {
      tables,
    });
    expect(opened.slice(-2)).toEqual([
      "postgresql://synthetic@127.0.0.1:1/x",
      "postgresql://synthetic@127.0.0.1:1/y",
    ]);
  });

  it("leaves the fetch default unset for local and sets a guarded plugin store", () => {
    startHostStorage(config({}), { tables });
    expect(hostBlobStore()).toBeUndefined();
    startHostStorage(config({ blobs: { provider: "synthetic-blobs" } }), {
      tables,
    });
    expect(Object.keys(hostBlobStore()!).sort()).toEqual([
      "delete",
      "get",
      "list",
      "publish",
      "put",
      "stat",
    ]);
    expect(Object.isFrozen(hostBlobStore())).toBe(true);
    configureHostBlobStore(undefined);
  });

  it("writes the loader's refusal line and exits 1 for an unknown name", () => {
    const lines: string[] = [];
    const exit = (code: number): never => {
      throw new Error(`exit ${code}`);
    };
    expect(() =>
      startHostStorage(config({ db: { provider: "synthetic-missing" } }), {
        tables,
        writeLog: (line) => lines.push(line),
        exit,
      }),
    ).toThrow("exit 1");
    expect(lines).toEqual([refusal("db.provider")]);
  });
});
