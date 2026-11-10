/** Medicare plan identity: contract (H/R/S/E + 4 digits), 3-digit plan, segment (0-999). */
export interface PlanKey {
  contractId: string;
  planId: string;
  segmentId: string;
}

export type ContractKind =
  "local_ma" | "regional_ppo" | "pdp" | "employer_direct";

const CONTRACT = /^[EHRS]\d{4}$/;

/** Parses `H0028-042-0` (native) and `H0028_042_0` (Landscape spelling). */
export function parsePlanKey(value: unknown): PlanKey | null {
  if (typeof value !== "string") return null;
  const match = /^([EHRS]\d{4})[-_](\d{3})[-_](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  return {
    contractId: match[1]!,
    planId: match[2]!,
    segmentId: String(Number(match[3]!)),
  };
}

export function formatPlanKey(key: PlanKey): string {
  return `${key.contractId}-${key.planId}-${key.segmentId}`;
}

/** Normalizes published contract, plan and segment cells; throws on anything malformed. */
export function planKeyFromParts(
  contract: string | undefined,
  plan: string | undefined,
  segment: string | undefined,
): PlanKey {
  const contractId = (contract ?? "").trim();
  const planRaw = (plan ?? "").trim();
  const segmentRaw = (segment ?? "").trim();
  if (!CONTRACT.test(contractId))
    throw new Error("Invalid Medicare contract ID");
  if (!/^\d{1,3}$/.test(planRaw)) throw new Error("Invalid Medicare plan ID");
  if (!/^\d{1,3}$/.test(segmentRaw))
    throw new Error("Invalid Medicare segment ID");
  return {
    contractId,
    planId: planRaw.padStart(3, "0"),
    segmentId: String(Number(segmentRaw)),
  };
}

export function contractKind(contractId: string): ContractKind {
  switch (contractId[0]) {
    case "H":
      return "local_ma";
    case "R":
      return "regional_ppo";
    case "S":
      return "pdp";
    case "E":
      return "employer_direct";
    default:
      throw new Error("Invalid Medicare contract ID");
  }
}

/** Employer group (EGHP) plans use plan IDs 800-999; they are out of scope for individual shopping. */
export function isEmployerGroupPlan(planId: string): boolean {
  return Number(planId) >= 800;
}
