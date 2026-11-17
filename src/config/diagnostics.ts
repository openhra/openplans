import type { OperatorSetting, SettingOrigin } from "@openplans/plugin-sdk";
import type { CoreConfig } from "./index.js";

const origins = new WeakMap<
  CoreConfig,
  Readonly<Record<string, SettingOrigin>>
>();

/** Resolution records only origins, never the environment or input document. */
export function recordConfigOrigins(
  config: CoreConfig,
  sources: Record<string, SettingOrigin>,
): CoreConfig {
  origins.set(config, Object.freeze({ ...sources }));
  return config;
}

const enumValue = (value: string, allowed: readonly string[]) =>
  allowed.includes(value) ? value : null;
const presence = (value: unknown) =>
  value === undefined ? "unset" : "configured";

/** Explicit projections prevent new config fields or plugin options from appearing in diagnostics. */
export function configurationSettings(
  config: CoreConfig,
  process: OperatorSetting["process"],
): readonly OperatorSetting[] {
  const safe: Record<string, string | number | boolean | null> = {
    "listen.port": config.listen.port,
    "db.provider": enumValue(config.db.provider, ["pg", "pglite"]),
    "cache.enabled": config.cache.enabled,
    "cache.provider": enumValue(config.cache.provider, ["memory", "valkey"]),
    "cache.maxMb": config.cache.maxMb,
    "public.quoting": config.public.quoting,
    "public.household": config.public.household,
    "public.compat": config.public.compat,
    "mcp.enabled": config.mcp.enabled,
    "telemetry.enabled": config.telemetry.enabled,
    "cmsFallback.enabled": config.cmsFallback.enabled,
    "cmsFallback.quotes": config.cmsFallback.quotes,
    "access.shipped": config.access.shipped,
    "admin.ingressReviewed": config.admin.ingressReviewed,
    "admin.instances": config.admin.instances,
    "db.connectionString": presence(config.db.connectionString),
    "cache.url": presence(config.cache.url),
    "cmsFallback.apiKey": presence(config.cmsFallback.apiKey),
    ...Object.fromEntries(
      (["api", "compatKey", "mcp", "mcpCursorSecret", "operator"] as const).map(
        (key) => [`tokens.${key}`, presence(config.tokens[key])],
      ),
    ),
  };
  const sources = origins.get(config);
  return Object.freeze(
    Object.entries(safe).map(([key, displayValue]) =>
      Object.freeze({
        key,
        displayValue,
        source: sources?.[key] ?? "unknown",
        appliedAt: "startup" as const,
        process,
        writable: false as const,
        reason: settingReason(displayValue),
      }),
    ),
  );
}

function settingReason(
  value: OperatorSetting["displayValue"],
): OperatorSetting["reason"] {
  if (value === null) return "unsupported_value";
  if (value === "configured" || value === "unset")
    return "secret_presence_only";
  return "deployment_managed";
}
