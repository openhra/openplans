import { readFileSync } from "node:fs";
import type { z } from "zod";

/** docs/public-contract.json: the public surface the deployment checks read too. */
export interface PublicContract {
  status: {
    required: string[];
    optional: Record<string, { allowed: unknown[] }>;
  };
  mcp: { public_plugins: string[]; anonymous_tools: string[] };
  availability: { row_required: string[] };
  errors: Record<
    "rest" | "jsonrpc",
    {
      envelope: string;
      required: Record<string, string>;
      optional?: Record<string, string>;
      code_pattern?: string;
    }
  >;
  reasons: { codes: string[] };
  readiness: {
    routes: string[];
    ready_fields: Record<string, string>;
    mcp_tool: string;
    mcp_field: string;
  };
  request_id: {
    header: string;
    error_member: string;
    max_length: number;
    accepted_pattern: string;
    generated_pattern: string;
  };
}

export const contract = JSON.parse(
  readFileSync(
    new URL("../docs/public-contract.json", import.meta.url),
    "utf8",
  ),
) as PublicContract;

export type StatusSchema = z.ZodObject<Record<string, z.ZodType>>;

/** How the app's public status schema differs from the contract, as sentences; [] when it matches. */
export function statusContractProblems(
  schema: StatusSchema,
  surface: PublicContract = contract,
): string[] {
  const problems: string[] = [];
  const served = Object.keys(schema.shape).sort();
  const listed = [
    ...surface.status.required,
    ...Object.keys(surface.status.optional),
  ].sort();
  for (const key of served)
    if (!listed.includes(key))
      problems.push(
        `/status.json key ${key} is not in docs/public-contract.json`,
      );
  for (const key of listed)
    if (!served.includes(key))
      problems.push(
        `docs/public-contract.json lists ${key}, which the app never serves`,
      );
  for (const [key, spec] of Object.entries(surface.status.optional))
    for (const value of spec.allowed)
      if (schema.shape[key] && !schema.shape[key].safeParse(value).success)
        problems.push(`/status.json ${key} cannot be ${JSON.stringify(value)}`);
  return problems;
}
