import packageJson from "../package.json" with { type: "json" };
import type {
  OpenPlansPlugin,
  CatalogPolicyInput,
  McpToolContext,
} from "@openplans/plugin-sdk";
import { compileSource } from "./resolver.js";
import {
  optionsSchema,
  resolveInput,
  mcpOutput,
  applicationState,
} from "./schema.js";
import { registerWorker } from "./worker.js";
import { registerInspection } from "./inspection.js";
import { Repository } from "./repository.js";

export { applicationState } from "./schema.js";

const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/plugin-msot",
    version: packageJson.version,
    apiVersion: "0.2",
    tablePrefix: "msot",
    kinds: [
      "routes",
      "mcpTools",
      "catalogPolicies",
      "workerCommands",
      "events",
    ],
    capabilities: { writes: ["staging", "events"], operatorRoutes: true },
    applicationState,
    options: optionsSchema,
  },
  setup(ctx) {
    const { source, readableSources } = optionsSchema.parse(ctx.options);
    if (!ctx.canonicalReader && !source && readableSources.length === 0) return;
    if (!ctx.canonicalReader) throw new Error("msot_host_contract_required");
    registerWorker(ctx, ctx.canonicalReader);
    registerInspection(ctx, ctx.canonicalReader, readableSources);
    if (!source && !readableSources.length) return;
    if (!ctx.catalogPolicies) throw new Error("msot_host_contract_required");
    const reader = ctx.canonicalReader;
    const inline = source ? compileSource(source, reader) : undefined;
    const provider =
      inline && !readableSources.length
        ? inline
        : {
            async resolve(raw: CatalogPolicyInput, scope: McpToolContext) {
              const input = resolveInput.parse(raw);
              if (inline?.source.source_id === input.source_id)
                return inline.resolve(input, scope);
              if (!readableSources.includes(input.source_id))
                throw new Error("msot_source_not_readable");
              const repo = new Repository(scope.db);
              const head = await repo.head(input.source_id);
              if (head.active_version === null)
                throw new Error("msot_version_unavailable");
              const stored = await repo.version(
                input.source_id,
                input.version ?? head.active_version,
              );
              const compiled = compileSource(stored.source, reader);
              if (compiled.hash !== stored.hash)
                throw new Error("msot_input_changed");
              return compiled.resolve(input, scope);
            },
          };
    ctx.catalogPolicies.provide("msot", provider);
    ctx.routes.add({
      method: "POST",
      path: "/msot/resolve",
      exposure: "public",
      contentType: "application/json",
      handler: async (c) => {
        const input = resolveInput.safeParse(
          await c.req.json().catch(() => undefined),
        );
        if (!input.success)
          return c.json({ error: { code: "msot_invalid_input" } }, 400);
        c.header("Cache-Control", "no-store");
        try {
          return c.json(
            await provider.resolve(input.data, {
              db: c.get("pluginDb"),
              signal: c.get("pluginSignal"),
            }),
          );
        } catch (error) {
          const code =
            error instanceof Error && /^MSOT_[A-Z_]+$/.test(error.message)
              ? error.message
              : "msot_resolve_failed";
          return c.json({ error: { code } }, 400);
        }
      },
    });
    ctx.mcpTools.add({
      name: "msot_resolve",
      title: "Resolve operator plan fields",
      description:
        "Resolves payment permission and marketable decisions for a configured Market Source of Truth with public facts and operator provenance.",
      inputSchema: resolveInput,
      outputSchema: mcpOutput,
      readOnly: true,
      handler: async (input, scope) => {
        const checkedAt = new Date().toISOString();
        const data = await provider.resolve(input, scope);
        const snapshots = [
          ...new Set(data.plans.map((p) => p.public.provenance.snapshot_id)),
        ];
        return {
          schema_version: "1" as const,
          status: "ok" as const,
          data_generation: data.msot.catalog_generation,
          data,
          provenance: snapshots.map((id) => ({
            id,
            snapshot_id: id,
            publisher: null,
            url: null,
            sha256: null,
            retrieved_at: null,
            publisher_updated_at: null,
            record_ref: null,
            status: "available" as const,
          })),
          notes: [
            "Payment permission and marketable decisions are operator instructions, not insurer acceptance or binding authority.",
          ],
          truncated: false as const,
          freshness: {
            checked_at: checkedAt,
            status: "current_local" as const,
          },
          page: null,
          error: null,
        };
      },
    });
  },
};
export default plugin;
