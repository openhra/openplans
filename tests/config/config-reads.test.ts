import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coreConfigSchema,
  EnvironmentOnlyKeyError,
  environmentOnlyPaths,
  environmentPaths,
  loadConfig,
  secret,
  SecretValue,
} from "../../src/config/index.js";
import { compatRoutes } from "../../src/compat/v1/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { partDEnabled } from "../../src/services/medicare-part-d.js";
import {
  drugCostEnabled,
  drugCostPricingEnabled,
} from "../../src/services/medicare-drug-cost.js";
import { quoteFallbackEnabled } from "../../src/services/quote-coverage.js";
import { benefitTextOptions } from "../../src/compat/v1/index.js";
import { georgiaQuoteRecovery } from "../../src/ingest/sbe/georgia.js";
import {
  apiToken,
  compatApiKey,
  compatKeyHeaderName,
  configuredDataDirectory,
  databaseUrl,
  dataDirectory,
  defaultDataDirectory,
  egressCountry,
  operatorManifest,
  projectUrl,
  publicAccess,
  responseCacheEnabled,
  trustedProxies,
} from "../../src/config/access.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "openplans-config-reads-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const synthetic = "synthetic-config-value";

interface SchemaDef {
  type: string;
  innerType?: AnySchema;
  shape?: Record<string, AnySchema>;
}
interface AnySchema {
  _zod: { def: SchemaDef };
}
/** Unwraps defaults and optionals down to an object schema, if there is one. */
function objectShape(schema: AnySchema): Record<string, AnySchema> | undefined {
  let current: AnySchema | undefined = schema;
  while (current) {
    const def: SchemaDef = current._zod.def;
    if (def.type === "object") return def.shape;
    current = def.innerType;
  }
  return undefined;
}

/** Every key the file may set: top-level values and the fields of each section. */
function schemaLeafPaths(schema: z.ZodType): string[] {
  const top = objectShape(schema as unknown as AnySchema) ?? {};
  return Object.entries(top).flatMap(([group, child]) => {
    const fields = objectShape(child);
    return fields
      ? Object.keys(fields).map((field) => `${group}.${field}`)
      : [group];
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reads such as `config.group.field`, `config.group?.field` or `const { field } = config.group`. */
function readPatterns(path: string): RegExp[] {
  const [group, field] = path.split(".").map(escape) as [string, string?];
  if (field === undefined)
    return [
      new RegExp(`\\.${group}\\b`),
      new RegExp(
        `\\{[^}]*\\b${group}\\b[^}]*\\}\\s*=\\s*(loadConfig\\(|\\w*[cC]onfig\\b)`,
      ),
    ];
  return [
    new RegExp(`\\b${group}\\??\\.${field}\\b`),
    new RegExp(
      `\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*[\\w.?()]*\\b${group}\\b`,
    ),
  ];
}

/**
 * Schema keys no source reads from the loaded config. Keys the loader refuses in the file are
 * exempt: their readers take the environment variable, and the file cannot set them.
 */
function unreadKeys(
  paths: readonly string[],
  sources: readonly string[],
  exempt: ReadonlySet<string> = new Set(environmentOnlyPaths.keys()),
): string[] {
  return paths.filter(
    (path) =>
      !exempt.has(path) &&
      !readPatterns(path).some((pattern) =>
        sources.some((source) => pattern.test(source)),
      ),
  );
}

/** Direct reads such as `process.env.NAME`, `env?.NAME` or `env["NAME"]`. */
function environmentReadPattern(variable: string): RegExp {
  const name = escape(variable);
  return new RegExp(
    `\\benv\\??\\.${name}\\b|\\benv\\[\\s*["'\`]${name}["'\`]\\s*\\]`,
  );
}

/**
 * File-settable keys with at least one reader that takes the environment variable directly
 * instead of the loaded config, each with the files that do. Such a key is only half wired: a
 * config file value reaches some readers and not others.
 */
function directEnvironmentReaders(
  files: ReadonlyMap<string, string>,
  exempt: ReadonlySet<string> = new Set(environmentOnlyPaths.keys()),
): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [variable, path] of Object.entries(environmentPaths)) {
    if (exempt.has(path)) continue;
    const pattern = environmentReadPattern(variable);
    const readers = [...files]
      .filter(([, source]) => pattern.test(source))
      .map(([file]) => file);
    if (readers.length) found[path] = readers.sort();
  }
  return found;
}

/**
 * Keys still read from the environment in some places. Each would be a known follow-up, removed
 * once its last direct reader goes through `loadConfig`; none is left. The check fails on a new
 * key and on a stale entry alike.
 */
const halfWiredFollowUps: string[] = [];

/** Schema leaves typed as secrets: the loader wraps them so logs and JSON never show the value. */
function secretPaths(): string[] {
  const top = objectShape(coreConfigSchema as unknown as AnySchema) ?? {};
  return Object.entries(top).flatMap(([group, child]) =>
    Object.entries(objectShape(child) ?? {})
      .filter(([, field]) => field === (secret as unknown as AnySchema))
      .map(([field]) => `${group}.${field}`),
  );
}

/**
 * File-settable secrets whose value from the file shows up in the loaded config's JSON, string
 * or inspected form, or reaches the config other than as a wrapped secret.
 */
function secretsExposedFromFile(
  load: (file: unknown) => unknown,
  paths: readonly string[],
): string[] {
  return paths.filter((path) => {
    const [group, field] = path.split(".") as [string, string];
    const value = `${synthetic}-${field}`;
    const config = load({ version: 1, [group]: { [field]: value } }) as Record<
      string,
      Record<string, unknown>
    >;
    const leaf = config[group]?.[field];
    return (
      !(leaf instanceof SecretValue) ||
      leaf.reveal() !== value ||
      JSON.stringify(config).includes(value) ||
      inspect(config, { depth: 8 }).includes(value) ||
      String(leaf).includes(value)
    );
  });
}

/** Product sources that receive the loaded config; the loader itself does not count. */
function productSources(): string[] {
  return [...productSourceFiles().values()];
}

function productSourceFiles(): Map<string, string> {
  const roots = [
    join(packageRoot, "src"),
    ...readdirSync(join(packageRoot, "plugins"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => join(packageRoot, "plugins", entry.name, "src")),
  ];
  const loader = join(packageRoot, "src", "config", "index.ts");
  const files = new Map<string, string>();
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(entry.parentPath, entry.name);
      if (
        entry.isFile() &&
        /\.[cm]?[jt]s$/.test(entry.name) &&
        !/\.test\.|\.d\.ts$/.test(entry.name) &&
        !relative(packageRoot, file).split(/[/\\]/).includes("node_modules") &&
        file !== loader
      )
        files.set(relative(packageRoot, file), readFileSync(file, "utf8"));
    }
  }
  return files;
}

describe("every config file key is read or refused", () => {
  const paths = schemaLeafPaths(coreConfigSchema);
  const sources = productSources();

  it("walks the whole schema", () => {
    expect(paths).toEqual(expect.arrayContaining(["listen.host", "plugins"]));
    expect(paths).toEqual(
      expect.arrayContaining([
        "medicarePartD",
        "gaQuoteRecovery",
        "compat.benefitText",
        "ny.rateSourceOverrides",
        "runners.smokeTmpdir",
      ]),
    );
    expect(paths.length).toBeGreaterThan(80);
  });

  it("finds no schema key that nothing reads", () => {
    expect(unreadKeys(paths, sources)).toEqual([]);
  });

  it("negative control: a planted unread key fails the check", () => {
    const planted = coreConfigSchema.extend({
      plantedUnreadSwitch: z.boolean().default(false),
      plantedSection: z
        .object({ plantedField: z.string().optional() })
        .strict()
        .prefault({}),
    });
    expect(unreadKeys(schemaLeafPaths(planted), sources)).toEqual([
      "plantedUnreadSwitch",
      "plantedSection.plantedField",
    ]);
  });

  it("negative control: removing a reader fails the check", () => {
    const withoutReader = sources.map((source) =>
      source.replaceAll(".medicarePartD", ".removedReader"),
    );
    expect(unreadKeys(paths, withoutReader)).toEqual(["medicarePartD"]);
  });

  it("leaves no key half wired: every reader of its variable goes through the config", () => {
    const direct = directEnvironmentReaders(productSourceFiles());
    expect(Object.keys(direct).sort()).toEqual([...halfWiredFollowUps].sort());
    expect(direct).toEqual({});
  });

  it.each([
    ["access.dataDir", 'const root = process.env.OPENPLANS_DATA_DIR ?? "/";'],
    [
      "access.egressCountry",
      'const country = env["OPENPLANS_EGRESS_COUNTRY"];',
    ],
    ["access.dataDir", "const root = process.env?.OPENPLANS_DATA_DIR;"],
    ["db.connectionString", "const url = process.env.DATABASE_URL;"],
    ["tokens.compatKey", 'process.env["OPENPLANS_COMPAT_API_KEY"] = token;'],
    ["trustProxy", "proxyList(process.env.OPENPLANS_TRUST_PROXY);"],
    ["public.compat", "read(process.env.OPENPLANS_PUBLIC_COMPAT);"],
  ])(
    "negative control: a %s reader left on the raw variable fails the check",
    (path, reader) => {
      const files = productSourceFiles();
      files.set("src/planted-mutant.ts", reader);
      const direct = directEnvironmentReaders(files);
      expect(direct[path]).toEqual(["src/planted-mutant.ts"]);
      expect(Object.keys(direct).sort()).not.toEqual(
        [...halfWiredFollowUps].sort(),
      );
    },
  );

  it("negative control: a config read elsewhere does not excuse a raw reader", () => {
    const files = productSourceFiles();
    files.set(
      "src/planted-mutant.ts",
      "const a = loadConfig().access.dataDir;\nconst b = process.env.OPENPLANS_DATA_DIR;",
    );
    expect(unreadKeys(paths, [...files.values()])).not.toContain(
      "access.dataDir",
    );
    expect(directEnvironmentReaders(files)["access.dataDir"]).toEqual([
      "src/planted-mutant.ts",
    ]);
  });

  it("refuses only keys whose environment variable exists", () => {
    const mapped = new Set<string>(Object.values(environmentPaths));
    for (const [path, variable] of environmentOnlyPaths) {
      expect(mapped.has(path)).toBe(true);
      expect(environmentPaths).toHaveProperty(variable, path);
    }
  });
});

describe("file keys wired to their readers", () => {
  const writeConfig = (settings: Record<string, unknown>) => {
    const file = join(directory, `config-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, ...settings }));
    return file;
  };
  /** Clears the switches so only the file and the named overrides apply. */
  const useFile = (file: string, env: Record<string, string> = {}) => {
    vi.stubEnv("OPENPLANS_CONFIG", file);
    for (const name of Object.keys(environmentPaths))
      vi.stubEnv(name, env[name]);
  };

  it.each([
    ["medicarePartD", "OPENPLANS_MEDICARE_PART_D", partDEnabled],
    ["medicareDrugCost", "OPENPLANS_MEDICARE_DRUG_COST", drugCostEnabled],
    [
      "medicareDrugCostPrices",
      "OPENPLANS_MEDICARE_DRUG_COST_PRICES",
      drugCostPricingEnabled,
    ],
    ["gaQuoteRecovery", "OPENPLANS_GA_QUOTE_RECOVERY", georgiaQuoteRecovery],
  ] as const)(
    "%s in the file turns the switch on; %s overrides it",
    (key, variable, read) => {
      useFile(writeConfig({}));
      expect(read()).toBe(false);
      const on = writeConfig({ [key]: true });
      useFile(on);
      expect(read()).toBe(true);
      useFile(on, { [variable]: "off" });
      expect(read()).toBe(false);
      useFile(writeConfig({ [key]: false }), { [variable]: "on" });
      expect(read()).toBe(true);
    },
  );

  it("compat.benefitText in the file selects compact text; the environment overrides it", () => {
    useFile(writeConfig({}));
    expect(benefitTextOptions()).toEqual({ compact: false });
    const on = writeConfig({ compat: { benefitText: true } });
    useFile(on);
    expect(benefitTextOptions()).toEqual({ compact: true });
    useFile(on, { OPENPLANS_COMPAT_BENEFIT_TEXT: "full" });
    expect(benefitTextOptions()).toEqual({ compact: false });
  });

  it("access.dataDir in the file sets the data directory and blob root; OPENPLANS_DATA_DIR overrides it", () => {
    const fromFile = join(directory, "file-data");
    const fromEnv = join(directory, "env-data");
    useFile(writeConfig({}));
    expect(configuredDataDirectory()).toBeUndefined();
    expect(dataDirectory()).toBe(defaultDataDirectory());
    expect(loadConfig().blobs.root).toBeUndefined();
    const file = writeConfig({ access: { dataDir: fromFile } });
    useFile(file);
    expect(dataDirectory()).toBe(fromFile);
    expect(loadConfig().blobs.root).toBe(fromFile);
    useFile(file, { OPENPLANS_DATA_DIR: fromEnv });
    expect(dataDirectory()).toBe(fromEnv);
    expect(loadConfig().blobs.root).toBe(fromEnv);
    // A blob root named in the file keeps precedence over the file's data directory.
    const blobRoot = join(directory, "blob-root");
    useFile(
      writeConfig({ access: { dataDir: fromFile }, blobs: { root: blobRoot } }),
    );
    expect(dataDirectory()).toBe(fromFile);
    expect(loadConfig().blobs.root).toBe(blobRoot);
  });

  it("access.egressCountry in the file declares the country; OPENPLANS_EGRESS_COUNTRY overrides it", () => {
    useFile(writeConfig({}));
    expect(egressCountry()).toBeUndefined();
    const file = writeConfig({ access: { egressCountry: "US" } });
    useFile(file);
    expect(egressCountry()).toBe("US");
    useFile(file, { OPENPLANS_EGRESS_COUNTRY: "CA" });
    expect(egressCountry()).toBe("CA");
    // Compose passes an empty variable when .env leaves it out; empty stays unset.
    useFile(writeConfig({}), { OPENPLANS_EGRESS_COUNTRY: "" });
    expect(egressCountry()).toBeUndefined();
  });

  it("cmsFallback.quotes in the file needs the main switch and the key from the environment", () => {
    const key = { CMS_API_KEY: synthetic };
    useFile(writeConfig({ cmsFallback: { enabled: true } }), key);
    expect(quoteFallbackEnabled()).toBe(false);
    const on = writeConfig({ cmsFallback: { enabled: true, quotes: true } });
    useFile(on);
    expect(quoteFallbackEnabled()).toBe(false);
    useFile(on, key);
    expect(quoteFallbackEnabled()).toBe(true);
    useFile(on, { ...key, OPENPLANS_CMS_FALLBACK_QUOTES: "off" });
    expect(quoteFallbackEnabled()).toBe(false);
    useFile(on, { ...key, OPENPLANS_CMS_FALLBACK: "off" });
    expect(quoteFallbackEnabled()).toBe(false);
  });
});

describe("secrets in the config file", () => {
  const fileSecrets = secretPaths().filter(
    (path) => !environmentOnlyPaths.has(path),
  );

  it("finds the secret keys the file may set", () => {
    expect(fileSecrets).toEqual(
      expect.arrayContaining([
        "db.connectionString",
        "tokens.api",
        "tokens.compatKey",
      ]),
    );
    expect(fileSecrets).not.toContain("cmsFallback.apiKey");
    expect(fileSecrets).not.toContain("tokens.compatKeyHeader");
  });

  it("keeps every secret from the file wrapped and out of output", () => {
    expect(
      secretsExposedFromFile((file) => loadConfig({}, file), fileSecrets),
    ).toEqual([]);
  });

  it("negative control: a secret accepted from the file as plain text fails the check", () => {
    const unwrapped = (file: unknown) => {
      const config = loadConfig({}, file);
      return {
        ...config,
        tokens: {
          ...config.tokens,
          compatKey: config.tokens.compatKey?.reveal(),
        },
      };
    };
    expect(secretsExposedFromFile(unwrapped, fileSecrets)).toEqual([
      "tokens.compatKey",
    ]);
  });

  it("negative control: a refused secret accepted from the file fails the refusal check", () => {
    // A loader that drops the refusal would hand the file's CMS key to its reader.
    const accepting = (file: unknown) => {
      const { cmsFallback, ...rest } = file as Record<string, unknown>;
      const config = loadConfig({}, rest);
      const key = (cmsFallback as { apiKey?: string } | undefined)?.apiKey;
      return {
        ...config,
        cmsFallback: {
          ...config.cmsFallback,
          apiKey: key === undefined ? undefined : new SecretValue(key),
        },
      };
    };
    const refused = (load: (file: unknown) => unknown) => {
      try {
        load({ version: 1, cmsFallback: { apiKey: synthetic } });
        return false;
      } catch (error) {
        return error instanceof EnvironmentOnlyKeyError;
      }
    };
    expect(refused((file) => loadConfig({}, file))).toBe(true);
    expect(refused(accepting)).toBe(false);
  });

  it("keeps a malformed secret's value out of the startup error", () => {
    for (const path of fileSecrets) {
      const [group, field] = path.split(".") as [string, string];
      let message = "";
      try {
        loadConfig({}, { version: 1, [group]: { [field]: [synthetic] } });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("Invalid OpenPlans configuration");
    }
  });
});

describe("remaining keys wired through the config", () => {
  const writeConfig = (settings: Record<string, unknown>) => {
    const file = join(directory, `wired-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, ...settings }));
    return file;
  };
  const useFile = (file: string, env: Record<string, string> = {}) => {
    vi.stubEnv("OPENPLANS_CONFIG", file);
    for (const name of Object.keys(environmentPaths))
      vi.stubEnv(name, env[name]);
  };
  const manifest = join(directory, "operator-manifest.json");

  it.each([
    [
      "db.connectionString",
      databaseUrl,
      { db: { connectionString: "postgres://synthetic-file/db" } },
      "DATABASE_URL",
      "postgres://synthetic-env/db",
      undefined,
      "postgres://synthetic-file/db",
      "postgres://synthetic-env/db",
    ],
    [
      "cache.enabled",
      responseCacheEnabled,
      { cache: { enabled: false } },
      "OPENPLANS_API_CACHE",
      "on",
      true,
      false,
      true,
    ],
    [
      "access.operatorManifest",
      operatorManifest,
      { access: { operatorManifest: manifest } },
      "OPENPLANS_ACCESS_MANIFEST",
      "/synthetic/env-manifest.json",
      undefined,
      manifest,
      "/synthetic/env-manifest.json",
    ],
    [
      "access.projectUrl",
      projectUrl,
      { access: { projectUrl: "https://file.example/" } },
      "OPENPLANS_PROJECT_URL",
      "https://env.example/",
      "https://plans.openhra.com/",
      "https://file.example/",
      "https://env.example/",
    ],
    [
      "public.quoting",
      () => publicAccess().quoting,
      { public: { quoting: false } },
      "OPENPLANS_PUBLIC_QUOTING",
      "on",
      true,
      false,
      true,
    ],
    [
      "public.household",
      () => publicAccess().household,
      { public: { household: false } },
      "OPENPLANS_PUBLIC_HOUSEHOLD",
      "",
      true,
      false,
      true,
    ],
    [
      "public.compat",
      () => publicAccess().compat,
      { public: { compat: true } },
      "OPENPLANS_PUBLIC_COMPAT",
      "off",
      true,
      true,
      false,
    ],
    [
      "tokens.api",
      apiToken,
      { tokens: { api: `${synthetic}-file` } },
      "OPENPLANS_API_TOKEN",
      `${synthetic}-env`,
      undefined,
      `${synthetic}-file`,
      `${synthetic}-env`,
    ],
    [
      "tokens.compatKey",
      compatApiKey,
      { tokens: { compatKey: `${synthetic}-file` } },
      "OPENPLANS_COMPAT_API_KEY",
      `${synthetic}-env`,
      undefined,
      `${synthetic}-file`,
      `${synthetic}-env`,
    ],
    [
      "tokens.compatKeyHeader",
      compatKeyHeaderName,
      { tokens: { compatKeyHeader: "X-File-Key" } },
      "OPENPLANS_COMPAT_KEY_HEADER",
      "X-Env-Key",
      undefined,
      "X-File-Key",
      "X-Env-Key",
    ],
    [
      "trustProxy",
      trustedProxies,
      { trustProxy: ["10.0.0.1"] },
      "OPENPLANS_TRUST_PROXY",
      "10.0.0.2, 10.0.0.3",
      [],
      ["10.0.0.1"],
      ["10.0.0.2", "10.0.0.3"],
    ],
  ] as const)(
    "%s comes from the file, and the variable overrides it",
    (_path, read, settings, variable, envValue, unset, fromFile, fromEnv) => {
      useFile(writeConfig({}));
      expect(read()).toEqual(unset);
      const file = writeConfig(settings);
      useFile(file);
      expect(read()).toEqual(fromFile);
      useFile(file, { [variable]: envValue });
      expect(read()).toEqual(fromEnv);
    },
  );

  it("an empty DATABASE_URL or compatibility key counts as unset", () => {
    useFile(writeConfig({}), {
      DATABASE_URL: "",
      OPENPLANS_COMPAT_API_KEY: "",
    });
    expect(databaseUrl()).toBeUndefined();
    expect(compatApiKey()).toBeUndefined();
  });

  it("tokens.compatKey in the file guards the compatibility routes", async () => {
    const db = {} as SqlSession;
    const key = `${synthetic}-compat`;
    useFile(writeConfig({ tokens: { compatKey: key } }));
    const app = compatRoutes(db);
    const status = async (headers: Record<string, string>) =>
      (await app.request("/compat/v1/carriers", { headers })).status;
    expect(await status({})).toBe(401);
    expect(await status({ "X-Api-Key": "synthetic-wrong" })).toBe(401);
    expect(await status({ "X-Api-Key": key })).not.toBe(401);
    // The header name from the file is accepted as the extra credential header.
    useFile(
      writeConfig({
        tokens: { compatKey: key, compatKeyHeader: "X-File-Key" },
      }),
    );
    const withHeader = compatRoutes(db);
    expect(
      (
        await withHeader.request("/compat/v1/carriers", {
          headers: { "X-File-Key": key },
        })
      ).status,
    ).not.toBe(401);
  });
});

describe("environment-only keys refused in the file", () => {
  it.each([...environmentOnlyPaths])(
    "refuses %s and names %s",
    (path, variable) => {
      const [group, field] = path.split(".") as [string, string];
      const file = { version: 1, [group]: { [field]: synthetic } };
      let error: unknown;
      try {
        loadConfig({}, file);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EnvironmentOnlyKeyError);
      const message = (error as Error).message;
      expect(message).toContain(path);
      expect(message).toContain(variable);
      expect(message).not.toContain(synthetic);
      // The environment variable keeps working, and an empty section stays valid.
      expect(() => loadConfig({ [variable]: synthetic })).not.toThrow();
      expect(() => loadConfig({}, { version: 1, [group]: {} })).not.toThrow();
    },
  );

  it.each([
    ["dist/api/server.js", { PORT: "3000" }],
    ["dist/worker/cli.js", {}],
  ] as const)("%s exits with the refusal as its only output", (entry, env) => {
    const file = join(directory, "environment-only.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, compose: { user: synthetic } }),
    );
    const result = spawnSync(process.execPath, [entry, "status"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...env,
        OPENPLANS_CONFIG: file,
        OPENPLANS_PLUGINS: "",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "OPENPLANS_CONFIG sets compose.user, which is read only from the environment; set POSTGRES_USER instead\n",
    );
    expect(result.stdout).toBe("");
  });
});
