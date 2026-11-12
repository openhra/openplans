import { z } from "zod";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type { SqlSession } from "../../db/database.js";
import { schemaViolations } from "../../db/row-provenance-check.js";

export const checkRowProvenance = schemaViolations;

export const NON_CATALOG_TABLES: Readonly<Record<string, string>> = {
  api_data_generation: "tracks catalog revisions",
  schema_migrations: "records applied migrations",
  spatial_ref_sys: "PostGIS reference systems",
  plugin_event_outbox: "application event log",
  plugin_event_delivery: "application delivery state",
  plugin_state: "application plugin state",
  passthrough_budget: "pass-through request budget state",
  passthrough_attempt: "pass-through call log",
  passthrough_conflict: "stored answers checked against loaded files",
  ingest_run_snapshot: "ingest run snapshot log",
};

/** Require the enabled AFTER STATEMENT trigger for insert, update, delete and truncate. */
export async function checkCatalogTriggers(
  db: SqlSession,
  exemptions: Readonly<Record<string, string>> = NON_CATALOG_TABLES,
): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(`
    SELECT c.relname AS table_name FROM pg_class c
    WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid=c.oid AND t.tgname='api_data_changed'
          AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
          AND t.tgtype=60 AND t.tgfoid=to_regproc('bump_api_data_generation'))
    ORDER BY c.relname`);
  return rows
    .filter(({ table_name }) => !exemptions[table_name]?.trim())
    .map(({ table_name }) => `${table_name}: no api_data_changed trigger`);
}

const forbidden =
  /zip|age|income|tobacco|household|members|body|url|path|host|key|token|secret|password|connection/i;
export const EVENT_PAYLOAD_ALLOWED_NAMES: ReadonlySet<string> = new Set([
  "untilAt",
  "imageId",
]);

/** Scan schema property names, including nested arrays, unions and definitions. */
export function checkEventPayloads(
  events: Readonly<Record<string, z.ZodType>> = eventPayloadSchemas,
): string[] {
  const problems: string[] = [];
  for (const [event, schema] of Object.entries(events)) {
    try {
      const json: unknown = z.toJSONSchema(schema);
      const walk = (node: unknown, path: string): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const value = node as Record<string, unknown>;
        if (value.additionalProperties && value.additionalProperties !== false)
          problems.push(`${path}: unrestricted property names`);
        if (value.patternProperties)
          problems.push(`${path}: patterned property names`);
        // An opaque schema can accept arbitrary objects and cannot prove the rule.
        if (
          !["type", "anyOf", "allOf", "oneOf", "$ref", "enum", "const"].some(
            (key) => key in value,
          )
        )
          problems.push(`${path}: uninspectable payload schema`);
        if (value.properties && typeof value.properties === "object") {
          for (const [name, child] of Object.entries(value.properties)) {
            const childPath = `${path}/${name}`;
            if (forbidden.test(name) && !EVENT_PAYLOAD_ALLOWED_NAMES.has(name))
              problems.push(`${childPath}: forbidden payload property`);
            walk(child, childPath);
          }
        }
        for (const key of [
          "items",
          "additionalProperties",
          "not",
          "if",
          "then",
          "else",
        ])
          if (typeof value[key] === "object")
            walk(value[key], `${path}/${key}`);
        for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
          if (Array.isArray(value[key]))
            value[key].forEach((child: unknown, index: number) =>
              walk(child, `${path}/${key}/${index}`),
            );
        for (const key of ["$defs", "definitions"])
          if (value[key] && typeof value[key] === "object")
            for (const [name, child] of Object.entries(value[key]))
              walk(child, `${path}/${key}/${name}`);
      };
      walk(json, event);
    } catch {
      problems.push(`${event}: uninspectable payload schema`);
    }
  }
  return [...new Set(problems)].sort();
}
