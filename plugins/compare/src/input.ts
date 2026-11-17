import { offerCohortInputSchema } from "@openplans/plugin-sdk";

export { offerCohortInputSchema as marketInput };

export function marketQuery(query: Record<string, string>) {
  const input: Record<string, unknown> = { ...query };
  for (const key of ["year", "age", "evidence_page"]) {
    if (input[key] !== undefined) {
      if (!/^\d+$/.test(String(input[key]))) throw new Error("INVALID_INPUT");
      input[key] = Number(input[key]);
    }
  }
  if (typeof input.members === "string") {
    try {
      input.members = JSON.parse(input.members);
    } catch {
      throw new Error("INVALID_INPUT");
    }
  }
  if (input.tobacco === "false") input.tobacco = false;
  return offerCohortInputSchema.parse(input);
}
