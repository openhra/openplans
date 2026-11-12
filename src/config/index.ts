import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";

export type Environment = Record<string, string | undefined>;

/** Values require explicit access; logs and JSON only show whether one is set. */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "<set>";
  }
  toString(): string {
    return "<set>";
  }
  [inspect.custom](): string {
    return "<set>";
  }
}
export const secret = z
  .preprocess(
    (value) => (value === "" ? undefined : value),
    z.union([z.string().min(1), z.instanceof(SecretValue)]).optional(),
  )
  .transform((value) => {
    if (value === undefined) return undefined;
    return value instanceof SecretValue ? value : new SecretValue(value);
  });

export function onUnlessOff(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${name} must be on or off`);
}
const text = z.string().optional();
const section = <T extends z.ZodRawShape>(shape: T) => {
  const schema = z.object(shape).strict();
  return schema.prefault({} as z.input<typeof schema>);
};
const portMessage = "PORT must be an integer between 1 and 65535";
const cacheMessage = "OPENPLANS_API_CACHE_MB must be an integer from 0 to 4096";
const locals = ["127.0.0.1", "localhost", "[::1]"];
const pluginSchema = z.object({
  package: z.string().min(1),
  enabled: z.boolean().default(true),
  options: z.unknown().optional(),
  optionalSecrets: z.array(z.string()).default([]),
  sources: z
    .record(
      z.string(),
      z.object({
        cacheLevel: z.enum(["none", "request", "memory", "stored"]).optional(),
        ttl: text,
        staleWindow: text,
        negativeTtl: text,
      }),
    )
    .default({}),
});

export const coreConfigSchema = z
  .object({
    db: section({
      provider: z.string().default("pg"),
      connectionString: secret,
    }),
    listen: section({
      port: z
        .number()
        .refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, portMessage)
        .default(3000),
      host: z.string().default("127.0.0.1"),
    }),
    cache: section({
      enabled: z.boolean().default(true),
      // "memory", "valkey" or a plugin's store; unknown names are refused when plugins load.
      provider: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,31}$/)
        .default("memory"),
      maxMb: z
        .number()
        .refine(
          (n) => Number.isSafeInteger(n) && n >= 0 && n <= 4096,
          cacheMessage,
        )
        .default(64),
      url: secret,
    }),
    blobs: section({ provider: z.string().default("local"), root: text }),
    access: section({
      dataDir: text,
      operatorManifest: text,
      shipped: z.boolean().default(true),
      projectUrl: z.string().default("https://plans.openhra.com/"),
      egressCountry: text,
      egressFile: text,
      egressSha256: text,
    }),
    public: section({
      quoting: z.boolean().default(true),
      household: z.boolean().default(true),
      compat: z.boolean().default(true),
    }),
    tokens: section({
      api: secret,
      compatKey: secret,
      compatKeyHeader: text.refine(
        (value) => !value || /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value),
        "OPENPLANS_COMPAT_KEY_HEADER must be a single RFC 7230 token",
      ),
      mcp: secret,
      mcpCursorSecret: secret,
      operator: secret,
    }),
    mcp: section({
      enabled: z.boolean().default(true),
      allowedHosts: z.array(z.string()).optional(),
      allowedOrigins: z.array(z.string()).optional(),
      // Other values have always inherited the household policy.
      allowPersonalized: text,
    }),
    trustProxy: z.array(z.string()).default([]),
    cmsFallback: section({
      enabled: z.boolean().default(false),
      quotes: z.boolean().default(false),
      apiKey: secret,
    }),
    compat: section({
      catastrophicAgeRule: z.boolean().default(false),
      benefitText: z.boolean().default(false),
    }),
    medicarePartD: z.boolean().default(false),
    medicareDrugCost: z.boolean().default(false),
    gaQuoteRecovery: z.boolean().default(false),
    // These readers migrate later; their defaults depend on the selected runner or Compose service.
    compose: section({
      user: text,
      password: secret,
      database: text,
      apiPort: text,
      dbPort: text,
      image: text,
      dbMemory: text,
      cacheMemory: text,
      rawReadOnly: text,
    }),
    geocoder: section({
      url: secret,
      key: secret,
      latPath: text,
      lonPath: text,
      countyPath: text,
      intervalMs: text,
      store: text,
      openUrl: text,
      state: text,
      snapshot: text,
      port: text,
    }),
    runners: section({
      pgliteDir: text,
      pufDb: text,
      formularyDb: text,
      formularyReport: text,
      providerDb: text,
      qhpDb: text,
      qhpDatabaseUrl: secret,
      qhpCatalogDb: text,
      qhpMigrationsDirectory: text,
      qhpState: text,
      qhpYear: text,
      qhpIssuer: text,
      qhpEnrichment: text,
      qhpResume: text,
      qhpRunBudgetMs: text,
      qhpReportPrefix: text,
      referenceCapturesDir: text,
      denylistFile: text,
      composeProject: text,
      smokeTmpdir: text,
    }),
    plugins: z.array(pluginSchema).default([]),
  })
  .strict();

type MutableConfig = z.output<typeof coreConfigSchema>;
type Frozen<T> = T extends SecretValue
  ? T
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;
export type CoreConfig = Frozen<
  MutableConfig & { mcp: { allowedHosts: string[]; allowedOrigins: string[] } }
>;
export type CoreConfigView = Omit<
  CoreConfig,
  "tokens" | "db" | "cmsFallback" | "cache" | "compose" | "geocoder" | "runners"
> & {
  db: Omit<CoreConfig["db"], "connectionString">;
  cmsFallback: Omit<CoreConfig["cmsFallback"], "apiKey">;
  cache: Omit<CoreConfig["cache"], "url">;
  compose: Omit<CoreConfig["compose"], "password">;
  geocoder: Omit<CoreConfig["geocoder"], "key" | "url">;
  runners: Omit<CoreConfig["runners"], "qhpDatabaseUrl">;
};
function freeze<T>(value: T): Frozen<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}
export function coreConfigView(config: CoreConfig): CoreConfigView {
  const {
    tokens: _tokens,
    db,
    cmsFallback,
    cache,
    compose,
    geocoder,
    runners,
    ...rest
  } = config;
  const { connectionString: _connection, ...publicDb } = db;
  const { apiKey: _key, ...publicCms } = cmsFallback;
  const { url: _cacheUrl, ...publicCache } = cache;
  const { password: _password, ...publicCompose } = compose;
  const { key: _geocoderKey, url: _geocoderUrl, ...publicGeocoder } = geocoder;
  const { qhpDatabaseUrl: _qhpUrl, ...publicRunners } = runners;
  return freeze({
    ...rest,
    db: publicDb,
    cmsFallback: publicCms,
    cache: publicCache,
    compose: publicCompose,
    geocoder: publicGeocoder,
    runners: publicRunners,
  });
}

const list = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
// Every documented variable has one destination, including options whose readers migrate later.
export const environmentPaths = {
  DATABASE_URL: "db.connectionString",
  PORT: "listen.port",
  HOST: "listen.host",
  OPENPLANS_API_CACHE: "cache.enabled",
  OPENPLANS_API_CACHE_MB: "cache.maxMb",
  OPENPLANS_CACHE_URL: "cache.url",
  OPENPLANS_DATA_DIR: "access.dataDir",
  OPENPLANS_ACCESS_MANIFEST: "access.operatorManifest",
  OPENPLANS_SHIPPED_ACCESS: "access.shipped",
  OPENPLANS_PROJECT_URL: "access.projectUrl",
  OPENPLANS_EGRESS_COUNTRY: "access.egressCountry",
  OPENPLANS_EGRESS_FILE: "access.egressFile",
  OPENPLANS_EGRESS_SHA256: "access.egressSha256",
  OPENPLANS_PUBLIC_QUOTING: "public.quoting",
  OPENPLANS_PUBLIC_HOUSEHOLD: "public.household",
  OPENPLANS_PUBLIC_COMPAT: "public.compat",
  OPENPLANS_API_TOKEN: "tokens.api",
  OPENPLANS_COMPAT_API_KEY: "tokens.compatKey",
  OPENPLANS_COMPAT_KEY_HEADER: "tokens.compatKeyHeader",
  OPENPLANS_MCP_TOKEN: "tokens.mcp",
  OPENPLANS_MCP_CURSOR_SECRET: "tokens.mcpCursorSecret",
  OPENPLANS_OPERATOR_TOKEN: "tokens.operator",
  OPENPLANS_MCP: "mcp.enabled",
  OPENPLANS_MCP_ALLOWED_HOSTS: "mcp.allowedHosts",
  OPENPLANS_MCP_ALLOWED_ORIGINS: "mcp.allowedOrigins",
  OPENPLANS_MCP_ALLOW_PERSONALIZED: "mcp.allowPersonalized",
  OPENPLANS_TRUST_PROXY: "trustProxy",
  OPENPLANS_CMS_FALLBACK: "cmsFallback.enabled",
  OPENPLANS_CMS_FALLBACK_QUOTES: "cmsFallback.quotes",
  CMS_API_KEY: "cmsFallback.apiKey",
  OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE: "compat.catastrophicAgeRule",
  OPENPLANS_COMPAT_BENEFIT_TEXT: "compat.benefitText",
  OPENPLANS_MEDICARE_PART_D: "medicarePartD",
  OPENPLANS_MEDICARE_DRUG_COST: "medicareDrugCost",
  OPENPLANS_GA_QUOTE_RECOVERY: "gaQuoteRecovery",
  POSTGRES_USER: "compose.user",
  POSTGRES_PASSWORD: "compose.password",
  POSTGRES_DB: "compose.database",
  API_PORT: "compose.apiPort",
  DB_PORT: "compose.dbPort",
  OPENPLANS_IMAGE: "compose.image",
  OPENPLANS_DB_MEMORY: "compose.dbMemory",
  OPENPLANS_CACHE_MEMORY: "compose.cacheMemory",
  OPENPLANS_RAW_READ_ONLY: "compose.rawReadOnly",
  OPENPLANS_GEOCODER_URL: "geocoder.url",
  OPENPLANS_GEOCODER_KEY: "geocoder.key",
  OPENPLANS_GEOCODER_LAT_PATH: "geocoder.latPath",
  OPENPLANS_GEOCODER_LON_PATH: "geocoder.lonPath",
  OPENPLANS_GEOCODER_COUNTY_PATH: "geocoder.countyPath",
  OPENPLANS_GEOCODER_INTERVAL_MS: "geocoder.intervalMs",
  OPENPLANS_GEOCODER_STORE: "geocoder.store",
  OPENPLANS_OPEN_GEOCODER_URL: "geocoder.openUrl",
  OPENPLANS_GEOCODER_STATE: "geocoder.state",
  OPENPLANS_GEOCODER_SNAPSHOT: "geocoder.snapshot",
  OPENPLANS_GEOCODER_PORT: "geocoder.port",
  OPENPLANS_PGLITE_DIR: "runners.pgliteDir",
  OPENPLANS_PUF_DB: "runners.pufDb",
  OPENPLANS_FORMULARY_DB: "runners.formularyDb",
  OPENPLANS_FORMULARY_REPORT: "runners.formularyReport",
  OPENPLANS_PROVIDER_DB: "runners.providerDb",
  OPENPLANS_QHP_DB: "runners.qhpDb",
  OPENPLANS_QHP_DATABASE_URL: "runners.qhpDatabaseUrl",
  OPENPLANS_QHP_CATALOG_DB: "runners.qhpCatalogDb",
  OPENPLANS_QHP_MIGRATIONS_DIRECTORY: "runners.qhpMigrationsDirectory",
  OPENPLANS_QHP_STATE: "runners.qhpState",
  OPENPLANS_QHP_YEAR: "runners.qhpYear",
  OPENPLANS_QHP_ISSUER: "runners.qhpIssuer",
  OPENPLANS_QHP_ENRICHMENT: "runners.qhpEnrichment",
  OPENPLANS_QHP_RESUME: "runners.qhpResume",
  OPENPLANS_QHP_RUN_BUDGET_MS: "runners.qhpRunBudgetMs",
  OPENPLANS_QHP_REPORT_PREFIX: "runners.qhpReportPrefix",
  OPENPLANS_REFERENCE_CAPTURES_DIR: "runners.referenceCapturesDir",
  OPENPLANS_DENYLIST_FILE: "runners.denylistFile",
  OPENPLANS_COMPOSE_PROJECT: "runners.composeProject",
  OPENPLANS_SMOKE_TMPDIR: "runners.smokeTmpdir",
} as const;
const publicSwitches = new Set([
  "OPENPLANS_PUBLIC_QUOTING",
  "OPENPLANS_PUBLIC_HOUSEHOLD",
  "OPENPLANS_PUBLIC_COMPAT",
]);
const unlessOff = new Set([
  "OPENPLANS_API_CACHE",
  "OPENPLANS_SHIPPED_ACCESS",
  "OPENPLANS_MCP",
]);
const onlyOn = new Set([
  "OPENPLANS_CMS_FALLBACK",
  "OPENPLANS_CMS_FALLBACK_QUOTES",
  "OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE",
  "OPENPLANS_MEDICARE_PART_D",
  "OPENPLANS_MEDICARE_DRUG_COST",
  "OPENPLANS_GA_QUOTE_RECOVERY",
]);
function envValue(name: string, value: string): unknown {
  if (publicSwitches.has(name)) return onUnlessOff(name, value);
  if (unlessOff.has(name)) return value !== "off";
  if (onlyOn.has(name)) return value === "on";
  if (name === "OPENPLANS_COMPAT_BENEFIT_TEXT") return value === "compact";
  if (name === "PORT" || name === "OPENPLANS_API_CACHE_MB")
    return Number(value);
  if (
    name === "OPENPLANS_MCP_ALLOWED_HOSTS" ||
    name === "OPENPLANS_MCP_ALLOWED_ORIGINS"
  )
    return value === "" ? undefined : list(value);
  if (name === "OPENPLANS_TRUST_PROXY") return list(value);
  return value;
}

/** Load afresh so injected environments and later operator changes are never cached globally. */
export function loadConfig(
  env: Environment = process.env,
  file?: unknown,
  defaults: { port?: number } = {},
): CoreConfig {
  let input = file;
  if (input === undefined && env.OPENPLANS_CONFIG) input = env.OPENPLANS_CONFIG;
  if (typeof input === "string") {
    if (!isAbsolute(input))
      throw new Error("OPENPLANS_CONFIG must be an absolute path");
    let contents: string;
    try {
      contents = readFileSync(input, "utf8");
    } catch {
      throw new Error("OPENPLANS_CONFIG could not be read");
    }
    try {
      input = JSON.parse(contents);
    } catch {
      throw new Error("OPENPLANS_CONFIG must contain valid JSON");
    }
  }
  const envelope = z
    .object({ version: z.literal(1) })
    .passthrough()
    .safeParse(input);
  if (input !== undefined && !envelope.success)
    throw new Error("OPENPLANS_CONFIG must have version 1");
  const settings: Record<string, unknown> = envelope.success
    ? envelope.data
    : {};
  delete settings.version;
  if (defaults.port !== undefined)
    settings.listen = { port: defaults.port, ...Object(settings.listen) };
  for (const [name, path] of Object.entries(environmentPaths)) {
    const value = env[name];
    if (value === undefined) continue;
    const [group, field] = path.split(".");
    if (field === undefined) settings[group!] = envValue(name, value);
    else {
      const existing = settings[group!];
      const section = existing && typeof existing === "object" ? existing : {};
      settings[group!] = { ...section, [field]: envValue(name, value) };
    }
  }
  if (env.OPENPLANS_DATA_DIR !== undefined)
    settings.blobs = {
      ...Object(settings.blobs),
      root: env.OPENPLANS_DATA_DIR,
    };
  // Empty counts as unset, because Compose passes the variable even when .env leaves it out.
  const plugins = list(env.OPENPLANS_PLUGINS ?? "");
  if (plugins.length)
    settings.plugins = plugins.map((name) => ({ package: name }));
  const result = coreConfigSchema.safeParse(settings);
  if (!result.success) {
    // Never include values from a file or environment in a startup diagnostic.
    const issue = result.error.issues[0];
    if (issue?.path.join(".") === "listen.port") throw new Error(portMessage);
    if (issue?.path.join(".") === "cache.maxMb") throw new Error(cacheMessage);
    if (issue?.path.join(".") === "tokens.compatKeyHeader")
      throw new Error(
        "OPENPLANS_COMPAT_KEY_HEADER must be a single RFC 7230 token",
      );
    throw new Error("Invalid OpenPlans configuration");
  }
  const config = result.data;
  if (config.cache.url) config.cache.provider = "valkey";
  const port = env.PORT ?? String(config.listen.port);
  return freeze({
    ...config,
    mcp: {
      ...config.mcp,
      allowedHosts: config.mcp.allowedHosts ?? [
        ...locals,
        ...locals.map((h) => `${h}:${port}`),
      ],
      allowedOrigins:
        config.mcp.allowedOrigins ?? locals.map((h) => `http://${h}:${port}`),
    },
  });
}
