import type { SqlSession } from "../db/database.js";
import { providerParticipation } from "../domain/providers/repository.js";
import { passThrough } from "../plugins/sources/passthrough.js";
import type { CmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { providerAvailability } from "../domain/providers/availability.js";
import { zipCentroid } from "../domain/geo/index.js";
import {
  searchProviders,
  providerDetail,
  taxonomyLoaded,
} from "../api/provider-repository.js";
import type { ProviderSearch } from "../api/provider-repository.js";
import { findPlan, variantExists } from "../api/repository.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";
import { STATE_FIPS } from "../ingest/geo/states.js";

export function npi(value: unknown): string {
  if (typeof value !== "string" || !/^[12][0-9]{9}$/.test(value))
    return v.fail("npi");
  return value;
}
export function providerYear(value: unknown): number {
  const result = v.year(value);
  return result <= 2100 ? result : v.fail("year");
}
function number(
  value: string | undefined,
  field: string,
  min: number,
  max: number,
) {
  if (value === undefined || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    return v.fail(field);
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max
    ? result
    : v.fail(field);
}
export async function findProviders(
  db: SqlSession,
  params: Record<string, string>,
) {
  const q: ProviderSearch = { page: v.page(params.page) };
  if (q.page > Math.floor(Number.MAX_SAFE_INTEGER / 50)) return v.fail("page");
  if (params.plan_id !== undefined) {
    const id = v.planId(params.plan_id);
    q.plan = id.base;
    q.year = providerYear(params.year);
    const plan = await findPlan(db, id.base, q.year);
    if (!plan || (id.variant && !(await variantExists(db, plan, id.full))))
      throw new ReadError({ code: "PLAN_NOT_FOUND" });
  } else if (params.year !== undefined) providerYear(params.year);
  if (params.taxonomy !== undefined && params.specialty !== undefined)
    return v.fail("taxonomy", "TAXONOMY_OR_SPECIALTY_REQUIRED");
  for (const field of ["taxonomy", "specialty", "name"] as const) {
    if (params[field] !== undefined) {
      if (!params[field]!.trim() || params[field]!.length > 200)
        return v.fail(field);
      q[field] = params[field]!.trim();
    }
  }
  if (q.taxonomy && !/^[A-Z0-9]{10}$/.test(q.taxonomy))
    return v.fail("taxonomy");
  if (q.specialty && /^[A-Z0-9]{10}$/.test(q.specialty)) {
    q.taxonomy = q.specialty;
    delete q.specialty;
  }
  if (q.specialty && !(await taxonomyLoaded(db)))
    throw new ReadError({
      code: "unsupported_without_taxonomy",
      field: "specialty",
      message:
        "Specialty name search requires the optional NUCC taxonomy import; search by taxonomy code instead.",
    });
  if (params.type !== undefined) {
    const type = params.type.toUpperCase();
    if (!["INDIVIDUAL", "FACILITY", "GROUP"].includes(type))
      return v.fail("type");
    q.type = type as ProviderSearch["type"];
  }
  if (
    params.zip !== undefined &&
    (params.lat !== undefined || params.lon !== undefined)
  )
    return v.fail("location");
  if (params.zip !== undefined) {
    const zip = v.zip(params.zip),
      centroid = await zipCentroid(db, zip);
    if (!centroid)
      return {
        status: "unknown",
        reason: "zip_centroid_unavailable",
        providers: [],
        total: 0,
        page: q.page,
        page_size: 50,
        next_page: null,
        meta: { unlocated: null, origin: null },
      };
    q.origin = {
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      method: centroid.method,
      snapshot_id: centroid.snapshot_id,
    };
  } else if (params.lat !== undefined || params.lon !== undefined) {
    q.origin = {
      latitude: number(params.lat, "lat", -90, 90),
      longitude: number(params.lon, "lon", -180, 180),
      method: "supplied_coordinates",
    };
  }
  if (params.radius_miles !== undefined) {
    q.radius = number(params.radius_miles, "radius_miles", 0, 500);
    if (!q.origin) return v.fail("location", "LOCATION_REQUIRED");
  }
  const coverage = q.plan
    ? ((
        await providerAvailability(db, {
          issuer: q.plan.slice(0, 5),
          state: q.plan.slice(5, 7),
          year: q.year!,
        })
      )[0] ?? null)
    : null;
  if (coverage?.status === "access_denied")
    return {
      status: "unknown",
      reason: "source_access_denied",
      provider_coverage: coverage,
      providers: [],
      total: 0,
      page: q.page,
      page_size: 50,
      next_page: null,
      meta: { unlocated: null, origin: q.origin ?? null },
    };
  function providerSearchStatus() {
    if (q.plan) {
      if (coverage?.status === "complete") {
        return "available";
      } else {
        return "unknown";
      }
    } else {
      return "available";
    }
  }
  const found = await searchProviders(db, q);
  // An empty identity search means "nobody matched" only where an NPPES release is loaded.
  const unloaded =
    !q.plan &&
    found.providers.length === 0 &&
    !(await registryLoaded(db, params.zip));
  return {
    warnings:
      q.plan && coverage?.status !== "complete" ? ["SOURCE_INCOMPLETE"] : [],
    status: unloaded ? "unknown" : providerSearchStatus(),
    ...(unloaded ? { reason: "provider_registry_not_loaded" } : {}),
    requested_plan_id: params.plan_id ?? null,
    base_hios_id: q.plan ?? null,
    plan_year: q.year ?? null,
    participation: q.plan ? undefined : "not_evaluated",
    provider_coverage: coverage,
    ...found,
  };
}

/**
 * Whether an ACTIVE full NPPES release covers the ZIP's state (any state of a ZIP that crosses a
 * state line), or any state when the search has no ZIP.
 */
export async function registryLoaded(db: SqlSession, zip?: string) {
  const states = zip
    ? (
        await db.query<{ fips: string }>(
          "SELECT DISTINCT left(county_fips, 2) AS fips FROM zcta_county WHERE zcta=$1",
          [zip],
        )
      ).rows
        .map((r) => FIPS_STATE.get(r.fips))
        .filter((s): s is string => Boolean(s))
    : null;
  if (states && !states.length) return false;
  return (
    (
      await db.query(
        `SELECT 1 FROM npi_import_run r JOIN snapshot s USING(snapshot_id)
         WHERE s.validation_state='ACTIVE' AND r.kind='full'
         AND ($1::text[] IS NULL OR r.state_filter = ANY($1::text[])) LIMIT 1`,
        [states],
      )
    ).rows.length > 0
  );
}
const FIPS_STATE = new Map(
  Object.entries(STATE_FIPS).map(([state, fips]) => [fips, state]),
);

export async function getProvider(
  db: SqlSession,
  value: unknown,
  year?: string,
) {
  const result = await providerDetail(
    db,
    npi(value),
    year === undefined ? undefined : providerYear(year),
  );
  if (!result) throw new ReadError({ code: "PROVIDER_NOT_FOUND" });
  return result;
}
/** `cms` is the per-request CMS API fallback context; absent unless the operator enabled it. */
export async function checkProviderNetwork(
  db: SqlSession,
  plan: unknown,
  code: unknown,
  year: unknown,
  cms?: CmsFallbackContext,
) {
  const answer = await providerParticipation(
    db,
    v.planId(plan).full,
    npi(code),
    providerYear(year),
  );
  return cms
    ? (await passThrough.apply("provider", [answer], cms))[0]!
    : answer;
}

export async function checkProviderNetworks(
  db: SqlSession,
  value: unknown,
  cms?: CmsFallbackContext,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return v.fail("body");
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.plan_ids) ||
    body.plan_ids.length < 1 ||
    body.plan_ids.length > 50
  )
    return v.fail("plan_ids");
  if (
    !Array.isArray(body.npis) ||
    body.npis.length < 1 ||
    body.npis.length > 100
  )
    return v.fail("npis");
  if (body.plan_ids.length * body.npis.length > 1000)
    return v.fail("body", "TOO_MANY_PAIRS");
  const plans = body.plan_ids.map((id) => v.planId(id).full),
    npis = body.npis.map(npi);
  if (new Set(plans).size !== plans.length)
    return v.fail("plan_ids", "DUPLICATE_PLAN_ID");
  if (new Set(npis).size !== npis.length)
    return v.fail("npis", "DUPLICATE_NPI");
  if (typeof body.year !== "number" || !Number.isInteger(body.year))
    return v.fail("year");
  const year = providerYear(String(body.year)),
    results = [];
  for (const plan of plans)
    for (const code of npis)
      results.push(await providerParticipation(db, plan, code, year));
  return {
    results: cms ? await passThrough.apply("provider", results, cms) : results,
  };
}
