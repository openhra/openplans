import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../../db/database.js";
import {
  RADIUS_NOT_CHECKED,
  searchProviderLocations,
  searchUnlocatedInState,
  taxonomyLoaded,
  taxonomyRelation,
} from "../../api/provider-repository.js";
import type {
  UnlocatedStatePage,
  UnlocatedStateSearch,
} from "../../api/provider-repository.js";
import * as v from "../../api/validation.js";
import { zipCentroid } from "../../domain/geo/index.js";
import { zipToCounties } from "../../ingest/geo/repository.js";
import { STATE_FIPS } from "../../ingest/geo/states.js";

interface ProviderAddress extends Record<string, unknown> {
  distance_miles?: number | null;
}
interface ProviderTaxonomy extends Record<string, unknown> {
  code?: string;
  taxonomy_status?: string;
  taxonomy_display_name?: string | null;
  specialization?: string | null;
  classification?: string | null;
}
interface ProviderRecord extends Record<string, unknown> {
  npi?: string | null;
  addresses: ProviderAddress[];
  taxonomy?: ProviderTaxonomy[];
  specialties?: string[];
  warnings?: string[];
  distance_miles?: number | null;
  location_check?: string;
}
interface ProviderSearchResponse {
  providers: ProviderRecord[];
  status?: string;
  reason?: string;
  warnings?: string[];
  next_page?: number | null;
  meta?: { origin?: { method?: string } | null; unlocated?: number | null };
}
interface ProviderDetailResponse {
  identity: ProviderRecord | null;
  issuer_records: ProviderRecord[];
  plan_participations: unknown;
  provider_coverage: unknown;
}
type ProviderLocation = ReturnType<typeof providerLocation>;
type ProviderTrace = ReturnType<typeof providerTrace>;
const PROVIDER_GAPS = [
  "vendor_provider_and_specialty_ids_unavailable",
  "provider_metadata_limited_to_native_evidence",
  "vendor_state_ids_unavailable",
  "provider_address_membership_not_evaluated",
];
const header = (
  c: { header(name: string, value: string): void },
  reasons: Iterable<string>,
) => c.header("x-openplans-gaps", [...new Set(reasons)].join(", "));
function paging(body: Record<string, unknown>, fallback = 10) {
  const page = body.page ?? 1,
    size = body.per_page ?? fallback;
  if (
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 1000 ||
    !Number.isSafeInteger(page * size)
  )
    return v.fail("page");
  return { start: (page - 1) * size, size };
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    return v.fail(field);
  return value.trim();
}
const addressKey = (a: ProviderAddress) =>
  JSON.stringify(
    [
      a.line_1 ?? a.address,
      a.line_2 ?? a.address_2,
      a.city,
      a.state,
      a.zip ?? a.zip5,
    ].map((value) =>
      String(value ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase(),
    ),
  );

function primaryTaxonomy(row: ProviderRecord): ProviderTaxonomy | undefined {
  return row.taxonomy?.find((t) => t.is_primary) ?? row.taxonomy?.[0];
}
function taxonomyName(t: ProviderTaxonomy | undefined) {
  return t?.taxonomy_status === "known"
    ? (t.taxonomy_display_name ?? null)
    : null;
}
function taxonomyGaps(rows: ProviderRecord[]) {
  return rows.some((row) => !taxonomyName(primaryTaxonomy(row)))
    ? ["specialty_descriptions_unavailable"]
    : [];
}

const STATE_BY_FIPS = new Map(
  Object.entries(STATE_FIPS).map(([state, fips]) => [fips, state]),
);
/** States of a ZIP from loaded Census/GeoNames/cached CMS geography; never a live call. */
async function zipStates(db: SqlSession, zip: string): Promise<string[]> {
  const result = await zipToCounties(db, zip, { allowCmsLive: false });
  return [
    ...new Set(
      result.counties.flatMap((county) => {
        const state = STATE_BY_FIPS.get(county.county_fips.slice(0, 2));
        return state ? [state] : [];
      }),
    ),
  ];
}
/** Name searches only: a statewide list without a name would not answer a local query. */
async function unlocatedInState(
  db: SqlSession,
  zip: string,
  filters: Omit<UnlocatedStateSearch, "states">,
  page: UnlocatedStatePage,
) {
  const states = await zipStates(db, zip);
  return searchUnlocatedInState(db, { ...filters, states }, page);
}

function providerTrace(record: ProviderRecord, address: ProviderAddress) {
  return {
    record_id: record.record_id,
    snapshot_id: record.snapshot_id,
    source_record: record.source_record ?? null,
    source_set_id: record.source_set_id ?? null,
    raw_snapshot_id: record.raw_snapshot_id ?? null,
    source_url: record.source_url ?? null,
    nppes_snapshot_id: record.nppes_snapshot_id ?? null,
    source_updated_at: record.source_updated_at ?? null,
    retrieved_at: record.retrieved_at ?? null,
    publisher_updated_at: record.publisher_updated_at ?? null,
    address,
    participation: record.participation ?? "not_evaluated",
    participation_scope: record.participation_scope ?? null,
    evidence: record.evidence ?? record.plan_participations ?? [],
    ...(record.location_check ? { location_check: record.location_check } : {}),
  };
}
function providerLocation(
  record: ProviderRecord,
  address: ProviderAddress,
  trace: ProviderTrace,
) {
  const name = (
    record.name && typeof record.name === "object" ? record.name : {}
  ) as Record<string, unknown>;
  const taxonomy = primaryTaxonomy(record),
    known = taxonomy?.taxonomy_status === "known";
  const individual = record.type
    ? record.type === "INDIVIDUAL"
    : record.entity_type === "1";
  const first = record.first_name ?? name.first ?? null,
    last = record.last_name ?? name.last ?? null;
  const organization =
    record.organization_name ??
    record.facility_name ??
    record.group_name ??
    null;
  return {
    id: record.npi ? Number(record.npi) : null,
    npis: record.npi ? [Number(record.npi)] : [],
    type: individual ? "individual" : "organization",
    first_name: first,
    last_name: last,
    middle_name: record.middle_name ?? name.middle ?? null,
    organization_name: organization,
    presentation_name: individual
      ? [first, last].filter(Boolean).join(" ") || null
      : organization,
    doing_business_as_name: null,
    gender: null,
    suffix: record.name_suffix ?? null,
    title: record.name_prefix ?? null,
    credentials: record.credential ? [record.credential] : [],
    specialty:
      record.specialties?.join(", ") ||
      taxonomyName(taxonomy) ||
      taxonomy?.code ||
      null,
    npi_specialty: {
      id: taxonomy?.code ?? null,
      taxonomy_code: taxonomy?.code ?? null,
      name: taxonomyName(taxonomy),
      display_name: taxonomyName(taxonomy),
      taxonomy_source: known ? "nucc" : "nppes_code_only",
      sub_specialty: known ? (taxonomy.specialization ?? null) : null,
    },
    city: address.city ?? null,
    state: address.state ?? null,
    state_id: null,
    street_line_1: address.line_1 ?? address.address ?? null,
    street_line_2: address.line_2 ?? address.address_2 ?? null,
    zip_code: address.zip ?? address.zip5 ?? null,
    phone: address.phone ?? null,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
    distance_miles: address.distance_miles ?? record.distance_miles ?? null,
    provenance: [trace],
  };
}

/** Dedupe the wire location, retaining every contributing record and edge separately. */
export function mapProviders(records: ProviderRecord[]) {
  const merged = new Map<string, ProviderLocation>();
  for (const record of records)
    for (const address of record.addresses.length ? record.addresses : [{}]) {
      const key = `${record.npi ?? `${record.snapshot_id}:${record.record_id}`}|${addressKey(address)}`;
      const existing = merged.get(key);
      const trace = providerTrace(record, address);
      if (existing) {
        existing.provenance.push(trace);
        continue;
      }
      merged.set(key, providerLocation(record, address, trace));
    }
  return [...merged.values()];
}

export function providerDetailResponse(provider: Record<string, unknown>) {
  return {
    ...provider,
    // Record-level participation does not crosswalk external networks or
    // establish address-level membership. The native trace remains available.
    networks: [],
    network_ids: [],
    hios_ids: [],
  };
}

const individualFilter = (body: Record<string, unknown>) =>
  body.type === "individual" ? ("INDIVIDUAL" as const) : undefined;

export function providerCompatRoutes(db: SqlSession, native: Hono) {
  const app = new Hono();
  app.post(
    "/providers/search",
    bodyLimit({
      maxSize: 65_536,
      onError: (c) => c.json({ error: "Request too large" }, 400),
    }),
    async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return v.fail("body");
      if (!body.zip_code) return c.json({ error: "zip_code required" }, 400);
      const zip = v.zip(body.zip_code),
        { start, size } = paging(body);
      const params = new URLSearchParams({ zip });
      const reasons = new Set(PROVIDER_GAPS);
      // ZIP-only searches must remain local, even when no explicit radius is sent.
      const radius = body.radius ?? 25;
      if (
        typeof radius !== "number" ||
        !Number.isFinite(radius) ||
        radius < 0 ||
        radius > 500
      )
        return v.fail("radius");
      params.set("radius_miles", String(radius));
      if (body.radius === undefined)
        reasons.add("provider_radius_defaulted_to_25_miles");
      if (body.search_term !== undefined)
        params.set("name", text(body.search_term, "search_term"));
      const name = params.get("name") ?? undefined;
      if (body.plan_id !== undefined) {
        params.set("plan_id", v.planId(body.plan_id).full);
        params.set("year", String(v.year(String(body.year ?? 2026))));
        if (body.year === undefined) reasons.add("plan_year_defaulted_to_2026");
      } else if (body.year !== undefined) v.year(String(body.year));
      if (body.specialty !== undefined && body.taxonomy !== undefined)
        return v.fail("specialty");
      if (body.taxonomy !== undefined || body.specialty !== undefined) {
        const value = text(body.taxonomy ?? body.specialty, "specialty");
        params.set(
          body.taxonomy !== undefined || /^[A-Z0-9]{10}$/.test(value)
            ? "taxonomy"
            : "specialty",
          value,
        );
      }
      if (
        body.type !== undefined &&
        (typeof body.type !== "string" ||
          !["individual", "organization"].includes(body.type))
      )
        return v.fail("type");
      if (body.type === "individual") params.set("type", "individual");
      if (
        body.sort !== undefined &&
        (typeof body.sort !== "string" ||
          !["distance", "name", "-distance", "-name"].includes(body.sort))
      )
        return v.fail("sort");
      if (
        body.network_ids !== undefined &&
        (!Array.isArray(body.network_ids) ||
          body.network_ids.some((id: unknown) => !Number.isSafeInteger(id)))
      )
        return v.fail("network_ids");
      // Identity searches can count and page normalized locations in one SQL read.
      // Keep plan records and name collation on the native mapping path.
      if (
        !body.plan_id &&
        body.type !== "organization" &&
        !body.sort?.endsWith("name") &&
        body.carrier_id === undefined &&
        !body.network_ids?.length
      ) {
        const taxonomy = params.get("taxonomy") ?? undefined,
          specialty = params.get("specialty") ?? undefined;
        if (taxonomy && !/^[A-Z0-9]{10}$/.test(taxonomy))
          return v.fail("taxonomy");
        if (!specialty || (await taxonomyLoaded(db))) {
          const origin = await zipCentroid(db, zip);
          if (origin) {
            const result = await searchProviderLocations(
              db,
              {
                page: 1,
                radius,
                origin: {
                  latitude: origin.latitude,
                  longitude: origin.longitude,
                  method: origin.method,
                  snapshot_id: origin.snapshot_id,
                },
                taxonomy,
                specialty,
                name: params.get("name") ?? undefined,
                type: body.type === "individual" ? "INDIVIDUAL" : undefined,
              },
              { offset: start, size, reverse: body.sort === "-distance" },
            );
            if (origin.method === "zcta_centroid")
              reasons.add("provider_origin_zip_centroid_approximate");
            if (result.unlocated)
              reasons.add("provider_unlocated_addresses_excluded");
            if (result.approximate)
              reasons.add("provider_location_zip_centroid_approximate");
            if (result.taxonomy_unknown)
              reasons.add("specialty_descriptions_unavailable");
            const providers = mapProviders(result.providers);
            providers.sort(
              (a, b) =>
                (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity),
            );
            if (body.sort === "-distance") providers.reverse();
            let total = result.total;
            // Located rows page first; unlocated in-state name matches follow them.
            if (name && result.unlocated) {
              const fallback = await unlocatedInState(
                db,
                zip,
                { name, taxonomy, specialty, type: individualFilter(body) },
                {
                  offset: Math.max(0, start - result.total),
                  size: size - providers.length,
                },
              );
              total += fallback.total;
              if (fallback.total) reasons.add(RADIUS_NOT_CHECKED);
              providers.push(...mapProviders(fallback.providers));
            }
            header(c, reasons);
            return c.json({
              meta: { total },
              providers,
              states: [],
            });
          }
        }
      }
      const rows: ProviderRecord[] = [];
      let origin: { method?: string } | null = null,
        unlocated = false,
        originMissing = false;
      for (let page = 1; ; page++) {
        params.set("page", String(page));
        const response = await native.request(`/providers?${params}`);
        if (!response.ok) return response;
        const result = (await response.json()) as ProviderSearchResponse;
        origin = result.meta?.origin ?? null;
        if (origin?.method === "zcta_centroid")
          reasons.add("provider_origin_zip_centroid_approximate");
        if (result.status === "unknown")
          reasons.add(result.reason ?? "provider_source_incomplete");
        if (result.warnings?.length) reasons.add("provider_source_incomplete");
        if (result.meta?.unlocated) {
          unlocated = true;
          reasons.add("provider_unlocated_addresses_excluded");
        }
        if (result.reason === "zip_centroid_unavailable") originMissing = true;
        if (
          result.providers.some((r: ProviderRecord) =>
            r.warnings?.includes("UNRESOLVED_NETWORK_TIER"),
          )
        )
          reasons.add("provider_unresolved_network_tier");
        rows.push(...result.providers);
        if (!result.next_page) break;
      }
      // Plan searches keep issuer-record semantics; identity name searches may add
      // in-state NPPES locations that no radius could evaluate.
      if (name && (unlocated || originMissing) && !body.plan_id) {
        const fallback = await unlocatedInState(
          db,
          zip,
          {
            name,
            taxonomy: params.get("taxonomy") ?? undefined,
            specialty: params.get("specialty") ?? undefined,
            type: individualFilter(body),
            includeLocated: originMissing,
          },
          { offset: 0 },
        );
        if (fallback.total) reasons.add(RADIUS_NOT_CHECKED);
        rows.push(...fallback.providers);
      }
      if (
        rows.some((r) =>
          r.addresses.some(
            (a: ProviderAddress) =>
              a.method === "zcta_centroid" || a.precision === "approximate",
          ),
        )
      )
        reasons.add("provider_location_zip_centroid_approximate");
      let providers = mapProviders(rows).filter(
        (p) => !body.type || p.type === body.type,
      );
      for (const reason of taxonomyGaps(rows)) reasons.add(reason);
      if (body.carrier_id !== undefined || body.network_ids?.length) {
        // No vendor ID crosswalk exists. Do not silently ignore a coverage filter.
        reasons.add("vendor_carrier_or_network_filter_unsupported");
        providers = [];
      }
      if (body.sort?.endsWith("name"))
        providers.sort((a, b) =>
          String(a.presentation_name ?? "").localeCompare(
            String(b.presentation_name ?? ""),
          ),
        );
      else
        providers.sort(
          (a, b) =>
            (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity),
        );
      if (body.sort?.startsWith("-")) providers.reverse();
      header(c, reasons);
      return c.json({
        meta: { total: providers.length },
        providers: providers.slice(start, start + size),
        states: [],
      });
    },
  );
  app.get("/providers/:npi", async (c) => {
    const params = new URLSearchParams();
    if (c.req.query("year")) params.set("year", c.req.query("year")!);
    const response = await native.request(
      `/providers/${encodeURIComponent(c.req.param("npi"))}?${params}`,
    );
    if (!response.ok) return response;
    const result = (await response.json()) as ProviderDetailResponse,
      identity = (result.identity ?? {}) as ProviderRecord;
    const rows: ProviderRecord[] = result.issuer_records.map(
      (r: ProviderRecord) => ({
        ...identity,
        ...r,
        nppes_snapshot_id: identity.snapshot_id ?? null,
        taxonomy: identity.taxonomy,
        specialties: [r.speciality ?? r.specialty]
          .flat()
          .filter((s: unknown) => typeof s === "string"),
      }),
    );
    if (identity.npi)
      rows.push({
        ...identity,
        record_id: identity.npi,
        type: identity.entity_type === "1" ? "INDIVIDUAL" : "GROUP",
      });
    const locations = mapProviders(rows);
    header(c, [
      ...PROVIDER_GAPS,
      ...taxonomyGaps(rows),
      "provider_detail_coordinates_unavailable",
      "provider_network_crosswalk_unavailable",
    ]);
    return c.json({
      provider: providerDetailResponse({
        ...locations[0],
        locations,
        plan_participations: result.plan_participations,
        provider_coverage: result.provider_coverage,
      }),
    });
  });
  app.get("/specialties", async (c) => {
    const taxonomy = await taxonomyRelation(db);
    // Mirror native taxonomy enrichment, including its explicit unknown-code status.
    const { rows } =
      await db.query<ProviderTaxonomy>(`SELECT DISTINCT t.code,nt.display_name AS taxonomy_display_name,
      nt.classification,nt.specialization,CASE WHEN nt.code IS NULL THEN 'unknown_code' ELSE 'known' END AS taxonomy_status
      FROM npi_taxonomy t JOIN npi_provider n ON n.npi=t.npi
      LEFT JOIN ${taxonomy} nt ON nt.code=t.code WHERE n.in_scope ORDER BY t.code`);
    header(c, [
      ...(rows.some((r) => !taxonomyName(r))
        ? ["specialty_descriptions_unavailable"]
        : []),
      "specialty_ids_are_taxonomy_codes",
      "specialties_limited_to_loaded_nppes",
    ]);
    return c.json({
      meta: { total: rows.length },
      specialties: rows.map((r) => ({
        id: r.code,
        code: r.code,
        category: r.taxonomy_status === "known" ? r.classification : null,
        name: taxonomyName(r),
        display_name: taxonomyName(r),
        taxonomy_source:
          r.taxonomy_status === "known" ? "nucc" : "nppes_code_only",
        sub_specialty: r.taxonomy_status === "known" ? r.specialization : null,
      })),
    });
  });
  return app;
}
