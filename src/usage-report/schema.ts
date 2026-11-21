import { z } from "zod";
import { FIRST_PARTY_PLUGINS } from "./first-party.js";

/**
 * The usage report, version 1: an opt-in daily summary an install can send. Every object is
 * strict, so an unknown key fails validation, and every string is an enum, a pattern or a
 * format. There is no free-text field. The JSON Schema copy is docs/usage-report.schema.json;
 * a test keeps it equal to `usageReportJsonSchema()`.
 */
export const USAGE_REPORT_SCHEMA = "openplans.usage-report.v1";

export const UPTIME_BUCKETS = [
  "<1h",
  "1h-1d",
  "1d-7d",
  "7d-30d",
  "30d+",
] as const;
export const STATES_BUCKETS = ["0", "1", "2-5", "6-20", "21+"] as const;
export const REQUESTS_BUCKETS = [
  "0",
  "1-100",
  "101-1k",
  "1k-10k",
  "10k+",
] as const;
export const CACHE_BACKENDS = ["off", "memory", "valkey", "other"] as const;
export const ARCHES = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
  "other",
] as const;
export const MIGRATION_OUTCOMES = ["ok", "failed", "unknown"] as const;

/** Release versions only: `major.minor.patch`, digits. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const version = z.string().regex(VERSION_PATTERN);
const year = z.number().int().min(2014).max(2100);

export const usageReportSchema = z.strictObject({
  schema: z.literal(USAGE_REPORT_SCHEMA),
  /** Random UUID v4 made when the report is switched on; null while it is off. */
  install_id: z.uuidv4().nullable(),
  sent_day: z.iso.date(),
  version,
  previous_version: version.nullable(),
  arch: z.enum(ARCHES),
  node_major: z.number().int().min(0).max(999),
  uptime_bucket: z.enum(UPTIME_BUCKETS),
  data: z.strictObject({
    years: z.array(year).max(10).nullable(),
    states_bucket: z.enum(STATES_BUCKETS).nullable(),
    coverage: z
      .strictObject({
        catalog: z.boolean(),
        premiums: z.boolean(),
        providers: z.boolean(),
        formulary: z.boolean(),
      })
      .nullable(),
  }),
  features: z.strictObject({
    mcp: z.boolean(),
    public_quoting: z.boolean(),
    public_household: z.boolean(),
    compat: z.boolean(),
    cache_backend: z.enum(CACHE_BACKENDS),
    scheduler_seen: z.boolean(),
    metrics: z.boolean(),
    cms_fallback: z.boolean(),
    medicare_part_d: z.boolean(),
    first_party_plugins: z
      .array(z.enum(FIRST_PARTY_PLUGINS))
      .max(FIRST_PARTY_PLUGINS.length),
    other_plugins_count: z.number().int().min(0).max(999),
  }),
  last_migration: z
    .strictObject({
      from: version,
      to: version,
      outcome: z.enum(MIGRATION_OUTCOMES),
    })
    .nullable(),
  /** Only when the operator already runs metrics (`OPENPLANS_METRICS`); otherwise null. */
  requests_bucket: z
    .strictObject({
      rest: z.enum(REQUESTS_BUCKETS),
      mcp: z.enum(REQUESTS_BUCKETS),
    })
    .nullable(),
});

export type UsageReport = z.infer<typeof usageReportSchema>;

/** The JSON Schema committed at docs/usage-report.schema.json. */
export function usageReportJsonSchema(): Record<string, unknown> {
  return {
    title: USAGE_REPORT_SCHEMA,
    ...z.toJSONSchema(usageReportSchema, { target: "draft-2020-12" }),
  };
}
