import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as appModule from "../../src/api/app.js";
import * as gateModule from "../../src/api/schema-gate.js";
import type { SqlSession } from "../../src/db/database.js";
import { loadPluginMigrations, migrate } from "../../src/db/migrate.js";
import { runWorker } from "../../src/worker/commands.js";
import { plantMutantFile } from "../mutant-file.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";

const gateSource = new URL("../../src/api/schema-gate.ts", import.meta.url);
const appSource = new URL("../../src/api/app.ts", import.meta.url);
const RECHECK_MS = 5000;

// One route per surface, plus the health check and the status prefix that stays served.
const DATA_ROUTES: [string, RequestInit?][] = [
  ["/v1/plans?zip=77002&year=2026"],
  ["/v1/data-availability"],
  ["/compat/v1/carriers"],
  [
    "/mcp",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  ],
];

interface Fixture {
  app: {
    request(path: string, init?: RequestInit): Response | Promise<Response>;
  };
  advance(ms: number): void;
  journalReads(): number;
}

type Create = typeof appModule.createApp;
type Gate = typeof gateModule.schemaGate;

/** The checks every copy of the gate and app must pass, from unmigrated to migrated. */
async function expectGate(create: Create, gate: Gate) {
  const pg = new PGlite();
  const core = await coreMigrations();
  try {
    const db = testDatabase(pg);
    let reads = 0;
    const counted: SqlSession = {
      query: (sql, args) => {
        if (sql.includes("schema_migrations")) reads += 1;
        return db.query(sql, args);
      },
      exec: (sql) => db.exec(sql),
    };
    let clock = 1_000_000;
    const fixture: Fixture = {
      app: create(
        db,
        {},
        undefined,
        gate(counted, {
          directory: core.directory,
          recheckMs: RECHECK_MS,
          now: () => clock,
        }),
      ),
      advance: (ms) => {
        clock += ms;
      },
      journalReads: () => reads,
    };
    await expectUnready(fixture);
    // Cached: these requests read the journal once between them.
    expect(fixture.journalReads()).toBe(1);

    // Migrate while the API runs; the cached answer holds until the recheck interval passes.
    await migrate(db, core.directory);
    expect((await fixture.app.request("/readyz")).status).toBe(503);
    fixture.advance(RECHECK_MS);
    await expectReady(fixture);
  } finally {
    await pg.close();
    await core.cleanup();
  }
}

async function expectUnready({ app }: Fixture) {
  // Liveness stays 200, so Compose starts the worker that migrates.
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  const live = (await health.json()) as Record<string, unknown>;
  expect(live).toMatchObject({ status: "ok", db: "ok", schema: "not_ready" });
  expect(live.pending).toBeGreaterThan(0);
  const ready = await app.request("/readyz");
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({
    status: "not_ready",
    reason: "schema_not_ready",
    pending: live.pending,
  });
  for (const [path, init] of DATA_ROUTES) {
    const response = await app.request(path, init);
    expect(response.status, path).toBe(503);
    expect(response.headers.get("retry-after"), path).toBe("5");
    const body = (await response.json()) as {
      error: { code?: unknown; data?: { reason?: string } };
    };
    if (path === "/mcp") {
      expect(body.error.code).toBe(-32000);
      expect(body.error.data?.reason).toBe("schema_not_ready");
    } else expect(body.error.code, path).toBe("schema_not_ready");
  }
  // The status prefix is never gated: without the status plugin it is a plain 404.
  expect((await app.request("/status.json")).status).toBe(404);
  expect((await app.request("/v1/cache-stats")).status).toBe(200);
}

async function expectReady({ app }: Fixture) {
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  // Unchanged from before readiness existed.
  expect(await health.json()).toEqual({ status: "ok", db: "ok" });
  const ready = await app.request("/readyz");
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
  const availability = await app.request("/v1/data-availability");
  expect(availability.status).toBe(200);
  expect(await availability.json()).toEqual([]);
  for (const [path, init] of DATA_ROUTES) {
    const response = await app.request(path, init);
    expect(response.status, path).not.toBe(500);
    expect(await response.text(), path).not.toContain("schema_not_ready");
  }
}

/** The API service's Compose healthcheck script, pointed at `url` instead of port 3000. */
async function composeHealthcheck(url: string): Promise<string> {
  const compose = await readFile(
    new URL("../../compose.yml", import.meta.url),
    "utf8",
  );
  const api = compose.split("\n  api:\n")[1]!.split(/\n {2}[a-z]+:\n/)[0]!;
  const script = /"(fetch\('http:\/\/127\.0\.0\.1:3000\/healthz'\).*)",\n/.exec(
    api,
  )?.[1];
  expect(script).toBeDefined();
  // The worker waits for this check, so it must pass before `worker migrate` can run.
  const worker = compose
    .split("\n  worker:\n")[1]!
    .split(/\n {2}[a-z]+:\n/)[0]!;
  expect(worker).toMatch(/depends_on:\n\s+api:\n\s+condition: service_healthy/);
  return script!.replace("http://127.0.0.1:3000", url);
}

function exitCode(script: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function mutantRejected(
  source: URL,
  before: string,
  after: string,
  run: (planted: never) => Promise<void>,
) {
  const mutant = await plantMutantFile(
    source,
    replaceSyntax(await readFile(source, "utf8"), before, after),
  );
  try {
    const planted = (await import(mutant.url.href)) as never;
    await expect(run(planted)).rejects.toThrow();
  } finally {
    await mutant.cleanup();
  }
}

describe("API schema readiness", () => {
  it("answers 503 schema_not_ready on /readyz and data routes until migrations finish, then serves without a restart", async () => {
    await expectGate(appModule.createApp, gateModule.schemaGate);
  }, 120000);

  it("bootstraps a fresh database the Compose way: healthy API, then worker migrate, then ready", async () => {
    const pg = new PGlite();
    const core = await coreMigrations();
    const db = testDatabase(pg);
    let clock = 0;
    const app = appModule.createApp(
      db,
      {},
      undefined,
      gateModule.schemaGate(db, {
        directory: core.directory,
        now: () => clock,
      }),
    );
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(started),
      );
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const healthcheck = await composeHealthcheck(url);
      // The API comes up and Compose calls it healthy, although nothing is migrated.
      expect(await exitCode(healthcheck)).toBe(0);
      const live = await fetch(`${url}/healthz`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ schema: "not_ready" });
      expect((await fetch(`${url}/readyz`)).status).toBe(503);
      expect((await fetch(`${url}/v1/data-availability`)).status).toBe(503);

      const lines: string[] = [];
      const code = await runWorker(
        ["migrate"],
        () => ({ ...db, close: async () => {} }),
        { out: (line) => lines.push(line), error: (line) => lines.push(line) },
        core.directory,
      );
      expect(code, lines.join("\n")).toBe(0);
      clock += gateModule.SCHEMA_RECHECK_MS;

      const ready = await fetch(`${url}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ready" });
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({
        status: "ok",
        db: "ok",
      });
      expect((await fetch(`${url}/v1/data-availability`)).status).toBe(200);
      expect(await exitCode(healthcheck)).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("does not cache an unreadable database as ready or pending", async () => {
    let fail = true;
    const pg = new PGlite();
    const core = await coreMigrations();
    try {
      const db = testDatabase(pg);
      const flaky: SqlSession = {
        query: (sql, args) =>
          fail ? Promise.reject(new Error("synthetic")) : db.query(sql, args),
        exec: (sql) => db.exec(sql),
      };
      const gate = gateModule.schemaGate(flaky, {
        directory: core.directory,
        now: () => 0,
      });
      expect((await gate.status()).state).toBe("unknown");
      fail = false;
      expect((await gate.status()).state).toBe("pending");
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 60000);

  it("counts enabled plugins' migrations from the same journal", async () => {
    const pg = new PGlite();
    const core = await coreMigrations();
    const plugin = await coreMigrations();
    try {
      const db = testDatabase(pg);
      await migrate(db, core.directory);
      // A synthetic plugin folder: one file inside its own table prefix.
      for (const name of await readdir(plugin.directory))
        await rm(`${plugin.directory}/${name}`);
      await writeFile(
        `${plugin.directory}/001_one.sql`,
        "CREATE TABLE plg_synth_one (v int);",
      );
      const sources = [
        {
          plugin: "synthetic",
          tablePrefix: "synth",
          directory: plugin.directory,
        },
      ];
      let clock = 0;
      const gate = gateModule.schemaGate(db, {
        directory: core.directory,
        plugins: sources,
        now: () => clock,
      });
      expect(await gate.status()).toEqual({ state: "pending", pending: 1 });
      // The worker's migrate applies the plugin file and journals it as plugin:synthetic/001_one.sql.
      expect(
        await migrate(db, core.directory, await loadPluginMigrations(sources)),
      ).toEqual(["plugin:synthetic/001_one.sql"]);
      clock += gateModule.SCHEMA_RECHECK_MS;
      expect(await gate.status()).toEqual({ state: "ready", pending: 0 });
    } finally {
      await pg.close();
      await core.cleanup();
      await plugin.cleanup();
    }
  }, 60000);

  it("is wired into both API servers", async () => {
    for (const name of ["server.ts", "pglite.ts"]) {
      const text = await readFile(
        new URL(`../../src/api/${name}`, import.meta.url),
        "utf8",
      );
      expect(text, name).toMatch(/\n\s+schemaGate\(db[,)]/);
    }
    expect(
      await readFile(
        new URL("../../src/api/server.ts", import.meta.url),
        "utf8",
      ),
    ).toContain("schemaGate(db, { plugins: plugins.migrations })");
  });

  it("rejects a planted gate that lets data routes fail with a 500", async () => {
    await mutantRejected(
      gateSource,
      'if ((await status()).state !== "pending") return next();',
      "return next();",
      (planted: Pick<typeof gateModule, "schemaGate">) =>
        expectGate(appModule.createApp, planted.schemaGate),
    );
  }, 120000);

  it("rejects a planted health check that answers 503 while migrations are pending", async () => {
    await mutantRejected(
      appSource,
      "pending: schemaStatus.pending, }, 200,",
      "pending: schemaStatus.pending, }, 503,",
      (planted: Pick<typeof appModule, "createApp">) =>
        expectGate(planted.createApp, gateModule.schemaGate),
    );
  }, 120000);

  it("rejects a planted health check that hides a pending schema", async () => {
    await mutantRejected(
      appSource,
      'if (schemaStatus?.state === "pending")',
      "if (false)",
      (planted: Pick<typeof appModule, "createApp">) =>
        expectGate(planted.createApp, gateModule.schemaGate),
    );
  }, 120000);

  it("rejects a planted readiness check that says ready while migrations are pending", async () => {
    await mutantRejected(
      appSource,
      'if (schemaStatus.state === "pending")',
      "if (false)",
      (planted: Pick<typeof appModule, "createApp">) =>
        expectGate(planted.createApp, gateModule.schemaGate),
    );
  }, 120000);
});
