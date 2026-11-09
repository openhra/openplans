/** Explicit publisher variant selection only; household eligibility is never evaluated. */
export const CSR_ALIASES: Readonly<Record<string, string>> = {
  off_exchange: "00",
  standard: "01",
  zero: "02",
  limited: "03",
  csr73: "04",
  csr87: "05",
  csr94: "06",
};
export function csrSuffix(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid CSR variant");
  if (/^0[0-6]$/.test(value)) return value;
  const suffix = Object.hasOwn(CSR_ALIASES, value)
    ? CSR_ALIASES[value]
    : undefined;
  if (!suffix) throw new Error("Invalid CSR variant");
  return suffix;
}
export function selectedVariant(
  base: string,
  explicitSuffix?: string,
  requestedVariant?: string | null,
): string {
  if (
    explicitSuffix !== undefined &&
    requestedVariant != null &&
    explicitSuffix !== requestedVariant
  )
    throw new Error("Conflicting CSR variants");
  return `${base}-${explicitSuffix ?? requestedVariant ?? "01"}`;
}
export interface PublishedAmount {
  raw: string;
  cents: number | null;
  status: "available" | "unknown";
}
/** Accumulators may explicitly say per person/group. Conditions stay raw, with no parsed price. */
export function publishedAmount(raw: string): PublishedAmount {
  const match =
    /^\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s+per (?:person|group))?$/.exec(
      raw.trim(),
    );
  const value = match
    ? Number(match[1]!.replaceAll(",", "")) * 100 +
      Number((match[2] ?? "").padEnd(2, "0"))
    : null;
  const cents = value !== null && Number.isSafeInteger(value) ? value : null;
  return { raw, cents, status: cents === null ? "unknown" : "available" };
}
export function attributeCostSharing(raw: Record<string, string>) {
  const entries = Object.entries(raw);
  const project = (test: (key: string) => boolean) =>
    Object.fromEntries(
      entries
        .filter(([key]) => test(key))
        .map(([key, value]) => [key, publishedAmount(value)]),
    );
  return {
    deductibles: project(
      (key) => /^[MDT]EHBDed/.test(key) && !key.endsWith("Coinsurance"),
    ),
    moop: project((key) => /^[MDT]EHB.*MOOP$/.test(key)),
    medical_drug_deductibles_integrated:
      raw.MedicalDrugDeductiblesIntegrated ?? null,
    medical_drug_moop_integrated:
      raw.MedicalDrugMaximumOutofPocketIntegrated ?? null,
    coinsurance_raw: Object.fromEntries(
      entries.filter(([key]) => /^[MDT]EHBDed.*Coinsurance$/.test(key)),
    ),
  };
}
