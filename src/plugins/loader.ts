import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import type {
  AdmittedFetch,
  HostPluginEntry,
  McpToolSpec,
  OpenPlansPlugin,
  PluginContext,
  PluginFactory,
  PluginManifest,
} from "@openplans/plugin-sdk";
import { coreConfigView } from "../config/index.js";
import type { CoreConfig, Environment } from "../config/index.js";
import type { PluginMigrationSource } from "../db/migrate.js";
import type { PublisherPolicy } from "../fetch/admission.js";
import { shippedManifestPaths } from "../fetch/shipped.js";
import { hostRefusal, readPublishers } from "./hosts.js";
import { packageRoot, packageSha256 } from "./package-hash.js";
import { createStatusHost } from "./status-host.js";
import type { LoadedStatus, StatusHostParts } from "./status-host.js";
import { toolPageRefusal } from "./mcp-tools.js";
import {
  activateRegistries,
  currentRegistries,
  emptyRegistries,
  emptySeen,
  freezeRegistries,
  PluginRefusal,
} from "./registries.js";
import type {
  PluginHost,
  PluginRegistries,
  RefusalCode,
} from "./registries.js";
import { stagingRegistrar } from "./registries.js";
import {
  CORE_PLUGIN_NAME,
  providerTables,
  unknownProviders,
} from "./providers.js";
import {
  operatorPassThrough,
  operatorSourcePolicies,
  passThroughSourcesOf,
  PassThroughPolicyRefusal,
} from "./sources/passthrough.js";
import type { OperatorPassThrough } from "./sources/passthrough.js";

export const TEARDOWN_BOUND_MS = 5_000;
// The same key pattern the response cache uses to keep credentials out of stored bodies.
const SECRET_KEY =
  /authorization|credential|password|secret|token|api[-_]?key|cookie/i;

export interface LoadPluginsOptions {
  /** Where declared secrets are read. Defaults to the process environment. */
  env?: Environment;
  /** Base for relative specifiers: the config file's directory, or the working directory. */
  baseDirectory?: string;
  /** Reviewed admission manifests. Defaults to the shipped ones plus the operator manifest. */
  manifestPaths?: readonly string[];
  now?: () => number;
  db?: PluginContext["db"];
  fetch?: AdmittedFetch;
  /** One fetch per plugin, scoped to its manifest; wins over `fetch`. */
  fetchFor?: (manifest: PluginManifest, config: CoreConfig) => AdmittedFetch;
  writeLog?: (line: string) => void;
  exit?: (code: number) => never;
  teardownBoundMs?: number;
  /**
   * What this process can tell a plugin that declares `capabilities.hostStatus` (design 5.11).
   * Without it, such a plugin still gets the version, plugin list, cache probe and pass-through
   * counters, but no pool waits or response cache counters.
   */
  statusHost?: StatusHostParts;
}
export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  /** The package hash (`packageSha256`); null when it could not be computed. */
  readonly sha256: string | null;
}
export interface LoadedPlugins {
  readonly registries: PluginRegistries;
  readonly plugins: readonly LoadedPlugin[];
  /** Reverse load order, each plugin bounded to TEARDOWN_BOUND_MS. */
  readonly teardown: () => Promise<void>;
  /**
   * The operator's pass-through levels and TTLs from `plugins[].sources`, already checked: a
   * looser setting refuses the load. Hosts pass them to `configureHostPassThrough`.
   */
  readonly passThrough: OperatorPassThrough;
  /**
   * Design 5.13: each loaded plugin's `migrations` directory, in configuration order. A plugin
   * whose module has no package root of its own has none.
   */
  readonly migrations: readonly PluginMigrationSource[];
}
interface Candidate {
  plugin: OpenPlansPlugin;
  manifest: PluginManifest;
  options: unknown;
  /** The module's factory, kept for plugins that declare `capabilities.hostStatus`. */
  factory?: PluginFactory;
  /** The resolved module file, for the package hash. */
  file?: string;
}

export { currentRegistries };

const refuse = (plugin: string, code: RefusalCode, reason?: string): never => {
  throw new PluginRefusal(plugin, code, reason);
};

function moduleSpecifier(name: string, base: string): string {
  if (isAbsolute(name) || name.startsWith("./") || name.startsWith("../"))
    return pathToFileURL(resolve(base, name)).href;
  return name;
}

function isPlugin(value: unknown): value is OpenPlansPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpenPlansPlugin>;
  return (
    Boolean(candidate.manifest) &&
    typeof candidate.manifest === "object" &&
    typeof candidate.setup === "function" &&
    (candidate.teardown === undefined ||
      typeof candidate.teardown === "function")
  );
}

function moduleFile(specifier: string): string | undefined {
  try {
    const url = specifier.startsWith("file:")
      ? specifier
      : import.meta.resolve(specifier);
    return url.startsWith("file:") ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

async function importPlugin(
  specifier: string,
  base: string,
): Promise<Omit<Candidate, "options">> {
  let module: { default?: unknown; createPlugin?: unknown };
  const resolved = moduleSpecifier(specifier, base);
  try {
    module = await import(resolved);
  } catch {
    return refuse(specifier, "plugin_import_failed");
  }
  const plugin = module.default;
  if (!isPlugin(plugin)) return refuse(specifier, "plugin_export_invalid");
  const declared = plugin.manifest as { name?: unknown; apiVersion?: unknown };
  const label = typeof declared.name === "string" ? declared.name : specifier;
  if (declared.apiVersion !== PLUGIN_API_VERSION)
    return refuse(label, "plugin_api_version_mismatch");
  const manifest = pluginManifestSchema.safeParse(plugin.manifest);
  if (!manifest.success) return refuse(label, "plugin_export_invalid");
  const wantsHost = manifest.data.capabilities?.hostStatus === true;
  if (wantsHost && typeof module.createPlugin !== "function")
    return refuse(label, "plugin_export_invalid");
  return {
    plugin,
    manifest: manifest.data,
    factory: wantsHost ? (module.createPlugin as PluginFactory) : undefined,
    file: moduleFile(resolved),
  };
}

/** The factory's plugin must be the default export's plugin: same manifest identity. */
function hostedPlugin(
  candidate: Candidate,
  host: Parameters<PluginFactory>[0]["host"],
): OpenPlansPlugin {
  const name = candidate.manifest.name;
  let built: unknown;
  try {
    built = candidate.factory!({ host });
  } catch {
    return refuse(name, "plugin_export_invalid");
  }
  if (!isPlugin(built)) return refuse(name, "plugin_export_invalid");
  const manifest = pluginManifestSchema.safeParse(built.manifest);
  if (
    !manifest.success ||
    manifest.data.name !== name ||
    manifest.data.version !== candidate.manifest.version ||
    manifest.data.tablePrefix !== candidate.manifest.tablePrefix ||
    JSON.stringify(manifest.data.kinds) !==
      JSON.stringify(candidate.manifest.kinds) ||
    JSON.stringify(manifest.data.capabilities) !==
      JSON.stringify(candidate.manifest.capabilities)
  )
    return refuse(name, "plugin_export_invalid");
  return built;
}

// The core package's own root holds the core migrations; a module that resolves there (a
// single-file plugin inside this package) has no migrations of its own.
const corePackageRoot = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

async function pluginRoot(
  file: string | undefined,
): Promise<string | undefined> {
  const root = file && (await packageRoot(file));
  return root && resolve(root) !== corePackageRoot ? root : undefined;
}

async function pluginSha256(file: string | undefined): Promise<string | null> {
  const root = file && (await packageRoot(file));
  return (root && (await packageSha256(root))) || null;
}

export function defaultManifestPaths(config: CoreConfig): readonly string[] {
  const operator = config.access.operatorManifest;
  return [...shippedManifestPaths(), ...(operator ? [operator] : [])];
}

function boundedTeardown(
  plugin: OpenPlansPlugin,
  bound: number,
): Promise<"ok" | "failed" | "timeout"> {
  if (!plugin.teardown) return Promise.resolve("ok");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), bound);
    timer.unref();
  });
  const run = Promise.resolve()
    .then(() => plugin.teardown!())
    .then(
      () => "ok" as const,
      () => "failed" as const,
    );
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Design 5.3. Every check runs before any `setup`; registrations go to a staging object that
 * replaces the active registries only when every plugin succeeded. A refusal writes one JSON line
 * `{plugin, code}` and exits with code 1.
 */
export async function loadPlugins(
  config: CoreConfig,
  host: PluginHost,
  options: LoadPluginsOptions = {},
): Promise<LoadedPlugins> {
  const writeLog =
    options.writeLog ?? ((line) => void process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code) => process.exit(code));
  const bound = options.teardownBoundMs ?? TEARDOWN_BOUND_MS;
  const env = options.env ?? process.env;
  const started: OpenPlansPlugin[] = [];
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    for (const plugin of [...started].reverse()) {
      const outcome = await boundedTeardown(plugin, bound);
      if (outcome !== "ok")
        writeLog(
          JSON.stringify({
            plugin: plugin.manifest.name,
            code: `plugin_teardown_${outcome}`,
          }),
        );
    }
  };
  const staging = emptyRegistries();
  // Filled once every plugin ran setup; the host view reads it lazily.
  const status: { current?: LoadedStatus } = {};
  const statusHost = createStatusHost(
    config,
    options.statusHost ?? {},
    () => status.current,
  );
  const hashes = new Map<string, string | null>();
  const migrations: PluginMigrationSource[] = [];
  let passThrough: OperatorPassThrough | undefined;
  try {
    const candidates = await checkPlugins(config, options, env);
    for (const candidate of candidates) {
      hashes.set(candidate.manifest.name, await pluginSha256(candidate.file));
      const root = await pluginRoot(candidate.file);
      if (root)
        migrations.push(
          Object.freeze({
            plugin: candidate.manifest.name,
            ...(candidate.manifest.tablePrefix && {
              tablePrefix: candidate.manifest.tablePrefix,
            }),
            directory: join(root, "migrations"),
          }),
        );
    }
    const seen = emptySeen();
    // Deeply frozen at runtime; the SDK view types its arrays as mutable.
    const view = coreConfigView(config) as unknown as PluginContext["config"];
    const pluginTools: [string, McpToolSpec<unknown, unknown>[]][] = [];
    for (const candidate of candidates) {
      const name = candidate.manifest.name;
      if (candidate.factory)
        candidate.plugin = hostedPlugin(candidate, statusHost);
      const registrar = stagingRegistrar(
        staging,
        candidate.manifest,
        host,
        seen,
      );
      // Every host checks the tool page, including hosts that do not keep MCP tools.
      const tools: McpToolSpec<unknown, unknown>[] = [];
      const mcpTools: PluginContext["mcpTools"] = {
        add(spec) {
          registrar.context.mcpTools.add(spec);
          tools.push(spec as McpToolSpec<unknown, unknown>);
        },
      };
      const context: PluginContext = {
        plugin: { name, version: candidate.manifest.version },
        options: candidate.options,
        config: view,
        secrets: secretReader(candidate.manifest, env),
        log: pluginLog(name, writeLog),
        db: options.db ?? unavailableDatabase,
        fetch:
          options.fetchFor?.(candidate.manifest, config) ??
          options.fetch ??
          unavailableFetch,
        ...registrar.context,
        mcpTools,
      };
      started.push(candidate.plugin);
      try {
        await candidate.plugin.setup(context);
      } catch (error) {
        throw (
          registrar.refusal() ??
          (error instanceof PluginRefusal
            ? error
            : new PluginRefusal(name, "plugin_setup_failed"))
        );
      } finally {
        registrar.close();
      }
      const refusal = registrar.refusal();
      if (refusal) throw refusal;
      pluginTools.push([name, tools]);
    }
    const page = toolPageRefusal(pluginTools);
    if (page) refuse(page.plugin, page.code);
    // Design 5.7: a configured cache store or database provider must exist once every plugin ran.
    const [missing] = unknownProviders(config, providerTables(staging));
    if (missing) refuse(CORE_PLUGIN_NAME, "plugin_provider_unknown", missing);
    // Design 5.10.4: operator levels and TTLs can only tighten a source's declaration.
    try {
      passThrough = operatorPassThrough(
        passThroughSourcesOf(staging.sources),
        operatorSourcePolicies(config),
      );
    } catch (error) {
      if (!(error instanceof PassThroughPolicyRefusal)) throw error;
      const owner = staging.sources.find(
        (entry) => entry.spec.id === error.sourceId,
      );
      refuse(owner?.plugin ?? CORE_PLUGIN_NAME, error.code, error.sourceId);
    }
  } catch (error) {
    if (!(error instanceof PluginRefusal)) throw error;
    await teardown();
    writeLog(
      JSON.stringify({
        plugin: error.plugin,
        code: error.code,
        ...(error.reason ? { reason: error.reason } : {}),
      }),
    );
    exit(1);
    throw error;
  }
  const registries = freezeRegistries(staging);
  activateRegistries(registries);
  const plugins = Object.freeze(
    started.map(({ manifest }) =>
      Object.freeze({
        name: manifest.name,
        version: manifest.version,
        sha256: hashes.get(manifest.name) ?? null,
      }),
    ),
  );
  status.current = {
    plugins: Object.freeze(
      started.map(({ manifest }): HostPluginEntry =>
        Object.freeze({
          name: manifest.name,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          sha256: hashes.get(manifest.name) ?? null,
          enabled: true,
        }),
      ),
    ),
    registries,
  };
  return Object.freeze({
    registries,
    plugins,
    teardown,
    passThrough: passThrough!,
    migrations: Object.freeze(migrations),
  });
}

/** Checks 1-5 of design 5.3 for every enabled plugin, in configuration order. */
async function checkPlugins(
  config: CoreConfig,
  options: LoadPluginsOptions,
  env: Environment,
): Promise<Candidate[]> {
  const base = options.baseDirectory ?? process.cwd();
  const now = (options.now ?? Date.now)();
  const names = new Set<string>();
  const prefixes = new Set<string>();
  let publishers: Map<string, PublisherPolicy> | undefined | null = null;
  const candidates: Candidate[] = [];
  for (const entry of config.plugins) {
    if (!entry.enabled) continue;
    const imported = await importPlugin(entry.package, base);
    const { manifest } = imported;
    const name = manifest.name;
    if (names.has(name)) refuse(name, "plugin_name_duplicate");
    names.add(name);
    if (manifest.tablePrefix) {
      if (prefixes.has(manifest.tablePrefix))
        refuse(name, "plugin_table_prefix_duplicate");
      prefixes.add(manifest.tablePrefix);
    }
    for (const secret of manifest.capabilities?.secrets ?? [])
      if (!env[secret] && !entry.optionalSecrets.includes(secret))
        refuse(name, "plugin_secret_missing");
    for (const host of manifest.capabilities?.network ?? []) {
      if (publishers === null)
        publishers = await readPublishers(
          options.manifestPaths ?? defaultManifestPaths(config),
        );
      const refusal = hostRefusal(host, publishers, now);
      if (refusal)
        refuse(name, "plugin_network_host_not_allowed", refusal.code);
    }
    candidates.push({
      ...imported,
      options: validOptions(name, manifest, entry.options),
    });
  }
  return candidates;
}

function validOptions(
  name: string,
  manifest: PluginManifest,
  value: unknown,
): unknown {
  if (!manifest.options)
    return value === undefined
      ? undefined
      : refuse(name, "plugin_options_invalid");
  const parsed = manifest.options.safeParse(value);
  return parsed.success
    ? Object.freeze(parsed.data)
    : refuse(name, "plugin_options_invalid");
}

/** Undeclared names are never readable, whatever the environment holds. */
function secretReader(
  manifest: PluginManifest,
  env: Environment,
): PluginContext["secrets"] {
  const declared = new Set(manifest.capabilities?.secrets ?? []);
  return Object.freeze({
    get: (name: string) => (declared.has(name) && env[name]) || undefined,
  });
}

function pluginLog(
  plugin: string,
  writeLog: (line: string) => void,
): PluginContext["log"] {
  return (entry) => {
    if (Object.keys(entry).some((key) => SECRET_KEY.test(key)))
      throw new Error("Plugin log keys may not name credentials");
    writeLog(JSON.stringify({ ...entry, plugin }));
  };
}

const unavailable = () =>
  Promise.reject(new Error("Not available while plugins load"));
const unavailableDatabase: PluginContext["db"] = Object.freeze({
  reader: Object.freeze({ query: unavailable, exec: unavailable }),
});
const unavailableFetch: AdmittedFetch = unavailable;
