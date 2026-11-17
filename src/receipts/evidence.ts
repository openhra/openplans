import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const snapshotSchema = z.strictObject({
  snapshot_id: z.string().min(1),
  source_id: z.string().min(1),
  sha256: hash,
  members: z
    .array(
      z.strictObject({
        kind: z.string().min(1),
        snapshot_id: z.string().min(1),
        sha256: hash,
      }),
    )
    .min(1)
    .optional(),
});
export const dependencySchema = z.strictObject({
  generation: z.string().min(1),
  snapshots: z.array(snapshotSchema),
  rule_hash: hash,
  engine: z.strictObject({ version: z.string().min(1), sha256: hash }),
});
const payloadSchema = z.strictObject({
  schema_version: z.literal("answer-receipt-v1"),
  receipt_id: z.string().uuid(),
  status: z.literal("export_ready"),
  input_digest: hash,
  answer_digest: hash,
  answer_json: z.string(),
  provenance: dependencySchema,
  replay: z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("dependencies_not_verified"),
  }),
  retention: z.literal("caller_download_only"),
  input_bundle: z.unknown().optional(),
});
export const receiptSchema = payloadSchema.extend({ receipt_digest: hash });
export type Receipt = z.infer<typeof receiptSchema>;
export type Dependencies = z.infer<typeof dependencySchema>;
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** JSON object keys have code-unit order; array order and answer bytes remain significant. */
export function canonicalJson(value: unknown): string {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => Number(a > b) - Number(a < b))
          .map(([key, value]) => [key, order(value)]),
      );
    return value;
  };
  return JSON.stringify(order(parsed));
}

export function serializeEvidence(
  input: unknown,
  answer: unknown,
  dependencies: Dependencies,
  includeInput = false,
): Receipt {
  const answer_json = JSON.stringify(answer);
  const payload = payloadSchema.parse({
    schema_version: "answer-receipt-v1",
    receipt_id: randomUUID(),
    status: "export_ready",
    input_digest: sha256(canonicalJson(input)),
    answer_digest: sha256(answer_json),
    answer_json,
    provenance: dependencies,
    replay: { status: "unavailable", reason: "dependencies_not_verified" },
    retention: "caller_download_only",
    ...(includeInput ? { input_bundle: input } : {}),
  });
  return { ...payload, receipt_digest: sha256(canonicalJson(payload)) };
}

export type Verification = {
  status: "verified" | "failed" | "unavailable";
  reason: string;
};
export interface VerificationOptions {
  input?: unknown;
  dependencies?: Dependencies;
  /** Hash the operator-restored public file bytes, rather than trusting the receipt's hash. */
  snapshotHash?: (snapshotId: string) => Promise<string | undefined>;
  replay?: (input: unknown) => Promise<unknown>;
}

export async function verifyReceipt(
  value: unknown,
  options: VerificationOptions = {},
): Promise<Verification> {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) return { status: "failed", reason: "invalid_receipt" };
  const { receipt_digest, ...payload } = parsed.data;
  if (sha256(canonicalJson(payload)) !== receipt_digest)
    return { status: "failed", reason: "receipt_digest_mismatch" };
  if (sha256(payload.answer_json) !== payload.answer_digest)
    return { status: "failed", reason: "answer_digest_mismatch" };
  try {
    JSON.parse(payload.answer_json);
  } catch {
    return { status: "failed", reason: "invalid_answer_json" };
  }
  const input =
    options.input !== undefined ? options.input : payload.input_bundle;
  if (input === undefined)
    return { status: "unavailable", reason: "inputs_required" };
  if (sha256(canonicalJson(input)) !== payload.input_digest)
    return { status: "failed", reason: "input_digest_mismatch" };
  if (!options.dependencies)
    return { status: "unavailable", reason: "engine_and_rules_required" };
  const current = dependencySchema.safeParse(options.dependencies);
  if (!current.success)
    return { status: "unavailable", reason: "invalid_dependencies" };
  if (current.data.rule_hash !== payload.provenance.rule_hash)
    return { status: "failed", reason: "rule_hash_mismatch" };
  if (
    canonicalJson(current.data.engine) !==
    canonicalJson(payload.provenance.engine)
  )
    return { status: "unavailable", reason: "engine_version_unavailable" };
  if (!options.snapshotHash)
    return { status: "unavailable", reason: "snapshot_files_required" };
  try {
    for (const snapshot of payload.provenance.snapshots) {
      if (snapshot.members) {
        if (
          snapshot.members.some(
            (member) =>
              !payload.provenance.snapshots.some(
                (child) =>
                  child.snapshot_id === member.snapshot_id &&
                  child.sha256 === member.sha256 &&
                  !child.members,
              ),
          )
        )
          return {
            status: "failed",
            reason: "snapshot_manifest_member_missing",
          };
        if (
          sha256(
            JSON.stringify(
              snapshot.members.map((member) => [member.kind, member.sha256]),
            ),
          ) !== snapshot.sha256
        )
          return {
            status: "failed",
            reason: "snapshot_manifest_hash_mismatch",
          };
      } else {
        const actual = await options.snapshotHash(snapshot.snapshot_id);
        if (actual === undefined)
          return { status: "unavailable", reason: "snapshot_missing" };
        if (actual !== snapshot.sha256)
          return { status: "failed", reason: "snapshot_hash_mismatch" };
      }
    }
    if (
      canonicalJson(current.data.snapshots) !==
      canonicalJson(payload.provenance.snapshots)
    )
      return {
        status: "unavailable",
        reason: "restored_snapshot_manifest_mismatch",
      };
    if (current.data.generation !== payload.provenance.generation)
      return { status: "unavailable", reason: "restored_generation_mismatch" };
    if (!options.replay)
      return { status: "unavailable", reason: "replay_adapter_required" };
    const answer = await options.replay(input);
    return sha256(JSON.stringify(answer)) === payload.answer_digest
      ? { status: "verified", reason: "answer_reproduced" }
      : { status: "failed", reason: "replayed_answer_mismatch" };
  } catch {
    return { status: "unavailable", reason: "replay_dependencies_unavailable" };
  }
}
