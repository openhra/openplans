import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { probeDatabase } from "../../src/mcp/stdio.js";
import { approvedTestEnvironment } from "../plugins/approval-helpers.js";

const URL_WITH_SECRET =
  "postgresql://synthetic:hunter2-secret@127.0.0.1:1/synthetic";
const failing = (code?: string, delay = 0) => ({
  query: async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    throw Object.assign(new Error(`failed ${URL_WITH_SECRET}`), { code });
  },
});
const run = async (
  db: Parameters<typeof probeDatabase>[0],
  timeout?: number,
) => {
  const lines: string[] = [];
  await probeDatabase(db, (line) => lines.push(line), timeout);
  return lines;
};

describe("stdio database probe", () => {
  it("prints nothing on success and reads the migrations table", async () => {
    const sql: string[] = [];
    const lines = await run({
      query: async (text: string) => {
        sql.push(text);
        return { rows: [] };
      },
    } as never);
    expect(lines).toEqual([]);
    expect(sql).toEqual([
      "select 1",
      "select 1 from public.schema_migrations limit 1",
    ]);
  });

  it.each([
    [undefined, "connection step; check DATABASE_URL"],
    ["28P01", "authentication step; check the password in DATABASE_URL"],
    ["42P01", "schema step; run `worker migrate`"],
  ])("names the step for code %s", async (code, tail) => {
    const lines = await run(failing(code) as never);
    expect(lines).toEqual([
      `MCP startup: database probe failed at the ${tail}`,
    ]);
    expect(lines.join("")).not.toContain("hunter2");
  });

  it("reports the connection step when the database hangs past the limit", async () => {
    const lines = await run(failing("28P01", 500) as never, 30);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("connection step");
  });
});

describe("stdio probe in a real process", () => {
  const stdio = new URL("../../dist/mcp/stdio.js", import.meta.url).pathname;
  async function start(extra: Record<string, string>) {
    const env = await approvedTestEnvironment({
      DATABASE_URL: URL_WITH_SECRET,
      OPENPLANS_MCP_ALLOW_PERSONALIZED: "0",
      ...extra,
    });
    const child = spawn(process.execPath, [stdio], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "synthetic", version: "1" },
          capabilities: {},
        },
      }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }) +
        "\n",
    );
    const deadline = Date.now() + 8_000;
    while (!out.includes('"id":2') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    return { out, err };
  }

  it("answers tools/list and prints the probe line for an unreachable database", async () => {
    const { out, err } = await start({});
    expect(out).toContain('"id":2');
    expect(err.trim()).toBe(
      "MCP startup: database probe failed at the connection step; check DATABASE_URL",
    );
    expect(err).not.toContain("hunter2");
  }, 20_000);

  it("is silent when OPENPLANS_MCP_STDIO_PROBE=0", async () => {
    const { out, err } = await start({ OPENPLANS_MCP_STDIO_PROBE: "0" });
    expect(out).toContain('"id":2');
    expect(err).toBe("");
  }, 20_000);
});
