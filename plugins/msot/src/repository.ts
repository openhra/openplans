import { randomUUID } from "node:crypto";
import type { SqlSession, CatalogPolicyInput } from "@openplans/plugin-sdk";
import { sourceSchema, applicationState } from "./schema.js";
import type { Candidate } from "./files.js";

const json = (value: unknown) => JSON.stringify(value);

export class Repository {
  constructor(readonly db: SqlSession) {}
  async assertApplicationState() {
    const { rows } = await this.db.query<{
      table_name: string;
      fixed_by: string;
      fixed_slug: string;
      policy_name: string;
    }>(
      "SELECT table_name,fixed_by,fixed_slug,policy_name FROM row_provenance_rule WHERE table_name=ANY($1::text[])",
      [applicationState.map((e) => e.table)],
    );
    if (
      applicationState.some(
        (e) =>
          !rows.some(
            (r) =>
              r.table_name === e.table &&
              r.fixed_by === "openplans" &&
              r.fixed_slug === `app:plugin-msot:${e.table}` &&
              r.policy_name === "app_state",
          ),
      )
    )
      throw new Error("msot_application_state_required");
  }
  async head(sourceId: string, lock = false) {
    const { rows } = await this.db.query<{
      active_version: number | null;
      activation_sequence: number;
    }>(
      `SELECT active_version,activation_sequence FROM plg_msot_source WHERE source_id=$1${lock ? " FOR UPDATE" : ""}`,
      [sourceId],
    );
    return rows[0] ?? { active_version: null, activation_sequence: 0 };
  }
  async ensureSource(sourceId: string) {
    await this.db.query(
      "INSERT INTO plg_msot_source(source_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [sourceId],
    );
  }
  async version(sourceId: string, version: number, allowRetired = false) {
    const { rows } = await this.db.query<{
      version_hash: string;
      metadata: Record<string, unknown>;
      artifacts: Candidate["artifacts"];
    }>(
      `SELECT v.version_hash,v.metadata,v.artifacts FROM plg_msot_version v
       WHERE source_id=$1 AND version=$2 ${allowRetired ? "" : "AND NOT EXISTS (SELECT 1 FROM plg_msot_retirement r WHERE r.source_id=v.source_id AND r.version=v.version)"}`,
      [sourceId, version],
    );
    const row = rows[0];
    if (!row) throw new Error("msot_version_unavailable");
    const fields = await this.db.query<{ definition: unknown }>(
      "SELECT definition FROM plg_msot_field_definition WHERE source_id=$1 AND version=$2 ORDER BY name",
      [sourceId, version],
    );
    const rules = await this.db.query<{ rule: unknown }>(
      "SELECT rule FROM plg_msot_rule WHERE source_id=$1 AND version=$2 ORDER BY rule_id",
      [sourceId, version],
    );
    const source = sourceSchema.parse({
      ...row.metadata,
      fields: fields.rows.map((r) => r.definition),
      rules: rules.rows.map((r) => r.rule),
    });
    return { source, hash: row.version_hash, artifacts: row.artifacts };
  }
  async draft(id: string) {
    const { rows } = await this.db.query<{
      document: Candidate["source"];
      version_hash: string;
      artifacts: Candidate["artifacts"];
      row_refs: Candidate["rowRefs"];
      actor: string;
    }>(
      "SELECT document,version_hash,artifacts,row_refs,actor FROM plg_msot_draft WHERE draft_id=$1",
      [id],
    );
    if (!rows[0]) throw new Error("msot_draft_unavailable");
    return {
      source: rows[0].document,
      hash: rows[0].version_hash,
      artifacts: rows[0].artifacts,
      rowRefs: rows[0].row_refs,
      actor: rows[0].actor,
    };
  }
  async versions(sourceId: string) {
    return (
      await this.db.query(
        `SELECT v.version,v.version_hash,v.actor,v.asserted_at,
      EXISTS (SELECT 1 FROM plg_msot_retirement r WHERE r.source_id=v.source_id AND r.version=v.version) AS retired
      FROM plg_msot_version v WHERE source_id=$1 ORDER BY version DESC LIMIT 100`,
        [sourceId],
      )
    ).rows;
  }
  async audit(sourceId: string) {
    return (
      await this.db.query(
        `SELECT operation,actor,credential_class AS actor_class,asserted_at,reason_code,previous_hash,new_hash,attempt_key,idempotency_key
      FROM plg_msot_audit WHERE source_id=$1 ORDER BY asserted_at DESC,audit_id LIMIT 100`,
        [sourceId],
      )
    ).rows;
  }
  async inspection(sourceId: string, version?: number) {
    const head = await this.head(sourceId);
    const selected = version ?? head.active_version;
    if (selected === null) throw new Error("msot_version_unavailable");
    const stored = await this.version(sourceId, selected, true);
    const lineage = (
      await this.db.query(
        `SELECT entity_ref,input_hash,row_ref,actor,asserted_at,credential_class AS actor_class
      FROM plg_msot_provenance WHERE source_id=$1 AND version=$2 ORDER BY entity_ref`,
        [sourceId, selected],
      )
    ).rows;
    const activations = (
      await this.db.query(
        `SELECT version,previous_version,sequence,operation,actor,asserted_at
      FROM plg_msot_activation WHERE source_id=$1 ORDER BY sequence DESC LIMIT 100`,
        [sourceId],
      )
    ).rows;
    return { ...stored, head, lineage, activations };
  }
  async recordAudit(
    sourceId: string,
    operation: string,
    meta: { actor: string; reason: string; idempotency_key: string },
    before: string | null,
    after: string | null,
    at: string,
    attemptKey?: string,
  ) {
    await this.db.query(
      `INSERT INTO plg_msot_audit(audit_id,source_id,operation,actor,credential_class,asserted_at,reason_code,previous_hash,new_hash,attempt_key,idempotency_key)
    VALUES ($1,$2,$3,$4,'shell_asserted',$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        sourceId,
        operation,
        meta.actor,
        at,
        meta.reason,
        before,
        after,
        attemptKey ?? meta.idempotency_key,
        meta.idempotency_key,
      ],
    );
  }
  async insertDraft(
    draftId: string,
    candidate: Candidate,
    actor: string,
    at: string,
  ) {
    await this.db.query(
      `INSERT INTO plg_msot_draft(draft_id,source_id,version,version_hash,document,artifacts,row_refs,actor,asserted_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
      [
        draftId,
        candidate.source.source_id,
        candidate.source.version,
        candidate.hash,
        json(candidate.source),
        json(candidate.artifacts),
        json(candidate.rowRefs),
        actor,
        at,
      ],
    );
  }
  async insertPreview(
    previewId: string,
    draftId: string,
    candidate: Candidate,
    generation: string,
    activation: number,
    input: CatalogPolicyInput,
  ) {
    await this.db.query(
      `INSERT INTO plg_msot_preview(preview_id,source_id,version_hash,draft_id,catalog_generation,expected_activation,input)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        previewId,
        candidate.source.source_id,
        candidate.hash,
        draftId,
        generation,
        activation,
        json(input),
      ],
    );
  }
  async preview(previewId: string) {
    const { rows } = await this.db.query<{
      draft_id: string;
      version_hash: string;
      catalog_generation: string;
      expected_activation: number;
      input: CatalogPolicyInput;
    }>(
      "SELECT draft_id,version_hash,catalog_generation,expected_activation,input FROM plg_msot_preview WHERE preview_id=$1",
      [previewId],
    );
    const receipt = rows[0];
    if (!receipt) throw new Error("msot_preview_required");
    return receipt;
  }
  async latestVersion(sourceId: string) {
    const { rows } = await this.db.query<{ latest: number }>(
      "SELECT coalesce(max(version),0)::int AS latest FROM plg_msot_version WHERE source_id=$1",
      [sourceId],
    );
    return rows[0]!.latest;
  }
  async insertVersion(
    candidate: Candidate & { actor: string },
    actor: string,
    at: string,
  ) {
    const { source, hash, artifacts, rowRefs } = candidate;
    const { fields, rules, ...metadata } = source;
    await this.db.query(
      `INSERT INTO plg_msot_version(source_id,version,version_hash,metadata,artifacts,actor,asserted_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [
        source.source_id,
        source.version,
        hash,
        json(metadata),
        json(artifacts),
        actor,
        at,
      ],
    );
    for (const field of fields)
      await this.db.query(
        "INSERT INTO plg_msot_field_definition(source_id,version,name,definition) VALUES ($1,$2,$3,$4::jsonb)",
        [source.source_id, source.version, field.name, json(field)],
      );
    for (const rule of rules)
      await this.db.query(
        "INSERT INTO plg_msot_rule(source_id,version,rule_id,field,rule) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [source.source_id, source.version, rule.id, rule.field, json(rule)],
      );
    for (const [entityRef, ref] of Object.entries(rowRefs))
      await this.db.query(
        `INSERT INTO plg_msot_provenance(source_id,version,entity_ref,input_hash,row_ref,actor,asserted_at,credential_class)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'shell_asserted')`,
        [
          source.source_id,
          source.version,
          entityRef,
          ref.input_hash,
          ref.row_ref,
          candidate.actor,
          at,
        ],
      );
  }
  async activate(
    sourceId: string,
    version: number,
    next: number | null,
    previous: number | null,
    sequence: number,
    operation: "activate" | "rollback" | "retire",
    actor: string,
    at: string,
  ) {
    await this.db.query(
      "UPDATE plg_msot_source SET active_version=$2,activation_sequence=activation_sequence+1 WHERE source_id=$1",
      [sourceId, next],
    );
    await this.db.query(
      `INSERT INTO plg_msot_activation(activation_id,source_id,version,previous_version,sequence,operation,actor,asserted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), sourceId, next, previous, sequence, operation, actor, at],
    );
    if (operation === "retire")
      await this.db.query(
        "INSERT INTO plg_msot_retirement(source_id,version,actor,asserted_at) VALUES ($1,$2,$3,$4)",
        [sourceId, version, actor, at],
      );
  }
}
