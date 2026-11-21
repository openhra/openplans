import { z } from "zod";
import type {
  Database,
  OperatorCommandAudit,
  OperatorCommandEnvelope,
  OperatorCommandSpec,
  OperatorCommandScope,
  PluginManifest,
} from "@openplans/plugin-sdk";
import {
  emptyRegistries,
  emptySeen,
  stagingRegistrar,
} from "../../../src/plugins/registries.js";

// Synthetic instructions and bookkeeping; no health-plan facts.
export const SOURCE = "synthetic-source";
export const HASH = "a".repeat(64);
export const tables = [
  "plg_msot_command_state",
  "plg_msot_command_audit",
  "plg_msot_command_result",
];
export const manifest: PluginManifest = {
  name: "@openplans/plugin-msot",
  version: "0.2.0",
  apiVersion: "0.2",
  tablePrefix: "msot",
  kinds: ["operatorCommands"],
  capabilities: { writes: ["events"] },
  applicationState: tables.map((table) => ({
    table,
    reason: "Synthetic command fixture",
  })),
};
export const envelope = (
  changes: Partial<OperatorCommandEnvelope> = {},
): OperatorCommandEnvelope => ({
  command: "msot.synthetic",
  source_id: SOURCE,
  payload: { allowed: true },
  expected: { draft: null, version: null, activation: 0 },
  idempotency_key: "synthetic-request",
  preview_receipt: null,
  reason_code: "synthetic_test",
  ...changes,
});
export const authority = (actor: "worker" | "shared_operator" = "worker") => ({
  actor: { class: actor },
  grants: [{ source: SOURCE, permissions: ["edit", "publish"] as const }],
  signal: new AbortController().signal,
});
export async function setup(db: Database) {
  await db.exec(`CREATE TABLE plg_msot_command_state(source_id text PRIMARY KEY, value boolean NOT NULL);
    INSERT INTO plg_msot_command_state VALUES ('synthetic-source', false);
    CREATE TABLE plg_msot_command_audit(entry jsonb NOT NULL);
    CREATE TABLE plg_msot_command_result(source_id text, key text, input_hash text, output jsonb, PRIMARY KEY(source_id,key));`);
}
export function command(
  options: {
    fail?: string;
    publication?: boolean;
    run?: (scope: OperatorCommandScope) => Promise<void>;
    audits?: OperatorCommandAudit[];
  } = {},
): OperatorCommandSpec<{ allowed: boolean }, { allowed: boolean }> {
  return {
    name: "msot.synthetic",
    permission: options.publication ? "publish" : "edit",
    sources: [SOURCE],
    tables,
    timeoutMs: 5_000,
    publication: options.publication ?? false,
    inputSchema: z.strictObject({ allowed: z.boolean() }),
    outputSchema: z.strictObject({ allowed: z.boolean() }),
    store: {
      async lookup(request, scope) {
        const result = await scope.db.query<{
          input_hash: string;
          output: unknown;
        }>(
          "SELECT input_hash, output FROM plg_msot_command_result WHERE source_id=$1 AND key=$2",
          [request.source_id, request.idempotency_key],
        );
        return result.rows[0] ?? null;
      },
      async current() {
        return { expected: envelope().expected, hash: null };
      },
      async audit(entry, scope) {
        if (options.fail === "audit")
          throw new Error("synthetic private exception");
        options.audits?.push(entry);
        await scope.db.query(
          "INSERT INTO plg_msot_command_audit(entry) VALUES ($1::jsonb)",
          [JSON.stringify(entry)],
        );
      },
      async remember(request, result, scope) {
        if (options.fail === "remember")
          throw new Error("synthetic private exception");
        await scope.db.query(
          "INSERT INTO plg_msot_command_result(source_id,key,input_hash,output) VALUES ($1,$2,$3,$4::jsonb)",
          [
            request.source_id,
            request.idempotency_key,
            result.input_hash,
            JSON.stringify(result.output),
          ],
        );
      },
    },
    async run(input, _request, scope) {
      await scope.db.query(
        "UPDATE plg_msot_command_state SET value=$1 WHERE source_id=$2",
        [input.allowed, scope.source],
      );
      if (options.fail === "run")
        throw new Error("synthetic private exception");
      await options.run?.(scope);
      return {
        output: { allowed: input.allowed },
        after_hash: HASH,
        ...(options.publication
          ? {
              event: {
                type: "msot.changed" as const,
                idempotencyKey: "ignored-owner-key",
                payload: {
                  sourceId: scope.source,
                  version: 1,
                  previousHash: null,
                  newHash: HASH,
                  operation: "publish" as const,
                  changedCount: 1,
                  reasonCode: "synthetic_test",
                },
              },
            }
          : {}),
      };
    },
  };
}
export function register(
  spec = command(),
  host: "api" | "worker" | "stdio" = "api",
) {
  const registries = emptyRegistries();
  const registrar = stagingRegistrar(registries, manifest, host, emptySeen());
  registrar.context.operatorCommands!.add(spec);
  registrar.close();
  return registries;
}
export async function unchanged(db: Database) {
  const state = (await db.query("SELECT value FROM plg_msot_command_state"))
    .rows;
  const audit = (await db.query("SELECT * FROM plg_msot_command_audit")).rows;
  const results = (await db.query("SELECT * FROM plg_msot_command_result"))
    .rows;
  const outbox = (
    await db.query(
      "SELECT * FROM plugin_event_outbox WHERE event_type='msot.changed'",
    )
  ).rows;
  return { state, audit, results, outbox };
}
