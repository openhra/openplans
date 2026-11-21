import { FAMILY_RATE_FIELDS } from "../../src/domain/rating/types.js";
import type { ImportKind } from "../../src/ingest/puf/import-source.js";

/** Generated synthetic CMS-shaped files. No source rows or real prices are copied. */
export function syntheticPackagePufs(
  poisoned = false,
): Record<ImportKind, string> {
  const base = "99999TX0010001";
  const common = { BusinessYear: "2026", StateCode: "TX", IssuerId: "99999" };
  const market = { MarketCoverage: "Individual", DentalOnlyPlan: "No" };
  const csv = (rows: Record<string, string>[]) => {
    const keys = Object.keys(rows[0]!);
    const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return (
      keys.map(cell).join(",") +
      "\n" +
      rows
        .map((row) => keys.map((key) => cell(row[key]!)).join(","))
        .join("\n") +
      "\n"
    );
  };
  return {
    "plan-attributes": csv([
      {
        ...common,
        ...market,
        StandardComponentId: base,
        PlanId: `${base}-01`,
        MetalLevel: "Silver",
        NetworkId: "SYN",
        ServiceAreaId: "SYN",
        PlanMarketingName: "Synthetic package plan",
        IssuerMarketPlaceMarketingName: "Synthetic issuer",
        QHPNonQHPTypeId: "On the Exchange",
      },
    ]),
    "service-area": csv([
      {
        ...common,
        ...market,
        ServiceAreaId: "SYN",
        ServiceAreaName: "Synthetic area",
        CoverEntireState: "No",
        County: "48201",
        PartialCounty: "No",
        ZipCodes: "",
      },
    ]),
    network: csv([
      {
        ...common,
        ...market,
        NetworkId: "SYN",
        NetworkName: "Synthetic network",
        NetworkURL: "https://feed.synthetic.test/network",
      },
    ]),
    "business-rules": csv([
      {
        ...common,
        ...market,
        ProductId: "99999TX001",
        StandardComponentId: base,
      },
    ]),
    rate: csv(
      [
        "0-14",
        ...Array.from({ length: 49 }, (_, at) => String(at + 15)),
        "64 and over",
      ].map((Age) => ({
        ...common,
        PlanId: base,
        RatingAreaId: "Rating Area 10",
        Age,
        Tobacco: "No Preference",
        RateEffectiveDate: "2026-01-01",
        RateExpirationDate: "2026-12-31",
        IndividualRate: poisoned ? "-1.00" : "123.45",
        IndividualTobaccoRate: "",
        ...Object.fromEntries(FAMILY_RATE_FIELDS.map((field) => [field, ""])),
      })),
    ),
    "benefits-and-cost-sharing": csv([
      {
        ...common,
        StandardComponentId: base,
        PlanId: `${base}-01`,
        BenefitName: "Synthetic benefit",
        CopayInnTier1: "",
        CopayInnTier2: "",
        CopayOutofNet: "",
        CoinsInnTier1: "",
        CoinsInnTier2: "",
        CoinsOutofNet: "",
      },
    ]),
  };
}
