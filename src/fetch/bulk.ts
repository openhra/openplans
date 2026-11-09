import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AdmissionSession } from "./admission.js";
import type { AdmissionReceipt } from "./admission.js";
import { fetchToCache } from "./cache.js";
import type { FetchOptions } from "./cache.js";
import type { FetchEvidence } from "./errors.js";
import { FetchError } from "./errors.js";
import { inspectZip, streamZipMember } from "./zip.js";
import { CsvError, readRecords } from "../ingest/csv/index.js";
import {
  JsonStreamError,
  readJsonArray,
  readJsonValue,
} from "../ingest/json/index.js";

const absolute = z.string().refine(isAbsolute);
const targetSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    source: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
    expectedContent: z.enum(["json", "csv", "zip", "binary"]),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    jsonArray: z.boolean().optional(),
  })
  .strict();
export const bulkSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
    dataDir: absolute,
    admissionManifest: absolute,
    reportPath: absolute,
    allowHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
    targets: z.array(targetSchema).min(1).max(1000),
    maxTransferBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 ** 3),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 ** 3),
    maxRequests: z.number().int().positive().max(1000),
    wallSeconds: z.number().positive().max(86400),
  })
  .strict();
export type BulkSpec = z.infer<typeof bulkSpecSchema>;
interface Item {
  url: string;
  source: string;
  state: "verified" | "quarantined";
  validationError?: { code: string; rowNumber?: number };
  outcome: string;
  path: string;
  metadataPath: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  admission: AdmissionReceipt;
  records?: number;
  csvColumnMismatches?: number;
  zipMembers?: number;
  zipUncompressedBytes?: number;
}
export interface BulkReport {
  id: string;
  state: "running" | "completed" | "stopped";
  startedAt: string;
  updatedAt: string;
  items: Item[];
  error?: {
    code: string;
    target: string;
    status?: number;
    evidence?: FetchEvidence;
  };
}

class TimedAdmission extends AdmissionSession {
  constructor(
    spec: BulkSpec,
    private readonly deadline: number,
  ) {
    super(spec.admissionManifest, {
      maxRequests: spec.maxRequests,
      maxTransferBytes: spec.maxTransferBytes,
    });
  }
  checkTime(): void {
    if (Date.now() >= this.deadline) {
      this.stop();
      throw new FetchError("admission_denied", "Collection wall limit reached");
    }
  }
  override reserveRequest(url: URL): void {
    this.checkTime();
    super.reserveRequest(url);
  }
  override transferred(url: URL, bytes: number): void {
    this.checkTime();
    super.transferred(url, bytes);
  }
}
async function save(path: string, value: BulkReport): Promise<void> {
  value.updatedAt = new Date().toISOString();
  await writeFile(`${path}.part`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.part`, path);
}
export async function verifyBulkPayload(
  path: string,
  sha256: string,
  bytes: number,
  target: z.infer<typeof targetSchema>,
): Promise<{
  records?: number;
  csvColumnMismatches?: number;
  zipMembers?: number;
  zipUncompressedBytes?: number;
}> {
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    length += chunk.length;
  }
  if (length !== bytes || hash.digest("hex") !== sha256)
    throw new Error("Cached payload hash or size differs");
  let records = 0;
  if (target.expectedContent === "csv") {
    let width: number | undefined;
    let csvColumnMismatches = 0;
    for await (const row of readRecords(createReadStream(path))) {
      if (width === undefined) {
        width = row.fields.length;
        if (!row.fields.some((field) => field.trim()))
          throw new CsvError("invalid_header", 1, "Empty CSV header");
      } else {
        records++;
        if (row.fields.length !== width) csvColumnMismatches++;
      }
    }
    if (width === undefined)
      throw new CsvError("invalid_header", 1, "Missing CSV header");
    return { records, csvColumnMismatches };
  }
  if (target.expectedContent === "json") {
    if (target.jsonArray) {
      for await (const record of readJsonArray(createReadStream(path))) {
        void record;
        records++;
      }
      return { records };
    }
    await readJsonValue(createReadStream(path));
  }
  if (target.expectedContent === "zip") {
    const limits = {
      maxCompressedBytes: bytes,
      maxUncompressedBytes: 40 * 1024 ** 3,
    };
    const archive = await inspectZip(path, limits);
    let zipUncompressedBytes = 0;
    for (const member of archive.members) {
      for await (const chunk of streamZipMember(path, member.name, limits)) {
        zipUncompressedBytes += chunk.length;
        if (zipUncompressedBytes > limits.maxUncompressedBytes)
          throw new FetchError(
            "zip_bomb",
            "Archive decoded-byte limit exceeded",
          );
      }
    }
    return { zipMembers: archive.members.length, zipUncompressedBytes };
  }
  return {};
}

async function classifyPayload(
  path: string,
  sha256: string,
  bytes: number,
  target: z.infer<typeof targetSchema>,
): Promise<
  Pick<
    Item,
    | "state"
    | "validationError"
    | "records"
    | "csvColumnMismatches"
    | "zipMembers"
    | "zipUncompressedBytes"
  >
> {
  try {
    return {
      state: "verified" as const,
      ...(await verifyBulkPayload(path, sha256, bytes, target)),
    };
  } catch (error) {
    if (
      !(error instanceof CsvError) &&
      !(error instanceof JsonStreamError) &&
      !(
        target.expectedContent === "zip" &&
        error instanceof FetchError &&
        error.code === "invalid_zip"
      )
    )
      throw error;
    return {
      state: "quarantined" as const,
      validationError: {
        code: error.code,
        ...(error instanceof CsvError ? { rowNumber: error.rowNumber } : {}),
      },
    };
  }
}

/** Sequential collection; an acquisition failure stops the job, source syntax failures quarantine the artifact. */
export async function runBulk(input: unknown): Promise<BulkReport> {
  const spec = bulkSpecSchema.parse(input);
  const startedAt = new Date().toISOString();
  const report: BulkReport = {
    id: spec.id,
    state: "running",
    startedAt,
    updatedAt: startedAt,
    items: [],
  };
  const admission = new TimedAdmission(
    spec,
    Date.now() + spec.wallSeconds * 1000,
  );
  await save(spec.reportPath, report);
  for (const target of spec.targets) {
    try {
      admission.checkTime();
      const options: FetchOptions = {
        ...target,
        dataDir: spec.dataDir,
        admission,
        allowHosts: spec.allowHosts,
        maxBytes: spec.maxFileBytes,
        maxDecompressedBytes: spec.maxFileBytes,
        maxAttempts: 1,
        zipLimits: {
          maxCompressedBytes: spec.maxFileBytes,
          maxUncompressedBytes: 40 * 1024 ** 3,
        },
      };
      const result = await fetchToCache(target.url, options);
      if (result.outcome === "not_modified" || !result.admission)
        throw new Error("Collection requires a snapshot and admission receipt");
      const verification = await classifyPayload(
        result.path,
        result.metadata.sha256,
        result.metadata.bytes,
        target,
      );
      report.items.push({
        url: target.url,
        source: target.source,
        outcome: result.outcome,
        path: result.path,
        metadataPath: result.metadataPath,
        sha256: result.metadata.sha256,
        bytes: result.metadata.bytes,
        fetchedAt: result.metadata.fetched_at,
        admission: result.admission,
        ...verification,
      });
      await save(spec.reportPath, report);
      console.log(
        JSON.stringify({
          url: target.url,
          outcome: result.outcome,
          bytes: result.metadata.bytes,
          sha256: result.metadata.sha256,
          ...verification,
        }),
      );
    } catch (error) {
      admission.stop();
      report.state = "stopped";
      report.error = {
        code: error instanceof FetchError ? error.code : "verification_failed",
        target: target.url,
        ...(error instanceof FetchError && error.status
          ? { status: error.status }
          : {}),
        ...(error instanceof FetchError && error.evidence
          ? { evidence: error.evidence }
          : {}),
      };
      await save(spec.reportPath, report);
      return report;
    }
  }
  report.state = "completed";
  await save(spec.reportPath, report);
  return report;
}

export async function verifyBulkReport(
  input: unknown,
  fullPayload = true,
): Promise<void> {
  const spec = bulkSpecSchema.parse(input);
  const report = JSON.parse(
    await readFile(spec.reportPath, "utf8"),
  ) as BulkReport;
  if (
    report.id !== spec.id ||
    report.state !== "completed" ||
    report.items.length !== spec.targets.length
  )
    throw new Error("Collection is incomplete");
  const manifestHash = createHash("sha256")
    .update(await readFile(spec.admissionManifest))
    .digest("hex");
  for (const [index, target] of spec.targets.entries()) {
    const item = report.items[index]!;
    if (
      item.url !== target.url ||
      item.source !== target.source ||
      !["verified", "quarantined"].includes(item.state) ||
      item.admission.manifestSha256 !== manifestHash ||
      !item.admission.hosts.length
    )
      throw new Error("Collection provenance differs");
    const metadata = JSON.parse(await readFile(item.metadataPath, "utf8"));
    if (
      metadata.sha256 !== item.sha256 ||
      metadata.bytes !== item.bytes ||
      metadata.source !== item.source ||
      metadata.fetched_at !== item.fetchedAt
    )
      throw new Error("Snapshot metadata differs");
    if ((await stat(item.path)).size !== item.bytes)
      throw new Error("Payload size differs");
    if (!fullPayload) continue;
    const verification = await classifyPayload(
      item.path,
      item.sha256,
      item.bytes,
      target,
    );
    if (
      verification.state !== item.state ||
      JSON.stringify(verification.validationError) !==
        JSON.stringify(item.validationError) ||
      verification.records !== item.records ||
      verification.csvColumnMismatches !== item.csvColumnMismatches ||
      verification.zipMembers !== item.zipMembers ||
      verification.zipUncompressedBytes !== item.zipUncompressedBytes
    )
      throw new Error("Payload verification evidence differs");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const spec: unknown = JSON.parse(await readFile(process.argv[3]!, "utf8"));
    if (process.argv[2] === "verify") await verifyBulkReport(spec);
    else if (process.argv[2] === "probe") await verifyBulkReport(spec, false);
    else if (process.argv[2] === "run") {
      const report = await runBulk(spec);
      if (report.state !== "completed") process.exitCode = 1;
    } else throw new Error("Use run, probe or verify with a spec path");
  } catch (error) {
    console.error(error instanceof FetchError ? error.code : "bulk_failed");
    process.exitCode = 1;
  }
}
