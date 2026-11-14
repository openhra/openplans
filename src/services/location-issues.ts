import type { SqlSession } from "../db/database.js";
import type { resolveLocation } from "../api/repository.js";
import { activeCatalog, countyState } from "../api/repository.js";
import { requestReads } from "./request-reads.js";
import type { RequestReads } from "./request-reads.js";
import {
  refusedTemplatePlans,
  stateCatalog,
  stateRatingArea,
} from "../ingest/state/catalog.js";

type Location = Awaited<ReturnType<typeof resolveLocation>>;

/**
 * Why a plan list for this location may be missing plans, as reason codes from
 * `src/api/reason-codes.ts`. Plan search and quotes list these, so a shorter or empty list is
 * never passed off as the whole answer.
 */
export async function locationIssues(
  db: SqlSession,
  location: Location,
  year: number,
  coverage: "medical" | "dental" = "medical",
  reads: RequestReads = requestReads(db),
): Promise<string[]> {
  if (location.status === "unknown") return ["zip_not_in_loaded_geography"];
  if (location.status !== "available" || !location.county) return [];
  const county = location.county;
  const state = countyState(county);
  if (state === "NY" || state === "VT") {
    if (!(await stateCatalog(db, year, state)).length)
      return ["state_catalog_not_loaded"];
    const area = stateRatingArea(state, year, county);
    if (!area || coverage !== "medical") return [];
    // A refused issuer template leaves that issuer's plans out of the list.
    const refused = await refusedTemplatePlans(
      db,
      state,
      year,
      area.rating_area_id,
    );
    return [...new Set(refused.map((plan) => plan.reason))].sort();
  }
  // No active catalog for the county's state and year: an empty list is not the market's answer.
  if (!(await activeCatalog(db, year, state)).rows.length)
    return ["state_catalog_not_loaded"];
  // Without a ZIP, a plan that serves only part of the county is left out of the list.
  if (
    !location.zip &&
    (await reads.countyRows(county, year)).some(
      (plan) =>
        plan.zip_restricted && plan.dental_only === (coverage === "dental"),
    )
  )
    return ["zip_limited_service_area"];
  return [];
}
