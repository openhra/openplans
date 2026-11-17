import type {
  CalculationHost,
  CalculationScope,
  OpenPlansPlugin,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import { allowanceMcpAnswer } from "./mcp.js";
import { allowanceOutput, privateInput, presetInput } from "./contract.js";
import { allowanceScenario } from "./service.js";
import { allowanceSourceManifest, printAllowanceSheet } from "./sheet.js";

export const ALLOWANCE_PATH = "/handy/allowance";
export const ALLOWANCE_PRIVATE_PATH = "/handy/allowance/scenario";
export const ALLOWANCE_TOOL = "get_allowance_range";
type Host = {
  householdDistributions: NonNullable<
    CalculationHost["householdDistributions"]
  >;
  slcsp: NonNullable<CalculationHost["slcsp"]>;
};
const PUBLIC_LIMITS = { perMinute: 30, activePerSource: 2, activeTotal: 4 };
const presetQuery = z.strictObject({
  zip: z.string().regex(/^\d{5}$/),
  county: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  year: z.coerce.number().int().min(2014).max(2100),
  preset: z.literal("family-40-40-10-8-v1"),
  data_generation: z.string().min(1).max(200).optional(),
  paper: z.enum(["letter", "A4"]).optional(),
});
const answerForPreset = (
  host: Host,
  scope: CalculationScope,
  parsed: z.infer<typeof presetQuery>,
) => allowanceScenario(host, scope, parsed);

const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/plugin-handy",
    version: "0.1.1",
    apiVersion: "0.1",
    kinds: ["routes", "mcpTools"],
    capabilities: { operatorRoutes: true },
  },
  setup(ctx) {
    if (!ctx.config.public.quoting) return;
    const { publicOnly } = z
      .strictObject({ publicOnly: z.boolean().default(false) })
      .parse(ctx.options ?? {});
    const candidate = ctx.calculationHost;
    const host =
      candidate?.householdDistributions && candidate.slcsp
        ? {
            householdDistributions:
              candidate.householdDistributions.bind(candidate),
            slcsp: candidate.slcsp.bind(candidate),
          }
        : undefined;
    for (const mode of ["print", "manifest"] as const) {
      ctx.routes.add({
        method: "GET",
        path: `/handy/allowance/${mode}`,
        exposure: "public",
        rateLimit: PUBLIC_LIMITS,
        contentType: mode === "print" ? "text/html" : "application/json",
        handler: async (c) => {
          c.header("Cache-Control", "no-store");
          const parsed = presetQuery.safeParse(c.req.query());
          if (!parsed.success) return c.json({ error: "INVALID_INPUT" }, 400);
          if (!host) return c.json({ error: "CALCULATION_UNKNOWN" }, 503);
          try {
            const answer = await answerForPreset(
              host,
              { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
              parsed.data,
            );
            if (
              parsed.data.data_generation &&
              parsed.data.data_generation !== answer.data_generation
            )
              return c.json({ error: "DATA_CHANGED" }, 409);
            if (mode === "manifest") {
              c.header(
                "Content-Disposition",
                'attachment; filename="allowance-source-manifest.json"',
              );
              return c.json(allowanceSourceManifest(answer));
            }
            const query = new URLSearchParams(
              Object.entries({
                ...parsed.data,
                data_generation: answer.data_generation,
              }).map(([key, value]) => [key, String(value)]),
            ).toString();
            const manifestHref = `/handy/allowance/manifest?${query}`;
            return c.html(
              printAllowanceSheet(
                { ...answer, generated_at: new Date().toISOString() },
                manifestHref,
                parsed.data.paper ?? "letter",
              ),
            );
          } catch (error) {
            if (error instanceof Error && error.message === "DATA_CHANGED")
              return c.json({ error: "DATA_CHANGED" }, 409);
            return c.json({ error: "CALCULATION_UNKNOWN" }, 503, {
              "Cache-Control": "no-store",
            });
          }
        },
      });
    }
    ctx.routes.add({
      method: "POST",
      path: ALLOWANCE_PATH,
      exposure: "public",
      rateLimit: PUBLIC_LIMITS,
      contentType: "application/json",
      handler: async (c) => {
        let value: unknown;
        try {
          value = await c.req.json();
        } catch {
          return c.json({ error: "INVALID_INPUT" }, 400);
        }
        const parsed = presetInput.safeParse(value);
        if (!parsed.success) return c.json({ error: "INVALID_INPUT" }, 400);
        try {
          if (!host) throw new Error("calculation_host_required");
          const result = await allowanceScenario(
            host,
            { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
            parsed.data,
          );
          return c.json(result, 200, { "Cache-Control": "no-store" });
        } catch {
          return c.json({ error: "CALCULATION_UNKNOWN" }, 503, {
            "Cache-Control": "no-store",
          });
        }
      },
    });
    if (!publicOnly)
      ctx.routes.add({
        method: "POST",
        path: ALLOWANCE_PRIVATE_PATH,
        exposure: "operator",
        rateLimit: PUBLIC_LIMITS,
        contentType: "application/json",
        handler: async (c) => {
          let value: unknown;
          try {
            value = await c.req.json();
          } catch {
            return c.json({ error: "INVALID_INPUT" }, 400);
          }
          const parsed = privateInput.safeParse(value);
          if (
            !parsed.success ||
            parsed.data.members.map((m) => m.relationship).join(",") !==
              "subscriber,spouse,child,child"
          )
            return c.json({ error: "INVALID_INPUT" }, 400);
          try {
            if (!host) throw new Error("calculation_host_required");
            const result = await allowanceScenario(
              host,
              { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
              parsed.data,
            );
            return c.json(result, 200, { "Cache-Control": "no-store" });
          } catch {
            return c.json({ error: "CALCULATION_UNKNOWN" }, 503, {
              "Cache-Control": "no-store",
            });
          }
        },
      });
    ctx.mcpTools.add({
      name: ALLOWANCE_TOOL,
      title: "Allowance range",
      description:
        "Calculate the named four-profile gross premium range and adjusted SLCSP context for one ZIP and year.",
      inputSchema: presetInput,
      outputSchema: allowanceOutput,
      readOnly: true,
      handler: async (input, scope) => {
        if (!host) throw new Error("calculation_host_required");
        return allowanceMcpAnswer(
          await allowanceScenario(host, scope, input),
          input,
        );
      },
    });
  },
};
export default plugin;
