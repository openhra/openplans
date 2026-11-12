import { parseEhbFraction } from "../domain/subsidy/ehb.js";

const columns = {
  EHBPercentTotalPremium: ["ehbpercenttotalpremium", "ehbpercentpremium"],
  EHBPediatricDentalApportionmentQuantity: [
    "ehbpediatricdentalapportionmentquantity",
  ],
};

/** Keep publication aliases; canonical allocation fields contain fractions or unknown. */
export function normalizeEhbColumns(raw: Record<string, string>) {
  const result = { ...raw };
  for (const [canonical, aliases] of Object.entries(columns)) {
    const values = Object.entries(raw)
      .filter(([key]) =>
        aliases.includes(key.replace(/[^a-z0-9]/gi, "").toLowerCase()),
      )
      .map(([, value]) => parseEhbFraction(value));
    if (values.length)
      result[canonical] = values.every(
        (value) => value !== null && value === values[0],
      )
        ? values[0]!
        : "";
  }
  return result;
}
