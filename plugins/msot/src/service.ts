import { randomUUID } from "node:crypto";
import type {
  CanonicalReader,
  Database,
  EventRegistry,
  McpToolContext,
  SqlSession,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import { compileSource } from "./resolver.js";
import { resolveInput } from "./schema.js";
import type { Resolution } from "./schema.js";
import { actorSchema, inputHash, reasonSchema } from "./files.js";
import type { Candidate } from "./files.js";
import { Repository } from "./repository.js";

const metadataSchema = z.strictObject({
  actor: actorSchema,
  reason: reasonSchema,
  idempotency_key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
});
export type Metadata = z.infer<typeof metadataSchema>;
export const expectationSchema = z.strictObject({
  version: z.number().int().positive().nullable(),
  activation: z.number().int().nonnegative(),
});
export type Expectation = z.infer<typeof expectationSchema>;
export type PreviewInput = z.infer<typeof resolveInput>;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
function verify(candidate: Candidate, reader: CanonicalReader) {
  const compiled = compileSource(candidate.source, reader);
  if (
    compiled.hash !== candidate.hash ||
    candidate.artifacts.some((a) => inputHash(a.text) !== a.sha256)
  )
    throw new Error("msot_input_changed");
  if (candidate.artifacts.length) {
    const refs = [
      ...candidate.source.fields.map((f) => `definition:${f.name}`),
      ...candidate.source.rules.map((r) => `rule:${r.id}`),
    ];
    if (
      Object.keys(candidate.rowRefs).length !== refs.length ||
      refs.some(
        (key) =>
          !candidate.rowRefs[key] ||
          !candidate.artifacts.some(
            (a) => a.sha256 === candidate.rowRefs[key]!.input_hash,
          ),
      )
    )
      throw new Error("msot_input_provenance_required");
  }
  return compiled;
}
function expectHead(
  head: { active_version: number | null; activation_sequence: number },
  expected: Expectation,
) {
  expectationSchema.parse(expected);
  if (
    head.active_version !== expected.version ||
    head.activation_sequence !== expected.activation
  )
    throw new Error("msot_expected_version_conflict");
}
function transitions(before: Resolution | null, after: Resolution) {
  const groups = new Map<
    string,
    {
      state: string | null;
      issuer_id: string | null;
      market_segment: string;
      field: string;
      true_to_false: number;
      unknown_to_known: number;
      changed: number;
      newly_withheld: number;
    }
  >();
  after.plans.forEach((plan, index) => {
    for (const [channel, result] of Object.entries(
      plan.msot.by_market_segment,
    )) {
      if (!result) continue;
      for (const [field, resolution] of Object.entries(result.fields)) {
        const value = resolution.value;
        const previous =
          before?.plans[index]?.msot.by_market_segment[channel as "on_exchange"]
            ?.fields[field as keyof typeof result.fields]?.value ?? null;
        const key = json([
          plan.public.state,
          plan.public.issuer_id,
          channel,
          field,
        ]);
        const group = groups.get(key) ?? {
          state: plan.public.state,
          issuer_id: plan.public.issuer_id,
          market_segment: channel,
          field,
          true_to_false: 0,
          unknown_to_known: 0,
          changed: 0,
          newly_withheld: 0,
        };
        if (previous === true && value === false) group.true_to_false++;
        if (previous === null && value !== null) group.unknown_to_known++;
        if (previous !== value) group.changed++;
        if (field === "marketable" && previous === true && value !== true)
          group.newly_withheld++;
        groups.set(key, group);
      }
    }
  });
  return [...groups.values()];
}

export class VersionService {
  constructor(readonly reader: CanonicalReader) {}
  private async mutate<T>(
    db: Database,
    sourceId: () => string,
    operation: string,
    meta: Metadata,
    run: (tx: SqlSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        await new Repository(tx).assertApplicationState();
        return run(tx);
      });
    } catch (error) {
      await this.recordRejection(db, sourceId(), operation, meta, error);
      throw error;
    }
  }
  async recordRejection(
    db: Database,
    sourceId: string,
    operation: string,
    meta: Metadata,
    error: unknown,
  ) {
    if (!metadataSchema.safeParse(meta).success) return;
    const code =
      error instanceof Error && /^MSOT_[A-Z_]+$/.test(error.message)
        ? error.message
        : "msot_write_failed";
    // Rejections survive the failed transaction; an unavailable database cannot record them.
    await db
      .transaction(async (tx) => {
        await new Repository(tx).assertApplicationState();
        await new Repository(tx).recordAudit(
          sourceId,
          `rejected:${operation}`,
          {
            ...meta,
            reason: code,
            idempotency_key: `rejected:${randomUUID()}`,
          },
          null,
          null,
          now(),
          meta.idempotency_key,
        );
      })
      .catch(() => {});
  }
  async validate(db: Database, candidate: Candidate, meta: Metadata) {
    metadataSchema.parse(meta);
    await this.mutate(
      db,
      () => candidate.source.source_id,
      "validate",
      meta,
      async (tx) => {
        verify(candidate, this.reader);
        await new Repository(tx).recordAudit(
          candidate.source.source_id,
          "validate",
          meta,
          null,
          candidate.hash,
          now(),
        );
      },
    );
    return {
      valid: true,
      version_hash: candidate.hash,
      rules: candidate.source.rules.length,
    };
  }
  async preview(
    candidate: Candidate,
    rawInput: PreviewInput,
    scope: McpToolContext,
  ) {
    const parsed = resolveInput.parse(rawInput);
    const input = { ...parsed, as_of: parsed.as_of ?? now().slice(0, 10) };
    const compiled = verify(candidate, this.reader);
    const repo = new Repository(scope.db);
    const head = await repo.head(candidate.source.source_id);
    if (!this.reader.validateScopes)
      throw new Error("msot_scope_validation_required");
    await this.reader.validateScopes(
      {
        year: input.year,
        product_families: candidate.source.product_families,
        scopes: compiled.source.rules.map((r) => r.scope),
      },
      scope,
    );
    const after = await compiled.resolve(input, scope);
    let before: Resolution | null = null;
    if (head.active_version !== null) {
      const stored = await repo.version(
        candidate.source.source_id,
        head.active_version,
      );
      if (compileSource(stored.source, this.reader).hash !== stored.hash)
        throw new Error("msot_input_changed");
      before = await compileSource(stored.source, this.reader).resolve(
        input,
        scope,
      );
      if (before.msot.catalog_generation !== after.msot.catalog_generation)
        throw new Error("msot_catalog_changed");
    }
    return {
      candidate_hash: candidate.hash,
      expected: {
        version: head.active_version,
        activation: head.activation_sequence,
      },
      catalog_generation: after.msot.catalog_generation,
      groups: transitions(before, after),
      before,
      after,
    };
  }
  async import(db: Database, candidate: Candidate, meta: Metadata) {
    metadataSchema.parse(meta);
    const draftId = randomUUID();
    await this.mutate(
      db,
      () => candidate.source.source_id,
      "import",
      meta,
      async (tx) => {
        verify(candidate, this.reader);
        if (
          [...candidate.source.fields, ...candidate.source.rules].some(
            (r) => r.set_by !== meta.actor,
          )
        )
          throw new Error("msot_actor_mismatch");
        if (!candidate.artifacts.length)
          throw new Error("msot_input_provenance_required");
        await new Repository(tx).insertDraft(
          draftId,
          candidate,
          meta.actor,
          now(),
        );
        await new Repository(tx).recordAudit(
          candidate.source.source_id,
          "import",
          meta,
          null,
          candidate.hash,
          now(),
        );
      },
    );
    return { draft_id: draftId, version_hash: candidate.hash };
  }
  async previewDraft(
    db: Database,
    draftId: string,
    input: PreviewInput,
    signal: AbortSignal,
    meta: Metadata,
  ) {
    metadataSchema.parse(meta);
    let sourceId = "unknown";
    return this.mutate(
      db,
      () => sourceId,
      "validate",
      meta,
      async (tx) => {
        const candidate = await new Repository(tx).draft(draftId);
        sourceId = candidate.source.source_id;
        const preview = await this.preview(candidate, input, {
          db: tx,
          signal,
        });
        const previewId = randomUUID();
        await new Repository(tx).insertPreview(
          previewId,
          draftId,
          candidate,
          preview.catalog_generation,
          preview.expected.activation,
          { ...input, as_of: preview.after.msot.as_of },
        );
        await new Repository(tx).recordAudit(
          candidate.source.source_id,
          "validate",
          meta,
          null,
          candidate.hash,
          now(),
        );
        return { preview_id: previewId, ...preview };
      },
    );
  }
  async publish(
    db: Database,
    previewId: string,
    expected: Expectation,
    meta: Metadata,
    events: EventRegistry,
    signal: AbortSignal,
  ) {
    metadataSchema.parse(meta);
    let sourceId = "unknown";
    return this.mutate(
      db,
      () => sourceId,
      "publish",
      meta,
      async (tx) => {
        const repo = new Repository(tx);
        const receipt = await repo.preview(previewId);
        const candidate = await repo.draft(receipt.draft_id);
        sourceId = candidate.source.source_id;
        const compiled = verify(candidate, this.reader);
        await repo.ensureSource(candidate.source.source_id);
        const head = await repo.head(candidate.source.source_id, true);
        expectHead(head, expected);
        if (
          head.activation_sequence !== receipt.expected_activation ||
          candidate.hash !== receipt.version_hash
        )
          throw new Error("msot_preview_stale");
        if (!this.reader.validateScopes)
          throw new Error("msot_scope_validation_required");
        await this.reader.validateScopes(
          {
            year: receipt.input.year,
            product_families: candidate.source.product_families,
            scopes: candidate.source.rules.map((r) => r.scope),
          },
          { db: tx, signal },
        );
        const resolved = await compiled.resolve(receipt.input, {
          db: tx,
          signal,
        });
        if (resolved.msot.catalog_generation !== receipt.catalog_generation)
          throw new Error("msot_preview_stale");
        const { source, hash } = candidate;
        const latest = await repo.latestVersion(source.source_id);
        if (source.version !== latest + 1)
          throw new Error("msot_version_sequence_conflict");
        await repo.insertVersion(candidate, meta.actor, now());
        signal.throwIfAborted();
        const final = await this.reader.plans(
          { plan_ids: receipt.input.plan_ids, year: receipt.input.year },
          {
            db: tx,
            signal,
          },
        );
        if (final.catalog_generation !== receipt.catalog_generation)
          throw new Error("msot_preview_stale");
        await repo.recordAudit(
          source.source_id,
          "publish",
          meta,
          null,
          hash,
          now(),
        );
        await events.emit(
          {
            type: "msot.changed",
            idempotencyKey: `msot:${meta.idempotency_key}`,
            payload: {
              sourceId: source.source_id,
              version: source.version,
              previousHash: null,
              newHash: hash,
              operation: "publish",
              changedCount: source.rules.length,
              reasonCode: meta.reason,
            },
          },
          { session: tx, requireOutbox: true },
        );
        signal.throwIfAborted();
        return {
          source_id: source.source_id,
          version: source.version,
          version_hash: hash,
        };
      },
    );
  }
  async activate(
    db: Database,
    sourceId: string,
    version: number,
    expected: Expectation,
    meta: Metadata,
    events: EventRegistry,
    operation: "activate" | "rollback" | "retire" = "activate",
  ) {
    metadataSchema.parse(meta);
    return this.mutate(
      db,
      () => sourceId,
      operation,
      meta,
      async (tx) => {
        const repo = new Repository(tx);
        const head = await repo.head(sourceId, true);
        expectHead(head, expected);
        const stored = await repo.version(sourceId, version);
        if (compileSource(stored.source, this.reader).hash !== stored.hash)
          throw new Error("msot_input_changed");
        if (operation === "retire" && head.active_version !== version)
          throw new Error("msot_active_version_required");
        const previous =
          head.active_version === null
            ? null
            : (await repo.version(sourceId, head.active_version)).hash;
        const next = operation === "retire" ? null : version;
        await repo.activate(
          sourceId,
          version,
          next,
          head.active_version,
          head.activation_sequence + 1,
          operation,
          meta.actor,
          now(),
        );
        await new Repository(tx).recordAudit(
          sourceId,
          operation,
          meta,
          previous,
          operation === "retire" ? null : stored.hash,
          now(),
        );
        const payload = {
          sourceId,
          version,
          previousHash: previous,
          newHash: operation === "retire" ? null : stored.hash,
          operation,
          changedCount: stored.source.rules.length,
          reasonCode: meta.reason,
        };
        await events.emit(
          operation === "retire"
            ? {
                type: "msot.retired",
                idempotencyKey: `msot:${meta.idempotency_key}`,
                payload,
              }
            : {
                type: "msot.changed",
                idempotencyKey: `msot:${meta.idempotency_key}`,
                payload,
              },
          { session: tx, requireOutbox: true },
        );
        return {
          active_version: next,
          activation_sequence: head.activation_sequence + 1,
        };
      },
    );
  }
}
