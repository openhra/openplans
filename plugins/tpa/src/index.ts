import { dataNotLoaded } from "@openplans/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { z } from "zod";

export const PREPARE_PATH = "/tpa/receipts/prepare";
const inputSchema = z.strictObject({
  operation: z.literal("prepare_from_batch"),
  include_input_bundle: z.boolean().default(false),
  batch_request: z.strictObject({ rows: z.array(z.unknown()).min(1).max(25) }),
});
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/plugin-tpa",
    version: packageJson.version,
    apiVersion: "0.2",
    kinds: ["routes"],
    capabilities: { operatorRoutes: true },
  },
  setup(ctx) {
    if (!ctx.config.tpa?.enabled || !ctx.config.tpa.privateIngress) return;
    const host = ctx.tpaReceiptHost;
    if (!host) throw new Error("TPA_RECEIPT_HOST_REQUIRED");
    let used = 0;
    let until = 0;
    ctx.routes.add({
      method: "POST",
      path: PREPARE_PATH,
      exposure: "operator",
      contentType: "application/json",
      rateLimit: { perMinute: 30, activePerSource: 2, activeTotal: 4 },
      handler: async (c) => {
        c.header("Cache-Control", "no-store");
        const input = inputSchema.safeParse(
          await c.req.json().catch(() => undefined),
        );
        if (!input.success)
          return c.json({ error: { code: "INVALID_RECEIPT_REQUEST" } }, 400);
        const now = Date.now();
        if (now >= until) {
          used = 0;
          until = now + 60_000;
        }
        if (used + input.data.batch_request.rows.length > 30) {
          c.header(
            "Retry-After",
            String(Math.max(1, Math.ceil((until - now) / 1000))),
          );
          return c.json({ error: { code: "RATE_LIMITED" } }, 429);
        }
        used += input.data.batch_request.rows.length;
        try {
          const signal = AbortSignal.any([
            c.req.raw.signal,
            c.get("pluginSignal"),
          ]);
          const receipt = await host.prepare(
            input.data.batch_request,
            input.data.include_input_bundle,
            { db: c.get("pluginDb"), signal },
          );
          c.header(
            "Content-Disposition",
            'attachment; filename="answer-receipt.json"',
          );
          return c.json(receipt);
        } catch (error) {
          const missing = dataNotLoaded(error);
          if (missing) return c.json({ error: missing }, 404);
          return c.json({ error: { code: "RECEIPT_PREPARATION_FAILED" } }, 503);
        }
      },
    });
  },
};
export default plugin;
