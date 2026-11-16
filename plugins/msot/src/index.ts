import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { compileSource } from "./resolver.js";
import { optionsSchema, resolveInput, mcpOutput } from "./schema.js";

const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/plugin-msot",
    version: "0.1.0",
    apiVersion: "0.1",
    tablePrefix: "msot",
    kinds: ["routes", "mcpTools", "catalogPolicies"],
    options: optionsSchema,
  },
  setup(ctx) {
    const { source } = optionsSchema.parse(ctx.options);
    if (!source) return;
    if (!ctx.canonicalReader || !ctx.catalogPolicies)
      throw new Error("MSOT_HOST_CONTRACT_REQUIRED");
    const provider = compileSource(source, ctx.canonicalReader);
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
        if (!input.success) return c.json({ error: "MSOT_INVALID_INPUT" }, 400);
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
              : "MSOT_RESOLVE_FAILED";
          return c.json({ error: code }, 400);
        }
      },
    });
    ctx.mcpTools.add({
      name: "msot_resolve",
      title: "Resolve operator payment permission",
      description:
        "Resolves custom_payment_allowed for a configured Market Source of Truth with public facts and operator provenance.",
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
            "Payment permission is an operator instruction, not insurer acceptance or binding authority.",
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
