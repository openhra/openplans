import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { z } from "zod";
import { marketInput, marketQuery } from "./input.js";
import { marketCosts, marketOutput } from "./service.js";
import { printMarket } from "./print.js";
import { marketForm, visitorPage } from "./visitor.js";
import { employerInput } from "./employer-input.js";
import { employerCosts } from "./employer.js";
import { printEmployer } from "./employer-print.js";

export const PLUGIN_NAME = "@openplans/plugin-compare";
const PUBLIC_LIMITS = { perMinute: 30, activePerSource: 2, activeTotal: 4 };

const plugin: OpenPlansPlugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.1.5",
    apiVersion: "0.1",
    kinds: ["routes", "mcpTools"],
    capabilities: { operatorRoutes: true },
  },
  setup(ctx) {
    if (!ctx.config.public.quoting) return;
    const host = ctx.calculationHost;
    if (!host) throw new Error("calculation_host_unavailable");
    ctx.routes.add({
      method: "GET",
      path: "/compare/v1",
      exposure: "public",
      rateLimit: PUBLIC_LIMITS,
      contentType: "text/html",
      handler: async (c) => {
        c.header("Cache-Control", "no-store");
        if (Object.keys(c.req.query()).length)
          return c.json({ error: { code: "INVALID_INPUT" } }, 400);
        return c.html(visitorPage());
      },
    });
    for (const mode of ["market", "print"] as const) {
      ctx.routes.add({
        method: mode === "market" ? "GET" : "POST",
        path: `/compare/v1/${mode}`,
        exposure: "public",
        rateLimit: PUBLIC_LIMITS,
        contentType: mode === "market" ? "application/json" : "text/html",
        handler: async (c) => {
          c.header("Cache-Control", "no-store");
          try {
            let input: z.output<typeof marketInput>;
            if (mode === "market") input = marketQuery(c.req.query());
            else if (
              c.req.header("content-type")?.split(";")[0]?.trim() ===
              "application/x-www-form-urlencoded"
            )
              input = marketForm(await c.req.parseBody({ all: true }));
            else input = marketInput.parse(await c.req.json());
            const answer = await marketCosts(host, input, {
              db: c.get("pluginDb"),
              signal: c.get("pluginSignal"),
            });
            return mode === "market"
              ? c.json(answer)
              : c.html(printMarket(answer));
          } catch (error) {
            if (
              error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              (error instanceof Error && error.message === "INVALID_INPUT")
            )
              return c.json({ error: { code: "INVALID_INPUT" } }, 400);
            const code =
              error instanceof Error &&
              [
                "generation_changed",
                "work_budget_exceeded",
                "QUOTING_DISABLED",
              ].includes(error.message)
                ? error.message
                : "comparison_unavailable";
            return c.json({ error: { code } }, 503);
          }
        },
      });
    }
    if (ctx.config.tpa?.enabled && ctx.config.tpa.privateIngress) {
      for (const mode of ["employer", "employer-print"] as const) {
        ctx.routes.add({
          method: "POST",
          path: `/compare/v1/${mode}`,
          exposure: "operator",
          rateLimit: PUBLIC_LIMITS,
          contentType: mode === "employer" ? "application/json" : "text/html",
          handler: async (c) => {
            c.header("Cache-Control", "no-store");
            try {
              const input = employerInput.parse(await c.req.json());
              const answer = await employerCosts(host, input, {
                db: c.get("pluginDb"),
                signal: c.get("pluginSignal"),
              });
              return mode === "employer"
                ? c.json(answer)
                : c.html(printEmployer(answer));
            } catch (error) {
              if (
                error instanceof z.ZodError ||
                error instanceof SyntaxError ||
                (error instanceof Error &&
                  ["INVALID_INPUT", "INVALID_BATCH"].includes(error.message))
              )
                return c.json({ error: { code: "INVALID_INPUT" } }, 400);
              return c.json({ error: { code: "comparison_unavailable" } }, 503);
            }
          },
        });
      }
    }
    ctx.mcpTools.add({
      name: "compare_market_costs",
      title: "Individual offer distribution",
      description:
        "Gross monthly prices across eligible public base plans for one exact age or an explicitly listed non-tobacco household. Counts gaps; no group quote, subsidy or employer inputs. Evidence pages require the returned generation.",
      inputSchema: marketInput,
      outputSchema: marketOutput,
      readOnly: true,
      handler: (input, scope) => marketCosts(host, input, scope),
    });
  },
};
export default plugin;
