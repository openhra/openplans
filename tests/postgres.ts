// Test-only PGlite interface backed by independent databases in a disposable PostgreSQL server.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

function serverUrl(): URL {
  const url = new URL(process.env.OPENPLANS_POSTGRES_TEST_URL ?? "");
  if (
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/openplans_nightly" ||
    !/^openplans-fa14-nightly-[a-zA-Z0-9_.-]+$/.test(
      process.env.OPENPLANS_POSTGIS_CONTAINER ?? "",
    )
  )
    throw new Error("Postgres tests require the disposable nightly container");
  return url;
}

async function admin(sql: string) {
  const client = new pg.Client({ connectionString: serverUrl().href });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

function dumpCommand(command: string, args: string[], input?: string): string {
  serverUrl();
  const result = spawnSync(
    "docker",
    [
      // Docker context comes from DOCKER_CONTEXT (the gate sets the lanes context; CI uses its default).
      "exec",
      "-i",
      process.env.OPENPLANS_POSTGIS_CONTAINER!,
      command,
      "-U",
      "openplans",
      ...args,
    ],
    { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`nightly ${command} failed`);
  return result.stdout;
}

export class PGlite {
  private name = `nightly_${randomBytes(16).toString("hex")}`;
  private client?: pg.Pool;
  private ready?: Promise<void>;
  private closed = false;
  constructor(private options?: { loadDataDir?: Blob }) {}

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("database is closed");
    this.ready ??= (async () => {
      await admin(`CREATE DATABASE ${this.name}`);
      if (this.options?.loadDataDir) {
        dumpCommand(
          "psql",
          ["-X", "-v", "ON_ERROR_STOP=1", "-d", this.name],
          await this.options.loadDataDir.text(),
        );
      }
      const url = serverUrl();
      url.pathname = `/${this.name}`;
      const client = new pg.Pool({ connectionString: url.href, max: 1 });
      await client.query("SELECT 1");
      this.client = client;
    })();
    await this.ready;
  }

  get waitReady() {
    return this.connect();
  }
  async query(sql: string, parameters?: unknown[]) {
    await this.connect();
    return this.client!.query(sql, parameters);
  }
  async exec(sql: string) {
    await this.connect();
    const result = await this.client!.query(sql);
    return Array.isArray(result) ? result : [result];
  }
  async transaction<T>(
    run: (tx: Pick<PGlite, "query" | "exec">) => Promise<T>,
  ): Promise<T> {
    await this.connect();
    const client = await this.client!.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        query: (sql, parameters) => client.query(sql, parameters),
        exec: async (sql) => {
          const result = await client.query(sql);
          return Array.isArray(result) ? result : [result];
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async dumpDataDir(_compression?: string): Promise<Blob> {
    void _compression;
    await this.connect();
    return new Blob([
      dumpCommand("pg_dump", ["--no-owner", "--no-privileges", this.name]),
    ]);
  }
  async clone(): Promise<PGlite> {
    const clone = new PGlite({ loadDataDir: await this.dumpDataDir() });
    await clone.waitReady;
    return clone;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.ready) return;
    await this.ready;
    await this.client?.end();
    this.client = undefined;
    await admin(`DROP DATABASE ${this.name} WITH (FORCE)`);
  }
}
