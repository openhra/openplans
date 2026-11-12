import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest } from "@openplans/plugin-sdk";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Database } from "../../src/db/database.js";
import type {
  AdmissionManifest,
  Lookup,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import {
  abortableTransport,
  pluginCommandFetch,
} from "../../src/plugins/fetch.js";
import type { PluginFetchSettings } from "../../src/plugins/fetch.js";
import {
  restrictCacheLevel,
  runWithScope,
} from "../../src/plugins/request-scope.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import {
  loadWorkerPlugins,
  runPluginCommand,
} from "../../src/plugins/worker.js";
import type { PluginWorkerCommand } from "../../src/plugins/worker.js";

// Pacing has its own tests. Here the lease is recorded, not waited on.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => async () => {}),
}));
import { leaseHost } from "../../src/fetch/limiter.js";

// Every host, policy and body here is synthetic. The publisher runs on loopback; the injected
// transport carries requests for https://data.test and https://other.test to it. Nothing
// leaves the machine.
const HOST = "data.test";
const OTHER = "other.test";
const robots = "User-agent: *\nDisallow: /private\nAllow: /\n";
const terms = "Synthetic publisher terms: automated reads allowed.";
const plans = JSON.stringify({ synthetic: true, plans: [1, 2, 3] });
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

interface Seen {
  method: string;
  host: string;
  path: string;
}
let server: Server;
let port: number;
let seen: Seen[];
let closed: string[];
let directory: string;
let dataDir: string;
let manifestPath: string;
let lookups: number;

const transport: Transport = (url, context) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: url.pathname + url.search,
        method: context.method ?? "GET",
        headers: { ...context.headers, host: url.host },
        ...(context.signal && { signal: context.signal }),
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        }),
    );
    outgoing.on("error", reject);
    outgoing.end(context.body);
  });
const lookup: Lookup = async () => {
  lookups++;
  return [{ address: "8.8.8.8", family: 4 }];
};

function publisher(host: string): PublisherPolicy {
  const now = Date.now();
  return {
    host,
    state: "allowed",
    evidence: [
      {
        url: `https://${host}/terms`,
        observedAt: new Date(now).toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["plans"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}/data/plans.json`],
    permittedPaths: ["/data", "/private", "/hang", "/moved", "/hooks"],
    delegates: [],
    attribution: "Synthetic publisher",
    updatePolicy: "Operator review",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date(now).toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}

const manifest = (name: string, writes?: string[]): PluginManifest => ({
  name: `@synthetic/${name}`,
  version: "0.0.1",
  apiVersion: "0.1",
  kinds: ["workerCommands"],
  capabilities: {
    network: [HOST],
    ...(writes ? { writes: writes as ("cache" | "staging")[] } : {}),
  },
});
const settings = (): PluginFetchSettings => ({
  manifestPaths: [manifestPath],
  dataDir,
  testing: { transport, lookup },
});
const json = { expectedContent: "json" as const, maxBytes: 64 * 1024 };
const paths = () => seen.map(({ path }) => path);

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    seen.push({
      method: incoming.method ?? "GET",
      host: incoming.headers.host ?? "",
      path,
    });
    outgoing.on("close", () => closed.push(path));
    incoming.resume();
    if (path === "/robots.txt") return void outgoing.end(robots);
    if (path === "/terms") return void outgoing.end(terms);
    if (path === "/hang") return;
    if (path === "/moved") {
      outgoing.writeHead(302, { location: "/data/plans.json" });
      return void outgoing.end();
    }
    if (path.startsWith("/hooks")) {
      outgoing.writeHead(204);
      return void outgoing.end();
    }
    if (path.startsWith("/data/") || path.startsWith("/private/")) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      return void outgoing.end(plans);
    }
    outgoing.writeHead(404);
    outgoing.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});
beforeEach(async () => {
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "");
  vi.mocked(leaseHost).mockClear();
  seen = [];
  closed = [];
  lookups = 0;
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-wfetch-"));
  dataDir = join(directory, "data");
  await mkdir(dataDir);
  manifestPath = join(directory, "manifest.json");
  const content: AdmissionManifest = {
    version: 1,
    publishers: [publisher(HOST), publisher(OTHER)],
  } as AdmissionManifest;
  await writeFile(manifestPath, JSON.stringify(content));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await rm(directory, { recursive: true, force: true });
});

const live = () => new AbortController().signal;
const tree = async () =>
  (await readdir(dataDir, { recursive: true })).map(String).sort();

describe("ctx.fetch in a plugin worker command: GET", () => {
  it("reads robots.txt and terms, paces the host and keeps the body in memory", async () => {
    const fetch = pluginCommandFetch(manifest("memory"), settings(), live());
    const file = await fetch(`https://${HOST}/data/plans.json`, json);
    expect(Buffer.from(file.body!).toString("utf8")).toBe(plans);
    expect(file.path).toBe("");
    expect(file.sha256).toBe(digest(plans));
    expect(file.snapshotId).toBe(digest(plans));
    expect(file.metadata.status).toBe(200);
    expect(file.metadata.final_url).toBe(`https://${HOST}/data/plans.json`);
    expect(file.metadata.access_policy?.hosts.map(({ host }) => host)).toEqual([
      HOST,
    ]);
    expect(paths()).toEqual(["/robots.txt", "/terms", "/data/plans.json"]);
    // Pacing: the data request took the shared host lease at the manifest's delay.
    const data = vi
      .mocked(leaseHost)
      .mock.calls.filter(([, host, , floor]) => host === HOST && floor);
    expect(data.length).toBeGreaterThan(0);
    expect(data.at(-1)![3]).toBeGreaterThanOrEqual(5000);
    // No payload, sidecar or policy document reaches the data directory.
    expect(await tree()).toEqual([]);
  });

  it("refuses an undeclared host before any manifest read, lookup or connection", async () => {
    const fetch = pluginCommandFetch(manifest("memory"), settings(), live());
    // other.test is admitted in the manifest but the plugin did not declare it.
    await expect(
      fetch(`https://${OTHER}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    const store = pluginCommandFetch(
      manifest("store", ["cache"]),
      settings(),
      live(),
    );
    await expect(
      store(`https://${OTHER}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(seen).toEqual([]);
    expect(lookups).toBe(0);
    expect(leaseHost).not.toHaveBeenCalled();
  });

  it("refuses a plugin that declared no host, and plain HTTP", async () => {
    const none = { ...manifest("none"), capabilities: {} };
    await expect(
      pluginCommandFetch(
        none,
        settings(),
        live(),
      )(`https://${HOST}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "admission_required" });
    await expect(
      pluginCommandFetch(
        manifest("memory"),
        settings(),
        live(),
      )(`http://${HOST}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "https_required" });
    expect(seen).toEqual([]);
  });

  it("follows robots.txt on both paths: a disallowed path is never requested", async () => {
    for (const writes of [undefined, ["cache"]]) {
      seen = [];
      const fetch = pluginCommandFetch(
        manifest("robots", writes),
        settings(),
        live(),
      );
      await expect(
        fetch(`https://${HOST}/private/plans.json`, json),
      ).rejects.toMatchObject({ code: "admission_denied" });
      expect(paths()).not.toContain("/private/plans.json");
    }
  });

  it("refuses a host the manifest holds", async () => {
    const held = { ...publisher(HOST), state: "terms-restricted" as const };
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, publishers: [held] }),
    );
    const fetch = pluginCommandFetch(manifest("memory"), settings(), live());
    await expect(
      fetch(`https://${HOST}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(paths()).not.toContain("/data/plans.json");
  });

  it("stores the GET under raw/plugin-<name>/ when the plugin declared cache writes", async () => {
    const fetch = pluginCommandFetch(
      manifest("store", ["cache"]),
      settings(),
      live(),
    );
    const file = await fetch(`https://${HOST}/data/plans.json`, json);
    expect(file.body).toBeUndefined();
    expect(
      file.path.startsWith(join(dataDir, "raw", "plugin-synthetic-store")),
    ).toBe(true);
    expect(await readFile(file.path, "utf8")).toBe(plans);
    expect(file.metadata.source).toBe("plugin-synthetic-store");
    expect(paths()).toEqual(["/robots.txt", "/terms", "/data/plans.json"]);
  });

  it("writes nothing inside a none or request scope, even for a plugin that stores", async () => {
    for (const level of ["none", "request"] as const) {
      const fetch = pluginCommandFetch(
        manifest("store", ["cache"]),
        settings(),
        live(),
      );
      const file = await runWithScope(async () => {
        restrictCacheLevel(level);
        return fetch(`https://${HOST}/data/plans.json`, json);
      });
      expect(Buffer.from(file.body!).toString("utf8")).toBe(plans);
      expect(file.path).toBe("");
      expect(await tree()).toEqual([]);
    }
  });

  it("checks an expected hash and reports redirects", async () => {
    const fetch = pluginCommandFetch(manifest("memory"), settings(), live());
    await expect(
      fetch(`https://${HOST}/data/plans.json`, {
        ...json,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "snapshot_conflict" });
    const moved = await fetch(`https://${HOST}/moved`, json);
    expect(moved.metadata.redirect_chain).toEqual([
      `https://${HOST}/data/plans.json`,
    ]);
    expect(moved.metadata.final_url).toBe(`https://${HOST}/data/plans.json`);
    await expect(
      fetch(`https://${HOST}/data/plans.json`, {
        expectedContent: "pdf" as never,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "invalid_options" });
  });
});

const hanging = (signalOf: (run: AbortSignal) => AbortSignal) => {
  const outcome: { code?: string } = {};
  const command: PluginWorkerCommand = {
    plugin: "@synthetic/hang",
    writer: false,
    config: {} as PluginWorkerCommand["config"],
    fetch: (signal) =>
      pluginCommandFetch(manifest("hang"), settings(), signalOf(signal)),
    spec: {
      argv: ["plugin", "hang"],
      usage: "Usage: worker plugin hang",
      timeoutMs: 3000,
      async run(_args, ctx) {
        try {
          await ctx.fetch(`https://${HOST}/hang`, json);
        } catch (error) {
          outcome.code = (error as { code?: string }).code;
        }
        return 0;
      },
    },
  };
  return { command, outcome };
};
const quiet = { out() {}, error() {} };
const noDatabase = () => {
  throw new Error("no database in this test");
};

describe("ctx.signal stops a plugin fetch", () => {
  it("refuses at once when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = pluginCommandFetch(
      manifest("memory"),
      settings(),
      controller.signal,
    );
    await expect(
      fetch(`https://${HOST}/data/plans.json`, json),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
  });

  it("ends a pending response even when the transport ignores the signal", async () => {
    const controller = new AbortController();
    const deaf: Transport = () =>
      new Promise(() => {
        // Never answers and never looks at the signal.
      });
    const wrapped = abortableTransport(deaf, controller.signal);
    const pending = wrapped(new URL(`https://${HOST}/hang`), {
      address: { address: "8.8.8.8", family: 4 },
      headers: {},
      connectTimeoutMs: 1000,
      readTimeoutMs: 1000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("aborts the in-flight request when the worker stops the command", async () => {
    const { command, outcome } = hanging((signal) => signal);
    const controller = new AbortController();
    const run = runPluginCommand(
      command,
      [],
      noDatabase as () => Database,
      quiet,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(paths()).toContain("/hang"));
    controller.abort();
    expect(await run).toBe(0);
    expect(outcome.code).toBe("aborted");
    await vi.waitFor(() => expect(closed).toContain("/hang"));
  });
});

describe("ctx.fetch.post in a worker command keeps the delivery rules", () => {
  it("posts once, with no robots or terms read and no host lease", async () => {
    const fetch = pluginCommandFetch(manifest("post"), settings(), live());
    const result = await fetch.post!(`https://${HOST}/hooks/a`, {
      body: new TextEncoder().encode("{}"),
      contentType: "application/json",
    });
    expect(result.status).toBe(204);
    expect(seen).toEqual([{ method: "POST", host: HOST, path: "/hooks/a" }]);
    expect(leaseHost).not.toHaveBeenCalled();
    await expect(
      fetch.post!(`https://${OTHER}/hooks/a`, {
        body: new Uint8Array(),
        contentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(seen).toHaveLength(1);
  });
});

describe("worker wiring", () => {
  it("gives a loaded plugin command the admitted fetch on its declared hosts", async () => {
    const file = join(directory, "plugin.mjs");
    await writeFile(
      file,
      `// Synthetic worker plugin fixture.
export default {
  manifest: ${JSON.stringify(manifest("wired"))},
  setup(ctx) {
    ctx.workerCommands.add({
      argv: ["plugin", "wired"],
      usage: "Usage: worker plugin wired",
      async run(args, ctx) {
        const file = await ctx.fetch("https://${HOST}/data/plans.json", { expectedContent: "json", maxBytes: 65536 });
        globalThis.syntheticWiredBody = Buffer.from(file.body).toString("utf8");
        try {
          await ctx.fetch("https://${OTHER}/data/plans.json", { expectedContent: "json", maxBytes: 65536 });
        } catch (error) {
          globalThis.syntheticWiredRefusal = error.code;
        }
        return 0;
      },
    });
  },
};
`,
    );
    const loaded = await loadWorkerPlugins({
      env: {
        OPENPLANS_PLUGINS: file,
        OPENPLANS_ACCESS_MANIFEST: manifestPath,
        OPENPLANS_DATA_DIR: dataDir,
      },
      fetchTesting: { transport, lookup },
      writeLog: () => {},
    });
    try {
      const command = loaded.commands.find(
        ({ spec }) => spec.argv.join(" ") === "plugin wired",
      )!;
      expect(command.fetch).toBeTypeOf("function");
      const code = await runPluginCommand(
        command,
        [],
        (() => {
          throw new Error("no database");
        }) as () => Database,
        quiet,
      );
      expect(code).toBe(0);
      const global = globalThis as {
        syntheticWiredBody?: string;
        syntheticWiredRefusal?: string;
      };
      expect(global.syntheticWiredBody).toBe(plans);
      expect(global.syntheticWiredRefusal).toBe("host_not_allowed");
      expect(paths()).toEqual(["/robots.txt", "/terms", "/data/plans.json"]);
    } finally {
      await loaded.teardown();
    }
  });
});

describe("planted mutants", () => {
  const fetchFile = new URL("../../src/plugins/fetch.ts", import.meta.url);

  it("an undeclared host allowed: the refusal test fails", async () => {
    const mutant = await plantMutant(
      fetchFile,
      "const allowHosts = hosts;",
      "const allowHosts = [...hosts, new URL(url).hostname];",
    );
    try {
      const module = (await import(mutant.path)) as {
        pluginCommandFetch: typeof pluginCommandFetch;
      };
      const fetch = module.pluginCommandFetch(
        manifest("memory"),
        settings(),
        live(),
      );
      // The mutant reaches the undeclared host; the real code refuses it with no request.
      await expect(
        fetch(`https://${OTHER}/data/plans.json`, json),
      ).resolves.toBeDefined();
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await mutant.cleanup();
    }
  });

  it("robots skipped for a GET: the robots-first request order fails", async () => {
    const transient = await plantMutant(
      new URL("../../src/fetch/transient.ts", import.meta.url),
      "admission!.authorize(url, readPolicy, previous)",
      "admission!.assertCurrent(url).then(() => 0)",
    );
    const wired = await plantMutant(
      fetchFile,
      'import { fetchTransient } from "../fetch/transient.js";',
      `import { fetchTransient } from ${JSON.stringify(
        pathToFileURL(transient.path).href,
      )};`,
    );
    try {
      const module = (await import(wired.path)) as {
        pluginCommandFetch: typeof pluginCommandFetch;
      };
      const fetch = module.pluginCommandFetch(
        manifest("memory"),
        settings(),
        live(),
      );
      await fetch(`https://${HOST}/data/plans.json`, json).catch(() => {});
      expect(paths()).not.toContain("/robots.txt");
      expect(paths()).not.toEqual([
        "/robots.txt",
        "/terms",
        "/data/plans.json",
      ]);
    } finally {
      await wired.cleanup();
      await transient.cleanup();
    }
  });

  it("the signal ignored: the abort test fails", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/worker.ts", import.meta.url),
      "command.fetch?.(limit.signal)",
      "command.fetch?.(new AbortController().signal)",
    );
    try {
      const module = (await import(mutant.path)) as {
        runPluginCommand: typeof runPluginCommand;
      };
      const { command, outcome } = hanging((signal) => signal);
      const controller = new AbortController();
      const run = module.runPluginCommand(
        { ...command, spec: { ...command.spec, timeoutMs: 1500 } },
        [],
        noDatabase as () => Database,
        quiet,
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(paths()).toContain("/hang"));
      controller.abort();
      // The command only ends at its time limit, and the fetch never saw an abort.
      expect(await run).toBe(1);
      expect(outcome.code).toBeUndefined();
      expect(closed).not.toContain("/hang");
    } finally {
      await mutant.cleanup();
    }
  });
});
