import type { CanonicalReader, PluginContext } from "@openplans/plugin-sdk";
import { z } from "zod";
import { Repository } from "./repository.js";
import { VersionService } from "./service.js";
import { compileSource } from "./resolver.js";
import { resolveInput, sourceSchema } from "./schema.js";

const selector = z.strictObject({
  source_id: z.string().min(1).max(100),
  version: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .optional(),
});
export function registerInspection(
  ctx: PluginContext,
  reader: CanonicalReader,
  readableSources: string[],
) {
  if (!readableSources.length) return;
  const service = new VersionService(reader);
  for (const operation of ["versions", "inspect", "audit", "preview"] as const)
    ctx.routes.add({
      method: operation === "preview" ? "POST" : "GET",
      path: `/msot/${operation}`,
      exposure: "operator",
      contentType: "application/json",
      handler: async (c) => {
        c.header("Cache-Control", "no-store");
        try {
          const repo = new Repository(c.get("pluginDb"));
          if (operation === "preview") {
            const body = z
              .strictObject({ source: sourceSchema, input: resolveInput })
              .parse(await c.req.json());
            if (!readableSources.includes(body.source.source_id))
              throw new Error("MSOT_SOURCE_NOT_READABLE");
            const compiled = compileSource(body.source, reader);
            return c.json(
              await service.preview(
                {
                  source: compiled.source,
                  hash: compiled.hash,
                  artifacts: [],
                  rowRefs: {},
                },
                body.input,
                { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
              ),
            );
          }
          const query = selector.parse(c.req.query());
          if (!readableSources.includes(query.source_id))
            throw new Error("MSOT_SOURCE_NOT_READABLE");
          if (operation === "versions")
            return c.json(await repo.versions(query.source_id));
          if (operation === "audit")
            return c.json(await repo.audit(query.source_id));
          return c.json(await repo.inspection(query.source_id, query.version));
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error && /^MSOT_[A-Z_]+$/.test(error.message)
                  ? error.message
                  : "MSOT_INVALID_INPUT",
            },
            400,
          );
        }
      },
    });
}
