import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { metadata } from "../mcp/transport-helpers.js";

// The built entry points, started as production starts them. The database address is synthetic
// and unreachable: the status plugin reports `db: "down"` and still answers.
const server = new URL("../../dist/api/server.js", import.meta.url).pathname;
const stdio = new URL("../../dist/mcp/stdio.js", import.meta.url).pathname;
const STATUS = "@openplans/plugin-status";
// Synthetic operator token, used only by this test.
const TOKEN = "synthetic-operator-token-wire1-0123456789";
const baseEnv = {
  PATH: process.env.PATH,
  HOST: "127.0.0.1",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
};
const children = new Set<ChildProcess>();
const mutants: string[] = [];
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const file of mutants) await rm(file, { force: true, recursive: true });
});

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

interface Started {
  port: number;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<number | null>;
}

async function startApi(
  env: Record<string, string>,
  file = server,
): Promise<Started> {
  const port = await freePort();
  const child = spawn(process.execPath, [file], {
    env: { ...baseEnv, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (data) => (out += String(data)));
  child.stderr.on("data", (data) => (err += String(data)));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      children.delete(child);
      resolve(code);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("API did not start")),
      15_000,
    );
    const check = () => {
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`API exited: ${err}`));
    });
  });
  return {
    port,
    stdout: () => out,
    stderr: () => err,
    stop: async () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

const get = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

async function mcpCall(port: number, method: string, params: object) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(method === "tools/call"
        ? { "Mcp-Name": String((params as { name: string }).name) }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: metadata },
    }),
  });
  const text = await response.text();
  const json = text.startsWith("{")
    ? text
    : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(
        6,
      );
  return { status: response.status, body: JSON.parse(json) };
}

const toolNames = async (port: number): Promise<string[]> =>
  (await mcpCall(port, "tools/list", {})).body.result.tools.map(
    (tool: { name: string }) => tool.name,
  );

function stdioCall(
  env: Record<string, string>,
  method: string,
  params: object,
): Promise<{
  lines: Record<string, unknown>[];
  stderr: string;
  code: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stdio], {
      env: { ...baseEnv, OPENPLANS_MCP_ALLOW_PERSONALIZED: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stdio did not exit"));
    }, 15_000);
    child.stdout.on("data", (data) => {
      out += String(data);
      if (out.includes('"id":2')) child.stdin.end();
    });
    child.stderr.on("data", (data) => (err += String(data)));
    child.on("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({
        lines: out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        stderr: err,
        code,
      });
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
      JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n",
    );
  });
}

const getStatusResult = (body: {
  result?: { structuredContent?: unknown; content?: { text: string }[] };
}) =>
  body.result?.structuredContent ??
  JSON.parse(body.result?.content?.[0]?.text ?? "null");

describe("the API server loads configured plugins at startup", () => {
  it("serves the status plugin's routes and get_status when OPENPLANS_PLUGINS names it", async () => {
    const api = await startApi({
      OPENPLANS_PLUGINS: STATUS,
      OPENPLANS_OPERATOR_TOKEN: TOKEN,
    });
    try {
      const json = await get(api.port, "/status.json");
      expect(json.status).toBe(200);
      const body = (await json.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ api: "ok", db: "down", plugins: 1 });
      expect((await get(api.port, "/status")).status).toBe(200);
      // With a token configured: a missing bearer is refused, the right one is served.
      const refused = await get(api.port, "/status/operator.json");
      expect(refused.status).toBe(401);
      const operator = await get(api.port, "/status/operator.json", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(operator.status).toBe(200);
      expect(operator.headers.get("cache-control")).toContain("no-store");
      const view = (await operator.json()) as {
        plugins: { name: string }[];
        pool: { waiting: number | null };
      };
      expect(view.plugins.map((plugin) => plugin.name)).toEqual([STATUS]);
      // The host view reads the API's own pool, so pool waits are a count, not null.
      expect(view.pool.waiting).toBe(0);
      // MCP over HTTP: get_status is listed after the core tools and answers.
      expect(await toolNames(api.port)).toContain("get_status");
      const call = await mcpCall(api.port, "tools/call", {
        name: "get_status",
        arguments: {},
      });
      expect(call.status).toBe(200);
      expect(call.body.error).toBeUndefined();
      expect(getStatusResult(call.body)).toMatchObject({
        api: "ok",
        plugins: 1,
      });
      // The token never reaches the logs.
      expect(api.stdout() + api.stderr()).not.toContain(TOKEN);
    } finally {
      expect(await api.stop()).toBe(0);
    }
  });

  it("keeps the operator routes hidden (404) when no operator token is configured", async () => {
    const api = await startApi({ OPENPLANS_PLUGINS: STATUS });
    try {
      expect((await get(api.port, "/status.json")).status).toBe(200);
      for (const headers of [
        {},
        { authorization: `Bearer ${TOKEN}` },
      ] as Record<string, string>[])
        expect(
          (await get(api.port, "/status/operator.json", headers)).status,
        ).toBe(404);
      expect((await get(api.port, "/status/operator")).status).toBe(404);
    } finally {
      await api.stop();
    }
  });

  it("serves none of them without plugins, and starts with the same output", async () => {
    const api = await startApi({ OPENPLANS_OPERATOR_TOKEN: TOKEN });
    try {
      for (const path of [
        "/status",
        "/status.json",
        "/status/operator",
        "/status/operator.json",
      ])
        expect(
          (await get(api.port, path, { authorization: `Bearer ${TOKEN}` }))
            .status,
        ).toBe(404);
      expect(await toolNames(api.port)).not.toContain("get_status");
      const call = await mcpCall(api.port, "tools/call", {
        name: "get_status",
        arguments: {},
      });
      expect(call.body.error ?? call.body.result?.isError).toBeTruthy();
    } finally {
      await api.stop();
    }
    expect(api.stdout()).toBe(`OpenPlans API listening on port ${api.port}\n`);
    // Only the MCP request log lines: no plugin or event line.
    for (const line of api.stderr().trim().split("\n"))
      expect(Object.keys(JSON.parse(line))).toEqual([
        "tool",
        "status",
        "timing_ms",
        "bytes",
        "cache",
      ]);
  });

  it("exits 1 with one {plugin, code} line when a plugin is refused", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [server], {
      env: {
        ...baseEnv,
        PORT: String(port),
        OPENPLANS_PLUGINS: "@openplans/plugin-does-not-exist-synthetic",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += String(data)));
    child.stderr.on("data", (data) => (err += String(data)));
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    children.delete(child);
    expect(code).toBe(1);
    expect(out).toBe("");
    const lines = err.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      plugin: "@openplans/plugin-does-not-exist-synthetic",
      code: "plugin_import_failed",
    });
  });

  it("negative control: a server that never loads plugins fails the status check", async () => {
    const mutant = new URL(
      "../../dist/api/.server-unloaded-mutant.js",
      import.meta.url,
    ).pathname;
    mutants.push(mutant);
    const original = await readFile(server, "utf8");
    const call = "await loadApiPlugins({ statusHost })";
    expect(original).toContain(call);
    await writeFile(
      mutant,
      original.replace(call, "await loadApiPlugins({ env: {} })"),
    );
    const api = await startApi({ OPENPLANS_PLUGINS: STATUS }, mutant);
    try {
      expect((await get(api.port, "/status.json")).status).toBe(404);
      expect(await toolNames(api.port)).not.toContain("get_status");
    } finally {
      await api.stop();
    }
  });

  it("negative control: without the API database the host view has no pool waits", async () => {
    const mutant = new URL(
      "../../dist/api/.server-no-status-host-mutant.js",
      import.meta.url,
    ).pathname;
    mutants.push(mutant);
    const original = await readFile(server, "utf8");
    const call = "statusHost.database = db;";
    expect(original).toContain(call);
    await writeFile(mutant, original.replace(call, ""));
    const api = await startApi(
      { OPENPLANS_PLUGINS: STATUS, OPENPLANS_OPERATOR_TOKEN: TOKEN },
      mutant,
    );
    try {
      const operator = await get(api.port, "/status/operator.json", {
        authorization: `Bearer ${TOKEN}`,
      });
      const view = (await operator.json()) as { pool: { waiting: unknown } };
      expect(view.pool.waiting).toBeNull();
    } finally {
      await api.stop();
    }
  });

  it("negative control: an operator route declared public answers without the token", async () => {
    // A copy of the built status plugin next to the real one, so its imports resolve the same way.
    const dist = new URL("../../plugins/status/dist/", import.meta.url)
      .pathname;
    const copy = new URL(
      "../../plugins/status/.dist-operator-public-mutant/",
      import.meta.url,
    ).pathname;
    mutants.push(copy);
    await cp(dist, copy, { recursive: true });
    const index = await readFile(`${copy}index.js`, "utf8");
    const before =
      'path: "/status/operator.json",\n                exposure: "operator",';
    expect(index).toContain(before);
    await writeFile(
      `${copy}index.js`,
      index.replace(
        before,
        'path: "/status/operator.json",\n                exposure: "public",',
      ),
    );
    const real = await startApi({
      OPENPLANS_PLUGINS: STATUS,
      OPENPLANS_OPERATOR_TOKEN: TOKEN,
    });
    const planted = await startApi({
      OPENPLANS_PLUGINS: `${copy}index.js`,
      OPENPLANS_OPERATOR_TOKEN: TOKEN,
    });
    try {
      expect((await get(real.port, "/status/operator.json")).status).toBe(401);
      expect((await get(planted.port, "/status/operator.json")).status).toBe(
        200,
      );
    } finally {
      await real.stop();
      await planted.stop();
    }
  });
});

describe("MCP stdio loads configured plugins at startup", () => {
  it("lists and answers get_status when OPENPLANS_PLUGINS names the status plugin", async () => {
    const listed = await stdioCall(
      { OPENPLANS_PLUGINS: STATUS },
      "tools/list",
      {},
    );
    expect(listed.code).toBe(0);
    const tools = (listed.lines[1] as { result: { tools: { name: string }[] } })
      .result.tools;
    expect(tools.map((tool) => tool.name)).toContain("get_status");
    const called = await stdioCall(
      { OPENPLANS_PLUGINS: STATUS },
      "tools/call",
      {
        name: "get_status",
        arguments: {},
      },
    );
    expect(called.code).toBe(0);
    const body = called.lines[1] as Parameters<typeof getStatusResult>[0] & {
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(getStatusResult(body)).toMatchObject({ api: "ok", plugins: 1 });
  });

  it("lists no get_status without plugins", async () => {
    const listed = await stdioCall({}, "tools/list", {});
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe("");
    const tools = (listed.lines[1] as { result: { tools: { name: string }[] } })
      .result.tools;
    expect(tools.map((tool) => tool.name)).not.toContain("get_status");
  });

  it("exits 1 with one {plugin, code} line when a plugin is refused", async () => {
    const result = await stdioCall(
      { OPENPLANS_PLUGINS: "@openplans/plugin-does-not-exist-synthetic" },
      "tools/list",
      {},
    );
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
    expect(
      result.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        plugin: "@openplans/plugin-does-not-exist-synthetic",
        code: "plugin_import_failed",
      },
    ]);
  });
});
