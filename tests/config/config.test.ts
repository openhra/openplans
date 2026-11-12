import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coreConfigSchema,
  coreConfigView,
  environmentPaths,
  loadConfig,
  onUnlessOff,
  SecretValue,
} from "../../src/config/index.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import {
  cmsFallbackEnabled,
  shippedManifestPaths,
} from "../../src/fetch/shipped.js";
import { configDependencies, householdOpen } from "../../src/mcp/policy.js";
import { stdioGranted } from "../../src/mcp/stdio.js";

const synthetic = "synthetic-config-credential";
const directory = mkdtempSync(join(tmpdir(), "openplans-config-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((v, key) => (v as Record<string, unknown>)[key], value);
const raw = (value: unknown) =>
  value instanceof SecretValue ? value.reveal() : value;

// Synthetic values exercise the documented environment contract, not downloaded data.
const converted: Record<string, [string, unknown]> = {
  PORT: ["4321", 4321],
  OPENPLANS_API_CACHE_MB: ["12", 12],
  OPENPLANS_API_CACHE: ["off", false],
  OPENPLANS_SHIPPED_ACCESS: ["off", false],
  OPENPLANS_MCP: ["off", false],
  OPENPLANS_PUBLIC_QUOTING: ["off", false],
  OPENPLANS_PUBLIC_HOUSEHOLD: ["off", false],
  OPENPLANS_PUBLIC_COMPAT: ["off", false],
  OPENPLANS_CMS_FALLBACK: ["on", true],
  OPENPLANS_CMS_FALLBACK_QUOTES: ["on", true],
  OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE: ["on", true],
  OPENPLANS_MEDICARE_PART_D: ["on", true],
  OPENPLANS_MEDICARE_DRUG_COST: ["on", true],
  OPENPLANS_GA_QUOTE_RECOVERY: ["on", true],
  OPENPLANS_COMPAT_BENEFIT_TEXT: ["compact", true],
  OPENPLANS_MCP_ALLOWED_HOSTS: [
    " a.example, b.example ,",
    ["a.example", "b.example"],
  ],
  OPENPLANS_MCP_ALLOWED_ORIGINS: [
    " https://a.example,https://b.example ",
    ["https://a.example", "https://b.example"],
  ],
  OPENPLANS_TRUST_PROXY: ["127.0.0.2, ::1", ["127.0.0.2", "::1"]],
};

describe("typed configuration", () => {
  it("maps every documented variable", () => {
    const documentation = readFileSync(
      new URL("../../docs/configuration.md", import.meta.url),
      "utf8",
    );
    const names = [
      ...documentation.matchAll(
        /`((?:OPENPLANS_|POSTGRES_)[A-Z0-9_]+|DATABASE_URL|CMS_API_KEY|PORT|HOST|API_PORT|DB_PORT)`/g,
      ),
    ].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(70);
    // Plugin-owned variables are read by the plugin, not the core loader; each must appear in
    // that plugin's source.
    const pluginVariables: Record<string, string> = {
      OPENPLANS_WEBHOOK_HOST: "../../plugins/webhook/src/index.ts",
      OPENPLANS_WEBHOOK_URL: "../../plugins/webhook/src/index.ts",
      OPENPLANS_WEBHOOK_SECRET: "../../plugins/webhook/src/index.ts",
      OPENPLANS_SLACK_HOST: "../../plugins/slack/src/index.ts",
      OPENPLANS_SLACK_WEBHOOK_URL: "../../plugins/slack/src/index.ts",
      OPENPLANS_BLOB_S3_ENDPOINT: "../../plugins/blob-s3/src/index.ts",
      OPENPLANS_BLOB_S3_REGION: "../../plugins/blob-s3/src/index.ts",
      OPENPLANS_BLOB_S3_BUCKET: "../../plugins/blob-s3/src/index.ts",
      OPENPLANS_BLOB_S3_ACCESS_KEY_ID: "../../plugins/blob-s3/src/index.ts",
      OPENPLANS_BLOB_S3_SECRET_ACCESS_KEY: "../../plugins/blob-s3/src/index.ts",
      OPENPLANS_BLOB_S3_SESSION_TOKEN: "../../plugins/blob-s3/src/index.ts",
    };
    for (const name of new Set(names)) {
      if (name === "OPENPLANS_CONFIG" || name === "OPENPLANS_PLUGINS") continue;
      const owner = pluginVariables[name!];
      if (owner) {
        expect(readFileSync(new URL(owner, import.meta.url), "utf8")).toContain(
          `"${name}"`,
        );
        continue;
      }
      expect(environmentPaths).toHaveProperty(name!);
    }
  });

  it.each(Object.entries(environmentPaths))(
    "round-trips %s to %s",
    (name, path) => {
      const [input, expected] = converted[name] ?? [synthetic, synthetic];
      const config = loadConfig({ [name]: input });
      expect(raw(at(config, path))).toEqual(expected);
      if (name === "OPENPLANS_DATA_DIR") expect(config.blobs.root).toBe(input);
    },
  );

  it("keeps the production defaults", () => {
    const config = loadConfig({});
    expect(config.listen).toEqual({ port: 3000, host: "127.0.0.1" });
    expect(config.db.provider).toBe("pg");
    expect(config.cache).toEqual({
      enabled: true,
      provider: "memory",
      maxMb: 64,
    });
    expect(config.blobs.provider).toBe("local");
    expect(config.access).toMatchObject({
      shipped: true,
      projectUrl: "https://plans.openhra.com/",
    });
    expect(config.public).toEqual({
      quoting: true,
      household: true,
      compat: true,
    });
    expect(config.cmsFallback).toEqual({ enabled: false, quotes: false });
    expect(config.mcp).toMatchObject({
      enabled: true,
      allowedHosts: [
        "127.0.0.1",
        "localhost",
        "[::1]",
        "127.0.0.1:3000",
        "localhost:3000",
        "[::1]:3000",
      ],
      allowedOrigins: [
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://[::1]:3000",
      ],
    });
    expect(config.trustProxy).toEqual([]);
    expect(config.plugins).toEqual([]);
    expect(config.runners.pgliteDir).toBeUndefined();
    expect(coreConfigSchema.parse({}).listen.port).toBe(3000);
    expect(loadConfig({}, undefined, { port: 3001 }).listen.port).toBe(3001);
    expect(
      loadConfig({}, { version: 1, listen: { port: 3000 } }, { port: 3001 })
        .listen.port,
    ).toBe(3000);
    expect(
      loadConfig({ PORT: "4100" }, undefined, { port: 3001 }).listen.port,
    ).toBe(4100);
  });

  it("redacts all credential values in JSON, string conversion and inspection", () => {
    const env = Object.fromEntries(
      [
        "DATABASE_URL",
        "OPENPLANS_API_TOKEN",
        "OPENPLANS_COMPAT_API_KEY",
        "OPENPLANS_MCP_TOKEN",
        "OPENPLANS_MCP_CURSOR_SECRET",
        "OPENPLANS_OPERATOR_TOKEN",
        "CMS_API_KEY",
        "OPENPLANS_CACHE_URL",
        "POSTGRES_PASSWORD",
        "OPENPLANS_GEOCODER_KEY",
        "OPENPLANS_GEOCODER_URL",
        "OPENPLANS_QHP_DATABASE_URL",
      ].map((key) => [key, `${synthetic}-${key}`]),
    );
    const config = loadConfig(env);
    expect(JSON.stringify(config)).not.toContain(synthetic);
    expect(JSON.stringify(config)).toContain('"api":"<set>"');
    expect(inspect(config)).not.toContain(synthetic);
    expect(String(config.tokens.api)).toBe("<set>");
    expect(config.tokens.api?.reveal()).toBe(env.OPENPLANS_API_TOKEN);
    const view = coreConfigView(config);
    expect(view).not.toHaveProperty("tokens");
    expect(view.db).not.toHaveProperty("connectionString");
    expect(view.cmsFallback).not.toHaveProperty("apiKey");
    expect(inspect(view)).not.toContain("<set>");
  });

  it.each([
    "OPENPLANS_PUBLIC_QUOTING",
    "OPENPLANS_PUBLIC_HOUSEHOLD",
    "OPENPLANS_PUBLIC_COMPAT",
  ])("preserves %s strict switch errors", (name) => {
    for (const value of [undefined, "", "on"])
      expect(loadConfig({ [name]: value }).public).toEqual({
        quoting: true,
        household: true,
        compat: true,
      });
    for (const value of ["ON", "false", "1", " on "])
      expect(() => loadConfig({ [name]: value })).toThrow(
        `${name} must be on or off`,
      );
    expect(() => onUnlessOff(name, "invalid")).toThrow(
      `${name} must be on or off`,
    );
  });

  it("keeps permissive exact-match switches and empty numeric values", () => {
    expect(
      loadConfig({
        OPENPLANS_API_CACHE: "invalid",
        OPENPLANS_MCP: "invalid",
        OPENPLANS_CMS_FALLBACK: "ON",
      }),
    ).toMatchObject({
      cache: { enabled: true },
      mcp: { enabled: true },
      cmsFallback: { enabled: false },
    });
    expect(loadConfig({ OPENPLANS_API_CACHE_MB: "" }).cache.maxMb).toBe(0);
    expect(() => loadConfig({ PORT: "" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
    for (const value of ["-1", "4097", "0.5", "invalid"])
      expect(() => loadConfig({ OPENPLANS_API_CACHE_MB: value })).toThrow(
        "OPENPLANS_API_CACHE_MB must be an integer from 0 to 4096",
      );
    expect(
      loadConfig({
        OPENPLANS_MCP_ALLOWED_HOSTS: "",
        OPENPLANS_MCP_ALLOWED_ORIGINS: "",
      }).mcp.allowedHosts,
    ).toEqual(loadConfig({}).mcp.allowedHosts);
    expect(loadConfig({ OPENPLANS_API_TOKEN: "" }).tokens.api).toBeUndefined();
    expect(() =>
      loadConfig({ OPENPLANS_COMPAT_KEY_HEADER: "invalid header" }),
    ).toThrow("OPENPLANS_COMPAT_KEY_HEADER must be a single RFC 7230 token");
  });

  it("reads a versioned file, with environment precedence and plugin shorthand", () => {
    const file = join(directory, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        listen: { port: 4200, host: "localhost" },
        cache: { maxMb: 5 },
        tokens: { api: synthetic },
        plugins: [
          {
            package: "@openplans/synthetic",
            options: { state: "TX" },
            sources: { synthetic: { cacheLevel: "memory", ttl: "1h" } },
          },
        ],
      }),
    );
    const config = loadConfig({ OPENPLANS_CONFIG: file, PORT: "4300" });
    expect(config.listen).toEqual({ port: 4300, host: "localhost" });
    expect(config.cache.maxMb).toBe(5);
    expect(config.plugins[0]).toMatchObject({
      package: "@openplans/synthetic",
      enabled: true,
      options: { state: "TX" },
      optionalSecrets: [],
    });
    expect(JSON.stringify(config)).not.toContain(synthetic);
    expect(config.tokens.api?.reveal()).toBe(synthetic);
    expect(
      loadConfig(
        { OPENPLANS_API_TOKEN: "synthetic-env-wins" },
        file,
      ).tokens.api?.reveal(),
    ).toBe("synthetic-env-wins");
    expect(
      loadConfig({ OPENPLANS_API_TOKEN: "" }, file).tokens.api,
    ).toBeUndefined();
    expect(
      loadConfig({
        OPENPLANS_CONFIG: file,
        OPENPLANS_PLUGINS: " @openplans/a, @openplans/b ,",
      }).plugins.map((plugin) => plugin.package),
    ).toEqual(["@openplans/a", "@openplans/b"]);
    // Compose passes an empty OPENPLANS_PLUGINS; the file's list and options must survive it.
    for (const empty of ["", " , "])
      expect(
        loadConfig({ OPENPLANS_CONFIG: file, OPENPLANS_PLUGINS: empty })
          .plugins,
      ).toEqual(config.plugins);
    expect(loadConfig({ OPENPLANS_PLUGINS: "" }).plugins).toEqual([]);
    expect(loadConfig({}, file).listen.port).toBe(4200);
    expect(loadConfig({}, { version: 1, plugins: [] }).plugins).toEqual([]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.plugins[0]?.options)).toBe(true);
    expect(() => {
      (config.listen as { port: number }).port = 10;
    }).toThrow();
  });

  it("rejects malformed files and unsupported versions without leaking input", () => {
    for (const input of [{ version: 2 }, {}, null, []])
      expect(() => loadConfig({}, input)).toThrow(
        "OPENPLANS_CONFIG must have version 1",
      );
    expect(() => loadConfig({}, { version: 1, listen: { port: 0 } })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
    expect(() =>
      loadConfig(
        {},
        { version: 1, plugins: [{ package: "x", enabled: "yes" }] },
      ),
    ).toThrow("Invalid OpenPlans configuration");
    const file = join(directory, "invalid.json");
    writeFileSync(file, `{"${synthetic}`);
    expect(() => loadConfig({ OPENPLANS_CONFIG: file })).toThrow(
      "OPENPLANS_CONFIG must contain valid JSON",
    );
    expect(() => loadConfig({ OPENPLANS_CONFIG: "relative.json" })).toThrow(
      "OPENPLANS_CONFIG must be an absolute path",
    );
    expect(() =>
      loadConfig({ OPENPLANS_CONFIG: join(directory, "absent.json") }),
    ).toThrow("OPENPLANS_CONFIG could not be read");
  });

  it("selects the existing cache stores from config without opening a connection", () => {
    const db = { query: async () => ({ rows: [] }), exec: async () => {} };
    expect(
      createResponseCache(db, undefined, { config: loadConfig({}) }).stats()
        .backend,
    ).toBe("memory");
    expect(
      createResponseCache(db, undefined, {
        config: loadConfig({ OPENPLANS_CACHE_URL: "redis://127.0.0.1:1" }),
      }).stats().backend,
    ).toBe("external");
    expect(
      createResponseCache(db, undefined, {
        config: loadConfig({
          OPENPLANS_API_CACHE: "off",
          OPENPLANS_CACHE_URL: "redis://127.0.0.1:1",
        }),
      }).stats().backend,
    ).toBe("off");
  });

  it("preserves MCP grants and process-random cursor fallback", () => {
    expect(householdOpen({})).toBe(true);
    expect(householdOpen({ OPENPLANS_MCP_TOKEN: synthetic })).toBe(false);
    expect(
      stdioGranted({
        OPENPLANS_MCP_ALLOW_PERSONALIZED: "1",
        OPENPLANS_MCP_TOKEN: synthetic,
      }),
    ).toBe(true);
    expect(stdioGranted({ OPENPLANS_MCP_ALLOW_PERSONALIZED: "0" })).toBe(false);
    expect(stdioGranted({ OPENPLANS_MCP_ALLOW_PERSONALIZED: "invalid" })).toBe(
      true,
    );
    const db = { query: async () => ({ rows: [] }), exec: async () => {} };
    expect(configDependencies(db, loadConfig({}), false).cursorSecret).toBe(
      configDependencies(db, loadConfig({}), false).cursorSecret,
    );
  });

  it("reads the config file in shipped manifest helpers without a global snapshot", () => {
    const file = join(directory, "shipped.json");
    vi.stubEnv("OPENPLANS_CONFIG", file);
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", undefined);
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", undefined);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, cmsFallback: { enabled: true } }),
    );
    expect(cmsFallbackEnabled()).toBe(true);
    expect(shippedManifestPaths()).toHaveLength(2);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, access: { shipped: false } }),
    );
    expect(cmsFallbackEnabled()).toBe(false);
    expect(shippedManifestPaths()).toEqual([]);
  });
});

describe("configuration rejection controls", () => {
  it("fails a temporary module with the tokens.api wrapper removed", () => {
    const source = readFileSync(
      new URL("../../src/config/index.ts", import.meta.url),
      "utf8",
    );
    const marker = "api: secret";
    expect(source.split(marker)).toHaveLength(2);
    const mutated = source.replace(marker, "api: z.string().optional()");
    const output = ts.transpileModule(mutated, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText;
    const file = join(directory, "unwrapped.mjs");
    writeFileSync(
      file,
      output.replace(
        'from "zod"',
        `from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("zod")).href)}`,
      ),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadConfig } from ${JSON.stringify(pathToFileURL(file).href)};
      const config = loadConfig({ OPENPLANS_API_TOKEN: "synthetic-mutant-token" });
      if (JSON.stringify(config).includes("synthetic-mutant-token")) throw new Error("Secret redaction check failed");
    `,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Secret redaction check failed");
  });

  it.each([
    [
      "dist/api/server.js",
      { PORT: "invalid" },
      "PORT must be an integer between 1 and 65535",
    ],
    [
      "dist/api/server.js",
      { PORT: "3000", DATABASE_URL: "" },
      "API startup failed; check PORT, DATABASE_URL, OPENPLANS_COMPAT_KEY_HEADER and OPENPLANS_PUBLIC_QUOTING",
    ],
    [
      "dist/api/pglite.js",
      { PORT: "invalid", OPENPLANS_PGLITE_DIR: "" },
      "Set an absolute OPENPLANS_PGLITE_DIR and a valid PORT (default 3001)",
    ],
    [
      "dist/mcp/stdio.js",
      { DATABASE_URL: "" },
      "MCP startup failed; check DATABASE_URL",
    ],
  ] as const)(
    "preserves %s startup diagnostics %j",
    (entry, overrides, message) => {
      const result = spawnSync(process.execPath, [entry], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          OPENPLANS_CONFIG: "",
          OPENPLANS_PLUGINS: "",
          ...overrides,
        },
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${message}\n`);
      expect(result.stdout).toBe("");
    },
  );
});
