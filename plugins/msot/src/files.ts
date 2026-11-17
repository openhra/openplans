import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { readRecords } from "@openplans/plugin-sdk";
import type { CanonicalReader } from "@openplans/plugin-sdk";
import { z } from "zod";
import { compileSource } from "./resolver.js";
import { sourceSchema } from "./schema.js";
import type { Source } from "./schema.js";

export const actorSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/);
export const reasonSchema = actorSchema;
export interface Artifact {
  sha256: string;
  text: string;
  format: "json" | "csv";
}
export interface Candidate {
  source: Source;
  hash: string;
  artifacts: Artifact[];
  rowRefs: Record<string, { input_hash: string; row_ref: string }>;
}
export const inputHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const MAX_FILE_BYTES = 8 * 1024 * 1024;
export async function readInput(path: string) {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("MSOT_INVALID_FILE");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) throw new Error("MSOT_FILE_TOO_LARGE");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
  } finally {
    await handle.close();
  }
}
const columns = [
  "id",
  "issuer_id",
  "state",
  "market_segment",
  "field",
  "value_state",
  "value",
  "valid_from",
  "valid_until",
  "reason_code",
];
export async function parseFiles(
  json: string,
  actor: string,
  at: string,
  reader: CanonicalReader,
  csv?: string,
): Promise<Candidate> {
  actorSchema.parse(actor);
  z.iso.datetime({ offset: true }).parse(at);
  if (
    Buffer.byteLength(json) > MAX_FILE_BYTES ||
    (csv !== undefined && Buffer.byteLength(csv) > MAX_FILE_BYTES)
  )
    throw new Error("MSOT_FILE_TOO_LARGE");
  const source = sourceSchema.parse(JSON.parse(json));
  const artifacts: Artifact[] = [
    { format: "json", sha256: inputHash(json), text: json },
  ];
  const rowRefs: Candidate["rowRefs"] = {};
  source.fields.forEach((f, i) => {
    rowRefs[`definition:${f.name}`] = {
      input_hash: artifacts[0]!.sha256,
      row_ref: `/fields/${i}`,
    };
  });
  source.rules.forEach((r, i) => {
    rowRefs[`rule:${r.id}`] = {
      input_hash: artifacts[0]!.sha256,
      row_ref: `/rules/${i}`,
    };
  });
  if (csv !== undefined) {
    const artifact: Artifact = {
      format: "csv",
      sha256: inputHash(csv),
      text: csv,
    };
    artifacts.push(artifact);
    async function* chunks() {
      yield csv!;
    }
    let header: string[] | undefined;
    for await (const record of readRecords(chunks(), {
      maxRecordLength: 65536,
    })) {
      if (!header) {
        if (
          record.fields.length !== columns.length ||
          new Set(record.fields).size !== columns.length ||
          columns.some((c) => !record.fields.includes(c))
        )
          throw new Error("MSOT_CSV_COLUMNS");
        header = record.fields;
        continue;
      }
      if (record.fields.length !== header.length)
        throw new Error("MSOT_CSV_COLUMNS");
      const cells = Object.fromEntries(
        header.map((key, i) => [key, record.fields[i]!]),
      );
      const state = cells.value_state;
      if (!(
        (state === "known" && ["true", "false"].includes(cells.value!)) ||
        (state === "unknown" && cells.value === "")
      ))
        throw new Error("MSOT_CSV_BOOLEAN_REQUIRED");
      const rule = {
        id: cells.id,
        field: cells.field,
        scope: Object.fromEntries(
          ["issuer_id", "state", "market_segment"]
            .filter((k) => cells[k] !== "")
            .map((k) => [k, cells[k]]),
        ),
        value:
          state === "unknown"
            ? { state, value: null }
            : { state, value: cells.value === "true" },
        valid_from: cells.valid_from,
        valid_until: cells.valid_until || null,
        reason_code: cells.reason_code,
        set_by: actor,
        set_at: at,
      };
      source.rules.push(rule as Source["rules"][number]);
      rowRefs[`rule:${cells.id}`] = {
        input_hash: artifact.sha256,
        row_ref: `line:${record.rowNumber}`,
      };
      if (source.rules.length > 10000) throw new Error("MSOT_RULE_LIMIT");
    }
    if (!header) throw new Error("MSOT_CSV_COLUMNS");
  }
  // Shell accounts assert an actor; uploaded cells cannot establish another person's identity.
  if ([...source.fields, ...source.rules].some((r) => r.set_by !== actor))
    throw new Error("MSOT_ACTOR_MISMATCH");
  const compiled = compileSource(source, reader);
  return { source: compiled.source, hash: compiled.hash, artifacts, rowRefs };
}
