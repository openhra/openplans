import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
} from "../../src/config/index.js";
import { partDEnabled } from "../../src/services/medicare-part-d.js";
import {
  drugCostEnabled,
  drugCostPricingEnabled,
} from "../../src/services/medicare-drug-cost.js";
import { quoteFallbackEnabled } from "../../src/services/quote-coverage.js";
import { benefitTextOptions } from "../../src/compat/v1/index.js";
import { georgiaQuoteRecovery } from "../../src/ingest/sbe/georgia.js";
import {
  configuredDataDirectory,
  dataDirectory,
  defaultDataDirectory,
  egressCountry,
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
 * Keys still read from the environment in some places. Each is a known follow-up; remove an entry
 * once its last direct reader goes through `loadConfig`. The check fails on a new key and on a
 * stale entry alike.
 */
const halfWiredFollowUps = [
  "db.connectionString",
  "cache.enabled",
  "access.operatorManifest",
  "access.projectUrl",
  "public.quoting",
  "public.household",
  "public.compat",
  "tokens.api",
  "tokens.compatKey",
  "tokens.compatKeyHeader",
  "trustProxy",
];

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
    expect(direct).not.toHaveProperty(["access.dataDir"]);
    expect(direct).not.toHaveProperty(["access.egressCountry"]);
  });

  it.each([
    ["access.dataDir", 'const root = process.env.OPENPLANS_DATA_DIR ?? "/";'],
    [
      "access.egressCountry",
      'const country = env["OPENPLANS_EGRESS_COUNTRY"];',
    ],
    ["access.dataDir", "const root = process.env?.OPENPLANS_DATA_DIR;"],
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
