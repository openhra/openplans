import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import type { ApiOptions } from "../../src/api/routes.js";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Runs the Docker smoke's household checks (scripts/smoke.sh) against the real app on an empty,
// migrated PGlite database, so CI notices when those checks and the server's defaults drift apart.
const checker = fileURLToPath(new URL("./check.mjs", import.meta.url));
let db: Database;

beforeAll(async () => {
  db = testDatabase(new PGlite());
  await migrate(db, (await coreMigrations()).directory);
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function runCheck(options: ApiOptions, mode: string) {
  const server = serve({
    fetch: createApp(db, options).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing loopback port");
    // Asynchronous on purpose. This process serves the checker's requests on its event loop.
    return await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        process.execPath,
        [checker, mode],
        {
          env: { ...process.env, API_PORT: String(address.port) },
          timeout: 10_000,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number(error.code ?? 1) || 1 : 0,
            output: stdout + stderr,
          }),
      );
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("smoke household checks against the app (PGlite, no Docker)", () => {
  it("passes both checks in the configurations smoke starts", async () => {
    // Smoke's first API container: no token, household switch at its default.
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", undefined);
    vi.stubEnv("OPENPLANS_API_TOKEN", undefined);
    const open = await runCheck({}, "anonymous-household");
    expect(open.output).toContain("open by default");
    expect(open.code).toBe(0);
    // Smoke's second API container: OPENPLANS_PUBLIC_HOUSEHOLD=off, still no token.
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", "off");
    const closed = await runCheck({}, "unconfigured-token");
    expect(closed.output).toContain("refused (503)");
    expect(closed.code).toBe(0);
  });

  it("fails each check against the other configuration", async () => {
    // The drift that went unnoticed: the closed-route check run against the open default.
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", undefined);
    vi.stubEnv("OPENPLANS_API_TOKEN", undefined);
    expect((await runCheck({}, "unconfigured-token")).code).not.toBe(0);
    expect(
      (await runCheck({ publicHousehold: false }, "anonymous-household")).code,
    ).not.toBe(0);
  });
});
