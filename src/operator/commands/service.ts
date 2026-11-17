import { createHash } from "node:crypto";
import {
  operatorCommandEnvelopeSchema,
  operatorCommandLookupSchema,
  operatorExpectedVersionSchema,
} from "@openplans/plugin-sdk";
import type {
  OperatorActor,
  OperatorCommandClient,
  OperatorCommandEnvelope,
  OperatorCommandLookup,
  OperatorCommandScope,
  OperatorCommandSpec,
  OperatorPermission,
  SqlSession,
  Database,
} from "@openplans/plugin-sdk";
import type { Registered } from "../../plugins/registries.js";
import { boundedDatabase } from "../../db/bounded.js";
import { createEventBus } from "../../plugins/events.js";
import { hasCredentials } from "../../api/cache/index.js";
import { commandSession, OperatorCommandRefused, refuse } from "./scope.js";

export interface CommandAuthority {
  readonly actor: OperatorActor;
  readonly grants: readonly {
    source: string;
    permissions: readonly OperatorPermission[];
  }[];
  readonly signal: AbortSignal;
}
export interface CommandHostOptions {
  readonly db: SqlSession;
  readonly commands: readonly Registered<OperatorCommandSpec>[];
  /** Checked at entry and again before commit. A missing grant always means read-only. */
  readonly writable: () => boolean;
  readonly now?: () => number;
}
export function canonicalCommandJson(value: unknown): string {
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > 16) return refuse("operator_command_invalid_input");
    if (node === null || typeof node === "string" || typeof node === "boolean")
      return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (Array.isArray(node))
      return node.map((child) => visit(child, depth + 1));
    if (
      typeof node === "object" &&
      node &&
      Object.getPrototypeOf(node) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [
            key,
            visit((node as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    return refuse("operator_command_invalid_input");
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > 65_536)
    return refuse("operator_command_invalid_input");
  return text;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

async function withinDeadline<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        stop = () =>
          reject(new OperatorCommandRefused("operator_command_deadline"));
        signal.addEventListener("abort", stop, { once: true });
      }),
      Promise.resolve().then(run),
    ]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

/** Core callers establish authority; payloads and plugin options never supply it. */
export function createOperatorCommandClient(
  options: CommandHostOptions,
  authority: CommandAuthority,
): OperatorCommandClient {
  // Snapshot grants before asynchronous work; callers cannot mutate them during execution.
  const actor = Object.freeze({ class: authority.actor.class });
  const grants = authority.grants.map((grant) => ({
    source: grant.source,
    permissions: [...grant.permissions],
  }));
  const now = options.now ?? Date.now;
  return Object.freeze({
    async result(raw: OperatorCommandLookup): Promise<unknown | null> {
      try {
        const checked = operatorCommandLookupSchema.safeParse(
          JSON.parse(canonicalCommandJson(raw)),
        );
        if (!checked.success) return refuse("operator_command_invalid_input");
        const entry = options.commands.find(
          ({ spec }) => spec.name === checked.data.command,
        );
        if (!entry) return refuse("operator_command_unavailable");
        const { spec } = entry;
        if (
          !spec.sources.includes(checked.data.source_id) ||
          !grants.some(
            (grant) =>
              grant.source === checked.data.source_id &&
              grant.permissions.includes(spec.permission),
          )
        )
          return refuse("operator_command_forbidden");
        const signal = AbortSignal.any([
          authority.signal,
          AbortSignal.timeout(spec.timeoutMs),
        ]);
        const scoped = commandSession(
          boundedDatabase(options.db, signal, { readOnly: true }),
          [],
          signal,
        );
        try {
          const previous = await withinDeadline(signal, () =>
            spec.store.lookup(
              checked.data,
              Object.freeze({
                db: scoped.db,
                signal,
                actor,
                source: checked.data.source_id,
                permission: spec.permission,
              }),
            ),
          );
          scoped.check();
          signal.throwIfAborted();
          if (!previous) return null;
          const output = spec.outputSchema.safeParse(previous.output);
          if (
            !validHash(previous.input_hash) ||
            !output.success ||
            hasCredentials(output.data)
          )
            return refuse("operator_command_invalid_output");
          return JSON.parse(canonicalCommandJson(output.data)) as unknown;
        } finally {
          scoped.close();
        }
      } catch (error) {
        if (error instanceof OperatorCommandRefused) throw error;
        if (
          authority.signal.aborted ||
          (error instanceof Error &&
            ["AbortError", "TimeoutError"].includes(error.name))
        )
          return refuse("operator_command_deadline");
        return refuse("operator_command_failed");
      }
    },
    async execute(raw: OperatorCommandEnvelope): Promise<unknown> {
      try {
        if (!options.writable()) return refuse("operator_command_read_only");
        const checked = operatorCommandEnvelopeSchema.safeParse(
          JSON.parse(canonicalCommandJson(raw)),
        );
        if (!checked.success) return refuse("operator_command_invalid_input");
        const envelope = checked.data;
        const entry = options.commands.find(
          ({ spec }) => spec.name === envelope.command,
        );
        if (!entry) return refuse("operator_command_unavailable");
        const { spec, plugin } = entry;
        if (
          !spec.sources.includes(envelope.source_id) ||
          !grants.some(
            (grant) =>
              grant.source === envelope.source_id &&
              grant.permissions.includes(spec.permission),
          )
        )
          return refuse("operator_command_forbidden");
        const input = spec.inputSchema.safeParse(envelope.payload);
        if (
          !input.success ||
          canonicalCommandJson(input.data) !==
            canonicalCommandJson(envelope.payload)
        )
          return refuse("operator_command_invalid_input");
        const inputHash = hash(canonicalCommandJson(envelope));
        const signal = AbortSignal.any([
          authority.signal,
          AbortSignal.timeout(spec.timeoutMs),
        ]);
        signal.throwIfAborted();
        const run = async (tx: SqlSession) => {
          // Serialize the owner's source across commands and API/worker processes. No new table.
          const lock = createHash("sha256")
            .update(`${plugin}\0${envelope.source_id}`)
            .digest()
            .readBigInt64BE()
            .toString();
          await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [lock]);
          const scoped = commandSession(tx, spec.tables, signal);
          const scope: OperatorCommandScope = Object.freeze({
            db: scoped.db,
            signal,
            actor,
            source: envelope.source_id,
            permission: spec.permission,
          });
          const fence = () => {
            signal.throwIfAborted();
            scoped.check();
            if (!options.writable())
              return refuse("operator_command_read_only");
          };
          try {
            fence();
            const previous = await withinDeadline(signal, () =>
              spec.store.lookup(envelope, scope),
            );
            if (previous) {
              if (previous.input_hash !== inputHash)
                return refuse("operator_command_idempotency_conflict");
              const output = spec.outputSchema.safeParse(previous.output);
              if (!output.success || hasCredentials(output.data))
                return refuse("operator_command_invalid_output");
              const result = JSON.parse(
                canonicalCommandJson(output.data),
              ) as unknown;
              fence();
              return result;
            }
            const current = await withinDeadline(signal, () =>
              spec.store.current(envelope, scope),
            );
            const expected = operatorExpectedVersionSchema.safeParse(
              current.expected,
            );
            if (
              !expected.success ||
              canonicalCommandJson(expected.data) !==
                canonicalCommandJson(envelope.expected)
            )
              return refuse("operator_command_version_conflict");
            if (current.hash !== null && !validHash(current.hash))
              return refuse("operator_command_invalid_output");
            const change = await withinDeadline(signal, () =>
              spec.run(input.data, envelope, scope),
            );
            fence();
            const output = spec.outputSchema.safeParse(change.output);
            if (
              !output.success ||
              (change.after_hash !== null && !validHash(change.after_hash)) ||
              hasCredentials(output.data)
            )
              return refuse("operator_command_invalid_output");
            const result = JSON.parse(
              canonicalCommandJson(output.data),
            ) as unknown;
            await withinDeadline(signal, () =>
              spec.store.audit(
                {
                  action: spec.name,
                  outcome: "success",
                  actor,
                  at: new Date(now()).toISOString(),
                  source_id: envelope.source_id,
                  expected: envelope.expected,
                  input_hash: inputHash,
                  before_hash: current.hash,
                  after_hash: change.after_hash,
                  reason_code: envelope.reason_code,
                  idempotency_key: envelope.idempotency_key,
                },
                scope,
              ),
            );
            fence();
            if (spec.publication !== Boolean(change.event))
              return refuse("operator_command_outbox_required");
            if (change.event) {
              if (
                (change.event.type !== "msot.changed" &&
                  change.event.type !== "msot.retired") ||
                change.event.payload.sourceId !== envelope.source_id ||
                change.event.payload.previousHash !== current.hash ||
                change.event.payload.newHash !== change.after_hash ||
                change.event.payload.reasonCode !== envelope.reason_code
              )
                return refuse("operator_command_invalid_output");
              const events = createEventBus({
                db: options.db as Database,
              }).registry({
                kind: "plugin",
                manifest: {
                  name: plugin,
                  capabilities: { writes: ["events"] },
                },
              });
              await events.emit(
                {
                  ...change.event,
                  idempotencyKey: `operator:${hash(`${plugin}\0${spec.name}\0${envelope.source_id}\0${envelope.idempotency_key}`)}`,
                },
                { session: tx, requireOutbox: true },
              );
            }
            await withinDeadline(signal, () =>
              spec.store.remember(
                envelope,
                { input_hash: inputHash, output: result },
                scope,
              ),
            );
            fence();
            return result;
          } finally {
            scoped.close();
          }
        };
        // Only a core transaction-capable root can run commands. A pass-through or request
        // reader handle cannot be substituted, and no writer is returned to the caller.
        if (options.db.withRequest)
          return await options.db.withRequest(signal, run, { readOnly: false });
        const root = options.db as Partial<Database>;
        if (typeof root.transaction !== "function")
          return refuse("operator_command_transaction_required");
        return await root.transaction(run);
      } catch (error) {
        if (error instanceof OperatorCommandRefused) throw error;
        if (
          authority.signal.aborted ||
          (error instanceof Error &&
            ["AbortError", "TimeoutError"].includes(error.name))
        )
          return refuse("operator_command_deadline");
        return refuse("operator_command_failed");
      }
    },
  });
}
