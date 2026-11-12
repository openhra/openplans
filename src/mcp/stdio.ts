#!/usr/bin/env node
import { loadConfig } from "../config/index.js";
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
export function startStdio() {
  const config = loadConfig();
  startHostStorage(config);
  const db = openHostDatabase(config);
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
  } catch {
    await plugins.teardown();
    console.error("MCP startup failed; check DATABASE_URL");
    process.exitCode = 1;
  }
}
