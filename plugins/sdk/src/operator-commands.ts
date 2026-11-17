import { z } from "zod";
import type { SqlSession } from "./contracts.js";
import type { EventInput } from "./events.js";

export const operatorExpectedVersionSchema = z.strictObject({
  draft: z.string().min(1).max(128).nullable(),
  version: z.number().int().positive().nullable(),
  activation: z.number().int().nonnegative(),
});
export const operatorCommandEnvelopeSchema = z.strictObject({
  command: z.string().regex(/^[a-z][a-z0-9_.-]{2,95}$/),
  source_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/),
  payload: z.record(z.string(), z.json()),
  expected: operatorExpectedVersionSchema,
  idempotency_key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  preview_receipt: z.string().min(1).max(128).nullable(),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
});
export const operatorCommandLookupSchema = operatorCommandEnvelopeSchema.pick({
  command: true,
  source_id: true,
  idempotency_key: true,
});
export type OperatorCommandLookup = z.infer<typeof operatorCommandLookupSchema>;
export type OperatorCommandEnvelope = z.infer<
  typeof operatorCommandEnvelopeSchema
>;
export type OperatorExpectedVersion = z.infer<
  typeof operatorExpectedVersionSchema
>;
export type OperatorPermission = "edit" | "publish";
export interface OperatorActor {
  readonly class: "shared_operator" | "worker";
}
export interface OperatorCommandScope {
  readonly db: SqlSession;
  readonly signal: AbortSignal;
  readonly actor: OperatorActor;
  readonly source: string;
  readonly permission: OperatorPermission;
}
export interface OperatorCommandAudit {
  readonly action: string;
  readonly outcome: "success";
  readonly actor: OperatorActor;
  readonly at: string;
  readonly source_id: string;
  readonly expected: OperatorExpectedVersion;
  readonly input_hash: string;
  readonly before_hash: string | null;
  readonly after_hash: string | null;
  readonly reason_code: string;
  readonly idempotency_key: string;
}
export interface OperatorStoredResult {
  readonly input_hash: string;
  readonly output: unknown;
}
/**
 * Hooks use the owner's existing durable storage in the host transaction. Lookup/remember
 * bind (owner, source, idempotency key); store the complete input hash and validated result.
 * Current reads the authoritative draft/head. Audit appends to the owner's business journal.
 * Hooks must propagate failures. Core serializes each owner/source with a transaction lock.
 */
export interface OperatorCommandStore {
  lookup(
    envelope: OperatorCommandLookup,
    scope: OperatorCommandScope,
  ): Promise<OperatorStoredResult | null>;
  current(
    envelope: OperatorCommandEnvelope,
    scope: OperatorCommandScope,
  ): Promise<{ expected: OperatorExpectedVersion; hash: string | null }>;
  audit(
    entry: OperatorCommandAudit,
    scope: OperatorCommandScope,
  ): Promise<void>;
  remember(
    envelope: OperatorCommandEnvelope,
    result: OperatorStoredResult,
    scope: OperatorCommandScope,
  ): Promise<void>;
}
export interface OperatorCommandSpec<I = unknown, O = unknown> {
  readonly name: string;
  readonly permission: OperatorPermission;
  readonly sources: readonly string[];
  readonly tables: readonly string[];
  readonly timeoutMs: number;
  /** Publication must return an event for the transaction's durable outbox. */
  readonly publication: boolean;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly store: OperatorCommandStore;
  run(
    input: I,
    envelope: OperatorCommandEnvelope,
    scope: OperatorCommandScope,
  ): Promise<{ output: O; after_hash: string | null; event?: EventInput }>;
}
export interface OperatorCommandRegistry {
  add<I, O>(spec: OperatorCommandSpec<I, O>): void;
}
/** Bound by core to one authenticated request or trusted worker invocation. */
export interface OperatorCommandClient {
  /** Authorized lookup after a lost response; it has no business side effects. */
  result(input: OperatorCommandLookup): Promise<unknown | null>;
  execute(envelope: OperatorCommandEnvelope): Promise<unknown>;
}
