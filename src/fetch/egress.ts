import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { FetchError } from "./errors.js";
import { egressCountry } from "../config/access.js";

/** Clock difference tolerated between the wrapper that measured the egress and this process. */
const clockSkewMs = 2000;
/** A window longer than a day would outlive the daily robots and terms recheck. */
const maxWindowMs = 24 * 60 * 60 * 1000;

const countryCode = z.string().regex(/^[A-Z]{2}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime();

/**
 * Egress record schema 1, written once per collection window before the job starts. The record
 * names the country the exit address was placed in by an offline database, and the check that
 * placed it. Unknown fields are ignored so the writer can add evidence without a schema bump.
 */
const egressRecordSchema = z.object({
  schema: z.literal(1),
  windowId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  kind: z.enum(["vpn", "project-host", "local"]),
  provider: z.string().min(1),
  tunnelType: z.string().min(1).optional(),
  country: countryCode,
  exitIp: z.union([z.ipv4(), z.ipv6()]),
  server: z
    .object({
      id: z.string().min(1),
      country: z.string().min(1).optional(),
      city: z.string().min(1).optional(),
    })
    .optional(),
  check: z.object({
    method: z.string().min(1),
    geoDb: z
      .object({ name: z.string().min(1), release: z.string().min(1), sha256 })
      .optional(),
  }),
  checks: z.object({
    before: z.object({
      at: instant,
      country: countryCode,
      hostIpDiffers: z.literal(true),
    }),
  }),
  startedAt: instant,
  maxEndAt: instant,
});
type EgressRecord = z.infer<typeof egressRecordSchema>;

/** What every admission receipt records about the egress. The exit address is kept only as a hash. */
export interface EgressReceipt {
  recordSha256: string;
  windowId: string;
  kind: EgressRecord["kind"];
  provider: string;
  tunnelType: string | null;
  country: string;
  exitIpSha256: string;
  server: { id: string; country: string | null; city: string | null } | null;
  check: {
    method: string;
    at: string;
    geoDb: { name: string; release: string; sha256: string } | null;
  };
  startedAt: string;
  maxEndAt: string;
}

export interface EgressBinding {
  file: string;
  country: string;
  receipt: EgressReceipt;
}

export interface EgressInput {
  file: string;
  /** SHA-256 of the record bytes, handed over by the wrapper alongside the path. */
  expectedSha256: string | undefined;
  /** Countries declared elsewhere (spec, environment); each must equal the record's. */
  declaredCountries: readonly (string | undefined)[];
  now?: number;
}

function refuse(message: string): never {
  throw new FetchError("admission_denied", message);
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The wrapper writes `<windowId>.result.json` next to the record once the window has ended. */
function windowClosed(file: string): boolean {
  return existsSync(file.replace(/\.json$/, ".result.json"));
}

function readRecordBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    return refuse("Egress record is set but cannot be read");
  }
}

function parseRecord(bytes: Buffer): EgressRecord {
  try {
    return egressRecordSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return refuse("Egress record does not match schema 1");
  }
}

function assertTimes(record: EgressRecord, now: number): void {
  const checkedAt = Date.parse(record.checks.before.at);
  const startedAt = Date.parse(record.startedAt);
  const maxEndAt = Date.parse(record.maxEndAt);
  if (checkedAt > startedAt + clockSkewMs || startedAt > now + clockSkewMs)
    refuse("Egress was not checked before the collection started");
  if (maxEndAt <= startedAt || maxEndAt - startedAt > maxWindowMs)
    refuse("Egress window bounds are invalid");
  if (now >= maxEndAt) refuse("Egress record is stale: its window has ended");
}

function receiptFor(record: EgressRecord, recordSha256: string): EgressReceipt {
  return {
    recordSha256,
    windowId: record.windowId,
    kind: record.kind,
    provider: record.provider,
    tunnelType: record.tunnelType ?? null,
    country: record.country,
    // Salted with the window so equal exits in different windows are not linkable by hash alone.
    exitIpSha256: digest(`${record.windowId}\n${record.exitIp}`),
    server: record.server
      ? {
          id: record.server.id,
          country: record.server.country ?? null,
          city: record.server.city ?? null,
        }
      : null,
    check: {
      method: record.check.method,
      at: record.checks.before.at,
      geoDb: record.check.geoDb ?? null,
    },
    startedAt: record.startedAt,
    maxEndAt: record.maxEndAt,
  };
}

/** Reads and validates the record once, before any request. Every failure refuses the collection. */
export function loadEgressBinding(input: EgressInput): EgressBinding {
  const now = input.now ?? Date.now();
  if (!isAbsolute(input.file)) refuse("Egress record path must be absolute");
  if (!input.expectedSha256 || !sha256.safeParse(input.expectedSha256).success)
    refuse("Egress record needs its SHA-256 alongside the path");
  const bytes = readRecordBytes(input.file);
  const recordSha256 = digest(bytes);
  if (recordSha256 !== input.expectedSha256)
    refuse("Egress record bytes differ from the handed-over SHA-256");
  const record = parseRecord(bytes);
  if (record.checks.before.country !== record.country)
    refuse("Egress check placed the exit in another country");
  for (const declared of input.declaredCountries)
    if (declared !== undefined && declared !== record.country)
      refuse("Declared egress country differs from the egress record");
  assertTimes(record, now);
  if (windowClosed(input.file))
    refuse("Egress record is stale: its window has ended");
  return {
    file: input.file,
    country: record.country,
    receipt: receiptFor(record, recordSha256),
  };
}

/** Re-checked before each admission: the record must be unchanged and its window still open. */
export function assertEgressCurrent(
  binding: EgressBinding,
  now = Date.now(),
): void {
  if (digest(readRecordBytes(binding.file)) !== binding.receipt.recordSha256)
    refuse("Egress record changed during collection");
  if (now >= Date.parse(binding.receipt.maxEndAt) || windowClosed(binding.file))
    refuse("Egress record is stale: its window has ended");
}

/**
 * `OPENPLANS_EGRESS_FILE` names the record and `OPENPLANS_EGRESS_SHA256` its hash. When the file is
 * set it wins over the declared egress country (`OPENPLANS_EGRESS_COUNTRY`, else
 * `access.egressCountry` in the config file), which must then name the same country.
 */
export function egressFromEnvironment(
  declaredCountry: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EgressBinding | undefined {
  const file = env.OPENPLANS_EGRESS_FILE || undefined;
  if (!file) return undefined;
  return loadEgressBinding({
    file,
    expectedSha256: env.OPENPLANS_EGRESS_SHA256 || undefined,
    declaredCountries: [declaredCountry, egressCountry(env)],
  });
}
