#!/usr/bin/env node
import { EnvironmentOnlyKeyError, loadConfig } from "../config/index.js";
import type { CoreConfig } from "../config/index.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { openHostDatabase, startHostStorage } from "../plugins/host-storage.js";
import { buildServer } from "./server.js";
import { loadApiPlugins } from "../plugins/api.js";
import { configDependencies, configHouseholdOpen } from "./policy.js";
import type { McpEnvironment } from "./policy.js";
import { limits, MAX_OUTPUT_BYTES, MAX_TOOL_LIST_BYTES } from "./tools.js";

/** Local stdio grants household tools by default; OPENPLANS_MCP_ALLOW_PERSONALIZED=0 withholds them. */
export function stdioGranted(env: McpEnvironment): boolean {
  return configStdioGranted(loadConfig(env));
}
function configStdioGranted(config: CoreConfig): boolean {
  const allow = config.mcp.allowPersonalized;
  if (allow === "1") return true;
  if (allow === "0") return false;
  return configHouseholdOpen(config);
}
/**
 * Stdio starts without a database round trip, so discovery works while the database is down.
 * Startup can still fail at two checks: reading the configuration, and opening the database
 * client from `DATABASE_URL` and `db.provider`. A third, the stdio transport, rarely fails.
 * The failure line names the check.
 */
const STARTUP_FAILURES = {
  config:
    "MCP startup failed at the config check; check OPENPLANS_CONFIG and the OPENPLANS_* variables",
  database:
    "MCP startup failed at the database check; check DATABASE_URL and db.provider",
  missingUrl:
    "MCP startup failed at the database check; DATABASE_URL is not set",
} as const;
export class StdioStartupError extends Error {
  constructor(
    readonly check: "config" | "database",
    cause: unknown,
    missingUrl = false,
  ) {
    super(STARTUP_FAILURES[missingUrl ? "missingUrl" : check], { cause });
  }
}
function startupStep<T>(
  check: StdioStartupError["check"],
  run: () => T,
  missingUrl = false,
): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof EnvironmentOnlyKeyError) throw error;
    throw new StdioStartupError(check, error, missingUrl);
  }
}
export function startStdio() {
  const config = startupStep("config", () => loadConfig());
  const db = startupStep(
    "database",
    () => {
      startHostStorage(config);
      return openHostDatabase(config);
    },
    !config.db.connectionString && config.db.provider === "pg",
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: limits.input_bytes,
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    const responseLimit =
      "result" in message && Array.isArray(message.result.tools)
        ? MAX_TOOL_LIST_BYTES
        : MAX_OUTPUT_BYTES;
    if (Buffer.byteLength(JSON.stringify(message)) > responseLimit)
      throw new Error("Response limit");
    await send(message);
  };
  // Local stdio grants the Medicare estimate by the same rules as the other personalized tools.
  const granted = configStdioGranted(config);
  const handle = serveStdio(
    () => buildServer(configDependencies(db, config, granted, granted)),
    {
      legacy: "serve",
      maxSubscriptions: 0,
      transport,
      onerror: () => console.error("MCP protocol error"),
    },
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await db.close();
  };
  const shutdown = () => {
    void close().catch(() => {
      console.error("MCP shutdown failed");
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { close };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  // Plugin MCP tools join the list only once loaded; a refused plugin exits with one line.
  const plugins = await loadApiPlugins({ host: "stdio" });
  try {
    startStdio();
    if (plugins.plugins.length > 0) {
      const stop = () => void plugins.teardown();
      process.stdin.once("end", stop);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    await plugins.teardown();
    console.error(
      error instanceof EnvironmentOnlyKeyError ||
        error instanceof StdioStartupError
        ? error.message
        : "MCP startup failed at the transport check",
    );
    process.exitCode = 1;
  }
}
