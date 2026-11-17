import type {
  CatalogPolicyInput,
  CatalogPolicyResolution,
  McpToolContext,
  OperatorObservation,
} from "@openplans/plugin-sdk";
import { z } from "zod";

export const INSPECT_BODY_LIMIT = 16 * 1024;
export const INSPECT_PLAN_LIMIT = 25;

const key = z.string().min(1).max(100);
export const inspectInputSchema = z.strictObject({
  field: z.literal("custom_payment_allowed"),
  source_id: key,
  plan_ids: z.array(z.string().min(1).max(220)).min(1).max(INSPECT_PLAN_LIMIT),
  year: z.number().int().min(2014).max(2100),
  as_of: z.iso.date().optional(),
  market_segment: z.enum(["on_exchange", "off_exchange"]).optional(),
});

export type InspectInput = z.infer<typeof inspectInputSchema>;

/** Reads the installed MSoT provider through the host's request-scoped facade. */
export async function inspectAnnotation(
  msot: {
    inspect(
      input: CatalogPolicyInput,
      scope: McpToolContext,
    ): Promise<OperatorObservation<CatalogPolicyResolution>>;
  },
  input: InspectInput,
  scope: McpToolContext,
): Promise<OperatorObservation<CatalogPolicyResolution>> {
  const { field: _field, ...providerInput } = input;
  return msot.inspect(providerInput, scope);
}
