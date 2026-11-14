import type { SqlSession } from "../db/database.js";
import type { CostSharingOptions, Plan } from "../api/repository.js";
import { countyPlans, planCostSharing } from "../api/repository.js";
import { plansForCounty } from "../ingest/puf/import-repository.js";

const part = (value: unknown) =>
  value === undefined ? "-" : JSON.stringify(value);

/**
 * Reads a request would otherwise repeat for each plan it rates: the county catalog, the plans
 * offered from it, and each plan's cost sharing. Create one per request with `requestReads(db)`
 * and pass it down. Nothing keeps it after the request ends, so no request sees another
 * request's reads.
 */
export function requestReads(db: SqlSession) {
  const rows = new Map<string, ReturnType<typeof plansForCounty>>();
  const offered = new Map<string, ReturnType<typeof countyPlans>>();
  const sharing = new WeakMap<
    object,
    Map<string, ReturnType<typeof planCostSharing>>
  >();
  function once<T>(map: Map<string, T>, key: string, read: () => T): T {
    let value = map.get(key);
    if (value === undefined) map.set(key, (value = read()));
    return value;
  }
  /** plansForCounty(db, county, year, "Individual"), read once. */
  const countyRows = (county: string, year: number) =>
    once(rows, `${county}|${year}`, () =>
      plansForCounty(db, county, year, "Individual"),
    );
  return {
    countyRows,
    /** countyPlans(db, county, year, zip, coverage), read once. */
    countyPlans: (
      county: string,
      year: number,
      zip?: string,
      coverage: "medical" | "dental" = "medical",
    ) =>
      once(offered, [county, year, zip, coverage].map(part).join("|"), () =>
        countyPlans(db, county, year, zip, coverage, () =>
          countyRows(county, year),
        ),
      ),
    /** planCostSharing(db, plan, options), read once per plan object and options. */
    costSharing: (plan: Plan, options: CostSharingOptions = {}) => {
      let byOptions = sharing.get(plan);
      if (!byOptions) sharing.set(plan, (byOptions = new Map()));
      const key = [
        options.csrVariant,
        options.requestedVariant,
        options.allBenefits,
      ]
        .map(part)
        .join("|");
      return once(byOptions, key, () => planCostSharing(db, plan, options));
    },
  };
}
export type RequestReads = ReturnType<typeof requestReads>;
