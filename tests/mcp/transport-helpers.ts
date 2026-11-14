import { spawn } from "node:child_process";
export const metadata = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "synthetic-transport-client",
    version: "1",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};
export function post(
  method = "server/discover",
  params: Record<string, unknown> = {},
  extra: Record<string, string> = {},
  id: number | undefined = 1,
) {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(["tools/call", "resources/read", "prompts/get"].includes(method)
        ? { "Mcp-Name": String(params.name ?? params.uri) }
        : {}),
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params: { ...params, _meta: metadata },
    }),
  });
}
interface ToolsListBody {
  result: { tools: { name: string }[]; nextCursor?: string };
}
/** Every tool name over HTTP, following nextCursor when present. */
export async function listedToolNames(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  extra: Record<string, string> = {},
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await app.fetch(
      post("tools/list", cursor ? { cursor } : {}, extra),
    );
    const body = (await response.json()) as ToolsListBody;
    names.push(...body.result.tools.map((t: { name: string }) => t.name));
    cursor = body.result.nextCursor;
    if (!cursor) break;
  }
  return names;
}
export async function runStdio(
  file = "dist/mcp/stdio.js",
  grant = false,
  signal?: NodeJS.Signals,
) {
  return new Promise<{ output: string; code: number | null }>(
    (resolve, reject) => {
      // Synthetic unreachable DB address: discovery and limits must not need a live DB.
      const child = spawn(process.execPath, [file], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL:
            "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
          OPENPLANS_MCP_ALLOW_PERSONALIZED: grant ? "1" : "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("stdio did not exit"));
      }, 5000);
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.includes('"id":2')) {
          if (signal) child.kill(signal);
          else child.stdin.end();
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ output, code });
      });
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
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
      );
    },
  );
}
