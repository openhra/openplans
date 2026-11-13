// The read-only host view for plugins that declare `capabilities.hostStatus` (design 5.11).
// Synthetic packages in a temporary directory; no network.
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSTHROUGH_OPENING_REASONS,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import type { CacheStore, StatusHost } from "@openplans/plugin-sdk";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/index.js";
import { packageRoot, packageSha256 } from "../../src/plugins/package-hash.js";
import {
  createPassThrough,
  passThroughHitRate,
  resetPassThrough,
} from "../../src/plugins/sources/passthrough.js";
import type { PassThroughDeps } from "../../src/plugins/sources/passthrough.js";
import {
  CACHE_PROBE_KEY,
  availabilityMemo,
  coreApplicationVersion,
  createStatusHost,
  hostAvailability,
} from "../../src/plugins/status-host.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

const hashFile = fileURLToPath(
  new URL("../../src/plugins/package-hash.ts", import.meta.url),
);

/** An independent reading of the documented package hash, for comparison. */
async function expectedSha256(root: string): Promise<string> {
  const lines: [string, string][] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        const digest = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        lines.push([path, `${path}\0${digest}\n`]);
      }
    }
  };
  await walk(root);
  lines.sort(([a], [b]) => Number(a > b) - Number(a < b));
  return createHash("sha256")
    .update(lines.map(([, line]) => line).join(""))
    .digest("hex");
}

let scratch: string;

/** A synthetic plugin package that asks for host status and records what it gets. */
async function hostedPackage(
  name: string,
  factory = "createPlugin",
): Promise<string> {
  const root = join(scratch, name);
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: `synthetic-${name}`, version: "1.0.0" }),
  );
  await writeFile(
    join(root, "lib", "index.mjs"),
    `const manifest = {
  name: "synthetic-${name}",
  version: "1.0.0",
  apiVersion: "0.1",
  kinds: [],
  capabilities: { hostStatus: true },
};
export const received = [];
export function ${factory}({ host }) {
  received.push(host);
  return { manifest, setup() {} };
}
export default { manifest, setup() {} };
`,
  );
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "x.js"), "ignored\n");
  await writeFile(join(root, ".npmignore"), "ignored\n");
  return root;
}

/**
 * Import the plugin module the loader imported. The loader imports by file URL, and Vitest 5
 * keeps a separate module instance for the bare path, whose `received` list stays empty.
 */
const importLoaded = (file: string) => import(pathToFileURL(file).href);

async function load(
  file: string,
  options: Parameters<typeof loadPlugins>[2] = {},
  config = loadConfig({}, { version: 1, plugins: [{ package: file }] }),
) {
  const lines: string[] = [];
  const loaded = await loadPlugins(config, "api", {
    env: {},
    manifestPaths: [],
    writeLog: (line) => lines.push(line),
    exit: (code) => {
      throw new Error(`exit ${code}: ${lines.join(" ")}`);
    },
    ...options,
  });
  return { loaded, lines };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-status-host-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("package hash", () => {
  it("follows the documented recipe and skips node_modules and dot entries", async () => {
    const root = await hostedPackage("recipe");
    const sha = await packageSha256(root);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    expect(sha).toBe(await expectedSha256(root));
    expect(await packageRoot(join(root, "lib", "index.mjs"))).toBe(root);
    // Ignored entries do not move the hash.
    await writeFile(join(root, "node_modules", "dep", "x.js"), "changed\n");
    await writeFile(join(root, ".npmignore"), "changed\n");
    expect(await packageSha256(root)).toBe(sha);
  });

  it("changes when one byte of code, a file name or a link changes", async () => {
    const root = await hostedPackage("bytes");
    const before = await packageSha256(root);
    const file = join(root, "lib", "index.mjs");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace("1.0.0", "1.0.1"));
    const edited = await packageSha256(root);
    expect(edited).not.toBe(before);
    await writeFile(file, source);
    expect(await packageSha256(root)).toBe(before);
    await writeFile(join(root, "lib", "extra.mjs"), "");
    expect(await packageSha256(root)).not.toBe(before);
    await rm(join(root, "lib", "extra.mjs"));
    await symlink("index.mjs", join(root, "lib", "alias.mjs"));
    expect(await packageSha256(root)).not.toBe(before);
  });

  it("is unknown for a missing tree", async () => {
    expect(await packageSha256(join(scratch, "missing"))).toBeUndefined();
  });

  it("planted mutant: a hash that skips a directory misses a code change", async () => {
    const mutant = await plantMutant(
      hashFile,
      'if (name.startsWith(".") || name === "node_modules") continue;',
      'if (name.startsWith(".") || name === "node_modules" || name === "lib") continue;',
    );
    try {
      const hash = (await import(mutant.path)) as {
        packageSha256: typeof packageSha256;
      };
      const root = await hostedPackage("mutant-hash");
      const sha = await hash.packageSha256(root);
      expect(sha).not.toBe(await expectedSha256(root));
      await writeFile(join(root, "lib", "index.mjs"), "export default 1;\n");
      expect(await hash.packageSha256(root)).toBe(sha);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("loader host view", () => {
  it("calls createPlugin({ host }) for a hostStatus plugin and reports name, version, hash and state", async () => {
    const root = await hostedPackage("hosted");
    const file = join(root, "lib", "index.mjs");
    const { loaded } = await load(file);
    const sha = await expectedSha256(root);
    expect(loaded.plugins).toEqual([
      { name: "synthetic-hosted", version: "1.0.0", sha256: sha },
    ]);
    const module = (await importLoaded(file)) as {
      received: StatusHost[];
    };
    const host = module.received.at(-1)!;
    expect(Object.isFrozen(host)).toBe(true);
    expect(host.plugins!()).toEqual([
      {
        name: "synthetic-hosted",
        version: "1.0.0",
        apiVersion: "0.1",
        sha256: sha,
        enabled: true,
      },
    ]);
    expect(host.version!()).toBe(coreApplicationVersion());
    expect(host.version!()).toMatch(/^\d+\.\d+\.\d+/);
    // No database was supplied: pool and cache counters are unknown, not zero.
    expect(host.poolWaiting!()).toBeUndefined();
    expect(host.cacheStats!()).toBeUndefined();
    expect(host.passthroughEnabled!("synthetic-unregistered")).toBe(false);
    // The answers are copies; a plugin cannot change what the next reader sees.
    host.plugins!()![0]!.sha256 = "0".repeat(64);
    expect(host.plugins!()![0]!.sha256).toBe(sha);
  });

  it("refuses a hostStatus plugin without createPlugin, or whose factory changes the manifest", async () => {
    const root = await hostedPackage("no-factory", "somethingElse");
    await expect(load(join(root, "lib", "index.mjs"))).rejects.toThrow(
      /plugin_export_invalid/,
    );
    const other = await hostedPackage("changed-manifest");
    const file = join(other, "lib", "index.mjs");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "return { manifest, setup() {} };",
        'return { manifest: { ...manifest, kinds: ["routes"] }, setup() {} };',
      ),
    );
    await expect(load(file)).rejects.toThrow(/plugin_export_invalid/);
  });

  it("gives no host to a plugin that does not declare hostStatus", async () => {
    const root = await hostedPackage("undeclared");
    const file = join(root, "lib", "index.mjs");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "capabilities: { hostStatus: true },",
        "",
      ),
    );
    const { loaded } = await load(file);
    expect(loaded.plugins).toHaveLength(1);
    const module = (await importLoaded(file)) as { received: unknown[] };
    expect(module.received).toEqual([]);
  });

  it("reads pool waits and response cache counters from the database it is given", async () => {
    const root = await hostedPackage("counters");
    const file = join(root, "lib", "index.mjs");
    const database = {
      query: async () => ({ rows: [] }),
      exec: async () => {},
      poolWaiting: () => 4,
    };
    await load(file, { statusHost: { database } });
    const module = (await importLoaded(file)) as {
      received: StatusHost[];
    };
    const host = module.received.at(-1)!;
    expect(host.poolWaiting!()).toBe(4);
    // createApp has not built a cache for this database yet.
    expect(host.cacheStats!()).toBeUndefined();
    const { createResponseCache } =
      await import("../../src/api/cache/index.js");
    createResponseCache(database, undefined, {
      config: loadConfig({}),
      store: new MemoryCache(1024),
    });
    expect(host.cacheStats!()).toEqual({
      hits: 0,
      misses: 0,
      bypasses: 0,
      bytes: 0,
    });
  });
});

describe("cache probe", () => {
  const loadedState = (store?: CacheStore) => () => ({
    plugins: [],
    registries: {
      cacheStores: store
        ? { "synthetic-store": { plugin: "synthetic", spec: () => store } }
        : {},
    } as never,
  });
  const configWith = (provider: string, enabled = true) =>
    loadConfig(enabled ? {} : { OPENPLANS_API_CACHE: "off" }, {
      version: 1,
      cache: { provider },
    } as never);

  it("is absent when the cache is off", () => {
    const host = createStatusHost(
      configWith("memory", false),
      {},
      loadedState(),
    );
    expect(host.cacheProbe).toBeUndefined();
  });

  it("round-trips a nonce through the configured store", async () => {
    const host = createStatusHost(configWith("memory"), {}, loadedState());
    expect(await host.cacheProbe!()).toBe(true);
  });

  it("reports false for a store that loses or garbles the value, or throws", async () => {
    const keys: string[] = [];
    const stores: CacheStore[] = [
      { get: async () => null, set: async () => {}, bytes: () => 0 },
      {
        get: async () => "synthetic-other",
        set: async (key) => void keys.push(key),
        bytes: () => 0,
      },
      {
        get: async () => {
          throw new Error("synthetic outage");
        },
        set: async () => {},
        bytes: () => 0,
      },
    ];
    for (const store of stores) {
      const host = createStatusHost(
        configWith("synthetic-store"),
        {},
        loadedState(store),
      );
      expect(await host.cacheProbe!()).toBe(false);
    }
    expect(keys).toEqual([CACHE_PROBE_KEY]);
    // Before plugins finish loading there is nothing to probe.
    const early = createStatusHost(configWith("memory"), {}, () => undefined);
    expect(await early.cacheProbe!()).toBe(false);
  });
});

describe("pass-through hit rate", () => {
  const reason = PASSTHROUGH_OPENING_REASONS[0]!;
  const source = (id: string) =>
    ({
      id,
      kind: "passthrough",
      kinds: ["synthetic"],
      cache: { level: "memory", ttl: "1 minute" },
      eligibility: { openingReasons: [reason], accepts: () => true },
      question: (_kind: string, answer: { plan_id: string; code: string }) => ({
        planId: answer.plan_id,
        identity: answer.code,
        year: 2026,
      }),
      manifest: { accessMode: "open" },
    }) as unknown as ReturnType<PassThroughDeps["sources"]>[number];

  it("counts eligible questions answered from the cache level, per source, in this process", async () => {
    resetPassThrough();
    const store = new MemoryCache(1024 * 1024);
    await store.set(
      "openplans:passthrough:v1:synthetic-rate:synthetic:P1|A|2026",
      JSON.stringify({
        outcome: "answered",
        answer: {},
        negative: false,
        statement: null,
        snapshotId: null,
        sourcedAt: new Date().toISOString(),
      }),
      60,
    );
    const core = createPassThrough({
      sources: () => [source("synthetic-rate")],
      cacheStore: store,
    });
    expect(passThroughHitRate("synthetic-rate")).toBeUndefined();
    const answers = ["A", "B", "C", "D"].map((code) => ({
      status: "unknown",
      reason,
      plan_id: "P1",
      code,
    }));
    const reader = { query: async () => ({ rows: [] }), exec: async () => {} };
    await core.apply("synthetic", answers, { reader } as never);
    expect(passThroughHitRate("synthetic-rate")).toBe(0.25);
    // A source with nothing kept counts its questions with no hits.
    await createPassThrough({
      sources: () => [source("synthetic-cold")],
      cacheStore: store,
    }).apply("synthetic", answers, { reader } as never);
    expect(passThroughHitRate("synthetic-cold")).toBe(0);
    resetPassThrough();
    expect(passThroughHitRate("synthetic-rate")).toBeUndefined();
  });
});

describe("availability memo", () => {
  const session = {} as never;
  const row = (premium: string) => ({
    state: "TX",
    year: 2026,
    market: "Individual",
    issuer_id: "11111",
    catalog: "available",
    premium,
    provider: "unknown",
    formulary: "unknown",
    snapshot_id: "synthetic.1",
  });
  /** A synthetic derivation that counts its runs, over a generation the test moves. */
  function fixture() {
    const state = { generation: "g1", premium: "available", runs: 0 };
    const derive = async () => {
      state.runs++;
      return [row(state.premium)];
    };
    const memo = availabilityMemo(derive, async () => state.generation);
    return { state, memo };
  }

  it("derives once per generation and again the moment the generation moves", async () => {
    const { state, memo } = fixture();
    expect(await memo(session)).toEqual([row("available")]);
    expect(await memo(session)).toEqual([row("available")]);
    expect(state.runs).toBe(1);
    state.premium = "unsupported";
    state.generation = "g2";
    expect(await memo(session)).toEqual([row("unsupported")]);
    expect(state.runs).toBe(2);
  });

  it("shares one derivation between concurrent reads and hands each its own copy", async () => {
    const { state, memo } = fixture();
    const [a, b] = await Promise.all([memo(session), memo(session)]);
    expect(state.runs).toBe(1);
    a[0]!.premium = "changed by one view";
    expect(b[0]!.premium).toBe("available");
    expect((await memo(session))[0]!.premium).toBe("available");
  });

  it("keeps no failed derivation and derives without a readable generation", async () => {
    let runs = 0;
    let fail = true;
    const memo = availabilityMemo(
      async () => {
        runs++;
        if (fail) throw new Error("synthetic read failure");
        return [row("available")];
      },
      async () => "g1",
    );
    await expect(memo(session)).rejects.toThrow("synthetic read failure");
    fail = false;
    expect(await memo(session)).toEqual([row("available")]);
    expect(runs).toBe(2);
    let derived = 0;
    const blind = availabilityMemo(
      async () => [row(String(++derived))],
      async () => {
        throw new Error("no generation table");
      },
    );
    await blind(session);
    expect((await blind(session))[0]!.premium).toBe("2");
  });

  it("a reader joining a derivation that fails derives again on its own session", async () => {
    let runs = 0;
    let release!: (error: Error) => void;
    const memo = availabilityMemo(
      async () => {
        runs++;
        if (runs === 1)
          return new Promise((_, reject) => {
            release = reject;
          });
        return [row("available")];
      },
      async () => "g1",
    );
    const tick = () => new Promise((done) => setImmediate(done));
    const first = memo(session);
    await tick();
    const second = memo(session);
    await tick();
    expect(runs).toBe(1);
    release(new Error("first request's deadline"));
    await expect(first).rejects.toThrow("first request's deadline");
    expect(await second).toEqual([row("available")]);
    expect(runs).toBe(2);
  });

  it("is used only while the response cache is on", () => {
    const loaded = () => undefined;
    const off = createStatusHost(
      loadConfig({ OPENPLANS_API_CACHE: "off" }),
      {},
      loaded,
    );
    expect(off.dataAvailability).toBe(hostAvailability);
    const on = createStatusHost(loadConfig({}), {}, loaded);
    expect(on.dataAvailability).toBeTypeOf("function");
    expect(on.dataAvailability).not.toBe(hostAvailability);
  });
});

it("the SDK manifest schema accepts the capability", () => {
  expect(
    pluginManifestSchema.safeParse({
      name: "synthetic",
      version: "1.0.0",
      apiVersion: "0.1",
      kinds: [],
      capabilities: { hostStatus: true },
    }).success,
  ).toBe(true);
});
