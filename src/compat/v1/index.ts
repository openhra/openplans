import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compatKeyHeader, credentialMatches } from "./auth.js";
import { providerCompatRoutes } from "./providers.js";
import { dentalHouseholdOffering, mapDentalPlan } from "./dental.js";
import { countyDisplayNames, stateName } from "./geography.js";
import { orderPlans, pageWindow } from "./search.js";
import type { SqlSession } from "../../db/database.js";
import type { ApiOptions } from "../../api/routes.js";
import { nativeRoutes } from "../../api/routes.js";
import {
  countyPlans,
  countyState,
  findPlan,
  locationZipCounties,
  planView,
  resolveLocation,
  variantExists,
} from "../../api/repository.js";
import { estimatePremium } from "../../api/premiums.js";
import { householdSubsidy, withSubsidy } from "../../api/subsidies.js";
import * as v from "../../api/validation.js";
import { createRxnormRepository } from "../../ingest/rxnorm/repository.js";
import {
  emptySearch,
  mapPlan,
  mapQuote,
  mapVariantBenefits,
  mapVariantAccumulators,
  PLAN_GAPS,
  planResponse,
} from "./mapping.js";

function gaps(
  c: { header(name: string, value: string): void },
  reasons: Iterable<string>,
) {
  c.header("x-openplans-gaps", [...new Set(reasons)].join(", "));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return v.fail("body");
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  fallback: number,
  field: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const number =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : (value ?? fallback);
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > max
  )
    return v.fail(field);
  return number;
}
function pagination(
  body: Record<string, unknown>,
  defaultSize: number,
  maximumSize = 1000,
) {
  const page = integer(body.page, 1, "page"),
    size = integer(body.per_page, defaultSize, "per_page", 1000);
  if (!Number.isSafeInteger(page * size)) return v.fail("page");
  return pageWindow(page, size, maximumSize);
}
export function matchesMedicalSearchId(
  plan: { base_plan_id: string; hios_id?: string | null },
  id: string,
) {
  return plan.base_plan_id === id || plan.hios_id === id;
}
const BASE = "/compat/v1";

// ids[] and plan.id are opaque strings, whereas
// identifiers[type=hios_id] explicitly promises a published HIOS identifier.
function facadeId(value: unknown) {
  if (typeof value === "string" && value.includes(":")) {
    return v.premiumRequest({
      plan_keys: [value],
      county: "50007",
      coverage_start: "2026-01-01",
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    }).ids[0]!;
  }
  return v.planId(value);
}

function stateGaps(
  plan: { state_catalog?: boolean; state: string; hios_id?: string | null },
  reasons: Set<string>,
) {
  if (!plan.state_catalog) return;
  reasons.add("state_filed_tier");
  reasons.add("enrollment_eligibility_unknown");
  reasons.add("exchange_status_unknown");
  if (plan.hios_id === null) {
    reasons.add("plan_ids_are_native_plan_keys");
    reasons.add("hios_ids_unavailable");
  }
}

/** One removable router. Reads public/native repositories only; never contacts a vendor. */
export function compatRoutes(db: SqlSession, options: ApiOptions = {}) {
  const extraHeader = compatKeyHeader();
  const allowedHeaders = ["Content-Type", "X-Api-Key", "Accept-Version"];
  if (
    extraHeader &&
    !allowedHeaders.some(
      (name) => name.toLowerCase() === extraHeader.toLowerCase(),
    )
  )
    allowedHeaders.push(extraHeader);
  const app = new Hono().basePath(BASE),
    native = nativeRoutes(db, options);
  app.onError((error, c) =>
    error instanceof v.InputError
      ? c.json({ error: { code: error.code, field: error.field } }, 400)
      : c.json({ error: "internal_error" }, 500),
  );

  app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    c.header("Access-Control-Expose-Headers", "x-openplans-gaps, Link");
    c.header("Cache-Control", "no-store");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    const token = process.env.OPENPLANS_COMPAT_API_KEY;
    if (!token) return c.json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
    const primaryMatches = credentialMatches(c.req.header("X-Api-Key"), token);
    const extraMatches = extraHeader
      ? credentialMatches(c.req.header(extraHeader), token)
      : false;
    if (!primaryMatches && !extraMatches)
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    await next();
  });
  app.route("/", providerCompatRoutes(db, native));

  app.get("/zip_counties", async (c) => {
    const prefix = c.req.query("zip_prefix");
    if (!prefix || !/^\d{3,5}$/.test(prefix))
      return c.json({ error: "zip_prefix required (3-5 digit string)" }, 400);
    if (prefix.length === 5)
      c.header("Link", `</v1/zip-counties?zip=${prefix}>; rel="describedby"`);
    const missing = [
      "vendor_geography_ids_unavailable",
      "exchange_state_flags_unavailable",
      "zip_results_limited_to_loaded_geography",
    ];
    const empty = { counties: [], states: [], zip_counties: [], zip_codes: [] };
    // At most 100 cached/bulk lookups for a three-digit prefix; no live CMS range crawl. Never infer
    // geography from the prefix itself or borrow an unknown ZIP's county.
    const results = [];
    for (let suffix = 0; suffix < 10 ** (5 - prefix.length); suffix++) {
      const zip =
        prefix +
        (prefix.length === 5
          ? ""
          : String(suffix).padStart(5 - prefix.length, "0"));
      const result = await locationZipCounties(db, zip, {
        allowCmsLive: prefix.length === 5,
      });
      if (result.status === "available") results.push(result);
    }
    if (!results.length) {
      gaps(c, [
        ...missing,
        "zip_not_in_loaded_geography",
        "zip_not_in_loaded_zcta_data",
      ]);
      return c.json(empty);
    }
    const countyMap = new Map(
      results.flatMap((result) =>
        result.counties.map((county) => [county.county_fips, county] as const),
      ),
    );
    // Postal sources can omit a county's legal suffix. Resolve the display label from an active
    // Census relationship for the same FIPS, independently of which ZIP resolved the request.
    const labels = await countyDisplayNames(db, [...countyMap.keys()]);
    const counties = [...countyMap.values()].map((county) => {
      return {
        id: Number(county.county_fips),
        fips_code: county.county_fips,
        name: labels.get(county.county_fips) ?? county.county_name,
        state_code: countyState(county.county_fips),
        state_id: Number(county.county_fips.slice(0, 2)),
        state_live: null,
        state_live_for_business: null,
      };
    });
    gaps(c, missing);
    const links = results.map(
      (result) => `</v1/zip-counties?zip=${result.zip}>; rel="describedby"`,
    );
    for (const result of results) {
      if (result.attribution)
        links.push(
          `<${result.attribution.url}>; rel="author"; title="${result.attribution.publisher}"`,
          `<${result.attribution.license_url}>; rel="license"`,
        );
    }
    c.header("Link", [...new Set(links)].join(", "));
    const stateFips = [
      ...new Set([...countyMap.keys()].map((county) => county.slice(0, 2))),
    ];
    return c.json({
      counties,
      states: stateFips.map((fips) => ({
        id: Number(fips),
        fips_number: fips,
        code: countyState(`${fips}000`),
        name: stateName(countyState(`${fips}000`)),
        last_date_for_individual: null,
        last_date_for_shop: null,
        live_for_business: null,
        live_for_consumers: null,
      })),
      zip_codes: results.map((result) => ({
        code: result.zip,
        id: Number(result.zip),
      })),
      zip_counties: results.flatMap((result) =>
        result.counties.map((county) => ({
          id: null,
          county_id: Number(county.county_fips),
          zip_code_id: Number(result.zip),
          source: result.source,
          ...(result.attribution ? { attribution: result.attribution } : {}),
        })),
      ),
    });
  });

  for (const product of ["medical", "dental", "vision"] as const)
    app.post(
      `/plans/${product}/search`,
      bodyLimit({
        maxSize: 65_536,
        onError: (c) => c.json({ error: "Request too large" }, 400),
      }),
      async (c) => {
        let json: unknown;
        try {
          json = await c.req.json();
        } catch {
          return c.json({ error: "Invalid JSON body" }, 400);
        }
        const body = object(json),
          reasons = new Set(PLAN_GAPS),
          { start, size } = pagination(
            body,
            10,
            product === "medical" ? 50 : 1000,
          );
        if (
          body.sort !== undefined &&
          (typeof body.sort !== "string" ||
            !/^-?(premium|premium_subsidized|level|name|id)$/.test(body.sort))
        )
          return v.fail("sort");
        if (product === "medical" && body.sort === undefined)
          reasons.add("default_plan_order_unverified");
        if (
          !body.fips_code ||
          !Array.isArray(body.applicants) ||
          !body.applicants.length
        ) {
          return c.json({ error: "fips_code and applicants[] required" }, 400);
        }
        const county = v.county(body.fips_code),
          zip = body.zip_code === undefined ? undefined : v.zip(body.zip_code);
        const market = body.market === undefined ? "individual" : body.market;
        if (typeof market !== "string") return v.fail("market");
        const coverage =
          body.enrollment_date === undefined
            ? "2026-01-01"
            : body.enrollment_date;
        if (body.enrollment_date === undefined)
          reasons.add("coverage_date_defaulted_to_2026_01_01");
        const applicants = body.applicants.map((a, index) => {
          const applicant = object(a);
          if (
            applicant.child !== undefined &&
            typeof applicant.child !== "boolean"
          )
            return v.fail("applicants.child");
          function applicantRelationship() {
            if (applicant.child) {
              return "child";
            } else if (index === 0) {
              return "subscriber";
            } else {
              return "spouse";
            }
          }
          return {
            age: applicant.age,
            tobacco: applicant.smoker === undefined ? false : applicant.smoker,
            relationship: applicantRelationship(),
          };
        });
        // Validate household/date through the same native validator before returning
        // even an unsupported-location/market response.
        // A structural validation sentinel; never looked up, served or persisted.
        const request = v.premiumRequest({
          plan_ids: ["00000TX0000000"],
          county,
          ...(zip ? { zip } : {}),
          coverage_start: coverage,
          members: applicants,
          csr_variant: body.csr_variant,
          household_income_annual: body.household_income,
          household_size: body.household_size,
          tax_filing: body.tax_filing,
        });
        const nativeQuery = new URLSearchParams({
          county,
          year: String(request.year),
        });
        if (zip) nativeQuery.set("zip", zip);
        if (request.csrVariant)
          nativeQuery.set("csr_variant", request.csrVariant);
        c.header("Link", `</v1/plans?${nativeQuery}>; rel="describedby"`);
        if (product === "vision") {
          gaps(c, ["vision_unsupported"]);
          return c.json({ meta: { total: 0 }, plans: [] });
        }
        if (
          body.ids !== undefined &&
          (!Array.isArray(body.ids) || body.ids.length > 100)
        )
          return v.fail("ids");
        const ids =
          body.ids === undefined ? [] : (body.ids as unknown[]).map(facadeId);
        for (const id of ids)
          v.checkVariant(id.base, request.csrVariant, id.variant);
        if (body.providers !== undefined || body.drug_packages !== undefined)
          reasons.add("provider_and_drug_coverage_unavailable");
        if (market !== "individual") {
          gaps(c, [...reasons, "market_not_supported"]);
          return c.json(emptySearch());
        }
        const location = await resolveLocation(db, request.location);
        if (location.status !== "available" || !location.county) {
          gaps(c, [...reasons, "zip_not_in_loaded_zcta_data"]);
          return c.json(emptySearch());
        }
        const offered = (
          await countyPlans(
            db,
            location.county,
            request.year,
            location.zip,
            product,
          )
        ).filter(
          (p) => product === "dental" || p.on_exchange || p.state_catalog,
        );
        if (product === "dental") reasons.add("dental_benefits_unmapped");
        const targets: { plan: (typeof offered)[number]; id: string }[] = [];
        if (ids.length > 0) {
          for (const id of new Map(ids.map((id) => [id.full, id])).values()) {
            const plan = offered.find((p) =>
              matchesMedicalSearchId(p, id.base),
            );
            if (
              !plan ||
              (id.variant !== null && !(await variantExists(db, plan, id.full)))
            )
              reasons.add(`public_plan_unavailable:${id.full}`);
            else targets.push({ plan, id: id.full });
          }
        } else
          targets.push(
            ...offered.map((plan) => ({ plan, id: plan.base_plan_id })),
          );
        if (!targets.length)
          reasons.add("no_public_plans_for_location_and_year");
        const subsidy =
          product === "medical"
            ? await householdSubsidy(db, request, location)
            : undefined;
        if (request.subsidy) {
          reasons.add("csr_eligibility_not_evaluated");
          reasons.add("puf_calculation_non_bindable");
          reasons.add("state_subsidies_unavailable");
          if (subsidy && subsidy.estimated_monthly_tax_credit_cents !== null)
            reasons.delete("subsidies_unavailable");
          else {
            reasons.add("household_subsidies_unavailable");
            reasons.add(`subsidy_${subsidy?.status ?? "unsupported_product"}`);
          }
        }
        const plans: Record<string, unknown>[] = [];
        for (const { plan, id } of targets) {
          if (product === "dental") {
            const offering = await dentalHouseholdOffering(
              db,
              plan,
              request.members,
              request.coverage,
            );
            if (!offering.offered) {
              reasons.add(`dental_child_only_excluded:${id}`);
              continue;
            }
          }
          stateGaps(plan, reasons);
          const view = await planView(db, plan, {
            csrVariant: request.csrVariant,
            requestedVariant: facadeId(id).variant,
          });
          if (
            product === "medical" &&
            (view.cost_sharing.status === "unknown" ||
              view.cost_sharing.benefits_status === "unknown")
          )
            reasons.add("variant_cost_sharing_unknown");
          if (
            product === "medical" &&
            request.csrVariant === undefined &&
            facadeId(id).variant === null
          )
            reasons.add("standard_on_exchange_variant_defaulted");
          const quote = withSubsidy(
            await estimatePremium(db, plan, id, request, location),
            subsidy,
            plan,
          );
          if (quote.status !== "rated") {
            reasons.add(`premium_${quote.status}`);
            if (request.subsidy) reasons.add("subsidies_unavailable");
          }
          if (
            product === "dental" &&
            quote.status === "unsupported_rating_method"
          ) {
            reasons.add("dental_premiums_unsupported_by_native_rating");
            reasons.add(`dental_premiums_unsupported_by_native_rating:${id}`);
          }
          if ("reason" in quote && quote.reason)
            reasons.add(`premium_reason:${quote.reason}`);
          if (
            "estimated_net_monthly_cents" in quote &&
            quote.estimated_net_monthly_cents === null
          ) {
            reasons.add("subsidies_unavailable");
            reasons.add(`subsidy_${quote.subsidy_status}`);
          }
          plans.push(
            product === "dental"
              ? { ...mapDentalPlan(view, id), premium: mapQuote(quote).premium }
              : {
                  ...mapPlan(view, id, plan.service_area_id || null),
                  ...mapVariantAccumulators(view.cost_sharing),
                  ...mapVariantBenefits(
                    view.cost_sharing.benefits,
                    view.cost_sharing.selected_variant_id ?? "",
                  ),
                  ...mapQuote(quote, request.members),
                },
          );
        }
        orderPlans(plans, body.sort as string | undefined);
        gaps(c, reasons);
        return c.json(
          product === "medical"
            ? {
                ...emptySearch(),
                meta: {
                  ...emptySearch().meta,
                  total: plans.length,
                  premium_tax_credit:
                    subsidy === undefined ||
                    subsidy.estimated_monthly_tax_credit_cents === null
                      ? null
                      : subsidy.estimated_monthly_tax_credit_cents / 100,
                },
                plans: plans
                  .slice(start, start + size)
                  .map((plan) => planResponse(plan)),
              }
            : {
                meta: { total: plans.length },
                plans: plans.slice(start, start + size),
              },
        );
      },
    );

  const detail = async (id: string, year: number, csrVariant?: string) => {
    let parsed: ReturnType<typeof facadeId>;
    try {
      parsed = facadeId(id);
    } catch {
      return null;
    }
    const plan = await findPlan(db, parsed.base, year);
    if (
      !plan ||
      (parsed.variant !== null && !(await variantExists(db, plan, parsed.full)))
    )
      return null;
    v.checkVariant(parsed.base, csrVariant, parsed.variant);
    const view = await planView(db, plan, {
      csrVariant,
      requestedVariant: parsed.variant,
    });
    const mapped = plan.dental_only
      ? mapDentalPlan(view, parsed.full)
      : mapPlan(view, parsed.full, plan.service_area_id || null);
    if (!plan.dental_only)
      Object.assign(
        mapped,
        mapVariantAccumulators(view.cost_sharing),
        mapVariantBenefits(
          view.cost_sharing.benefits,
          view.cost_sharing.selected_variant_id ?? "",
        ),
      );
    return {
      mapped,
      dental: plan.dental_only,
      plan,
      costSharing: view.cost_sharing,
    };
  };
  for (const route of ["/plans/:id", "/plans/medical/:id", "/plans/dental/:id"])
    app.get(route, async (c) => {
      const year =
        c.req.query("year") === undefined ? 2026 : v.year(c.req.query("year"));
      const csrVariant = v.csrVariant(c.req.query("csr_variant"));
      const record = await detail(c.req.param("id")!, year, csrVariant);
      if (!c.req.param("id")!.includes(":")) {
        const query = new URLSearchParams({ year: String(year) });
        if (csrVariant) query.set("csr_variant", csrVariant);
        c.header(
          "Link",
          `</v1/plans/${encodeURIComponent(c.req.param("id")!)}?${query}>; rel="describedby"`,
        );
      }
      const reasons = record?.dental
        ? ["dental_premium_requires_household", "dental_benefits_unmapped"]
        : [...PLAN_GAPS];
      if (record) {
        const stateReasons = new Set(reasons);
        stateGaps(record.plan, stateReasons);
        reasons.splice(0, reasons.length, ...stateReasons);
      }
      if (c.req.query("year") === undefined)
        reasons.push("plan_year_defaulted_to_2026");
      if (
        !record?.dental &&
        record &&
        (record.costSharing.status === "unknown" ||
          record.costSharing.benefits_status === "unknown")
      )
        reasons.push("variant_cost_sharing_unknown");
      if (
        !record?.dental &&
        csrVariant === undefined &&
        !/^\d{5}[A-Z]{2}\d{7}-\d{2}$/.test(c.req.param("id")!)
      )
        reasons.push("standard_on_exchange_variant_defaulted");
      gaps(c, reasons);
      const wrongLine =
        record &&
        ((c.req.path.includes("/medical/") && record.dental) ||
          (c.req.path.includes("/dental/") && !record.dental));
      return record && !wrongLine
        ? c.json({
            plan: record.dental ? record.mapped : planResponse(record.mapped),
          })
        : c.json({ error: "Plan not found" }, 404);
    });

  app.get("/drugs", async (c) => {
    const term = c.req.query("search_term");
    if (!term || term.trim().length < 2 || term.length > 200)
      return c.json(
        { error: "search_term required (min 2 chars, max 200)" },
        400,
      );
    const { start, size } = pagination(c.req.query(), 25),
      rx = createRxnormRepository(db);
    const reasons = [
      "drug_total_counts_rxnorm_concepts_not_ndc_products",
      "drug_ids_are_rxnorm_concepts",
      "ndc_package_descriptions_and_med_ids_unavailable",
      "drug_strength_not_separately_resolved",
    ];
    if (!(await rx.activeRelease())) {
      gaps(c, [...reasons, "rxnorm_terminology_unavailable"]);
      return c.json({ meta: { total: 0 }, drugs: [], drug_packages: [] });
    }
    // The repository counts candidates by concept/name/TTY. Deduplicate RxCUIs,
    // then paginate concepts; NDC associations are packages, not product counts.
    const concepts = new Map<
      string,
      Awaited<ReturnType<typeof rx.searchDrugs>>[number]
    >();
    for (let offset = 0; ; offset += 1000) {
      const batch = await rx.searchDrugs(term, { limit: 1000, offset });
      for (const concept of batch)
        if (!concepts.has(concept.rxcui)) concepts.set(concept.rxcui, concept);
      if (batch.length < 1000) break;
    }
    const drugs = [],
      packages: {
        id: string;
        description: null;
        med_id: null;
        rx_cui_id: string;
      }[] = [];
    for (const concept of [...concepts.values()].slice(start, start + size)) {
      const ndcs = await rx.ndcsForRxcui(concept.rxcui),
        packageIds = ndcs.map(
          (ndc) => `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`,
        );
      drugs.push({
        id: `rxnorm:${concept.rxcui}`,
        active_ingredient_strength: null,
        proprietary_name: ["SBD", "BN", "BPCK"].includes(concept.tty)
          ? concept.name
          : null,
        non_proprietary_name: ["SBD", "BN", "BPCK"].includes(concept.tty)
          ? null
          : concept.name,
        drug_package_ids: packageIds,
      });
      packages.push(
        ...packageIds.map((id) => ({
          id,
          description: null,
          med_id: null,
          rx_cui_id: concept.rxcui,
        })),
      );
    }
    gaps(c, reasons);
    return c.json({
      meta: { total: concepts.size },
      drugs,
      drug_packages: packages,
    });
  });

  for (const kind of ["carriers", "networks"] as const)
    app.get(`/${kind}`, async (c) => {
      const { start, size } = pagination(c.req.query(), 100),
        state = v.state((c.req.query("state") ?? "TX").toUpperCase());
      const year = c.req.query("year") ?? "2026";
      v.year(year);
      const response = await native.request(
        `/${kind}?state=${state}&year=${year}`,
      );
      if (!response.ok) return response;
      const data = (await response.json()) as Record<string, unknown>;
      const rows = data[kind] as Record<string, unknown>[];
      const reasons = [
        "catalog_limited_to_loaded_public_sources",
        "carrier_ids_are_cms_issuer_ids",
      ];
      let records: Record<string, unknown>[];
      if (kind === "carriers") {
        // The native network census publishes both market and dental-only flags.
        // Do not advertise additional markets/lines beyond that public evidence.
        records = [];
        const networksResponse = await native.request(
          `/networks?state=${state}&year=${year}`,
        );
        if (!networksResponse.ok) return networksResponse;
        const networkData = (await networksResponse.json()) as {
          networks: Record<string, unknown>[];
        };
        for (const row of rows) {
          const networks = networkData.networks.filter(
            (n) => n.issuer_id === row.issuer_id,
          );
          const names = row.marketing_names as unknown[];
          records.push({
            id: row.issuer_id,
            name: names.find((n) => typeof n === "string" && n) ?? null,
            lines_of_coverage: [
              ...new Set(
                networks.map((n) => (n.dental_only ? "dental" : "medical")),
              ),
            ],
            markets: [
              ...new Set(
                networks.map((n) =>
                  String(n.market).toLowerCase().replaceAll(" ", "_"),
                ),
              ),
            ],
            states: [row.state],
            issuers: [],
          });
        }
        reasons.push("carrier_markets_and_lines_limited_to_network_puf");
        const market = c.req.query("market"),
          line = c.req.query("line_of_coverage");
        records = records.filter(
          (r) =>
            (!market || (r.markets as string[]).includes(market)) &&
            (!line || (r.lines_of_coverage as string[]).includes(line)),
        );
      } else {
        const carrierResponse = await native.request(
          `/carriers?state=${state}&year=${year}`,
        );
        if (!carrierResponse.ok) return carrierResponse;
        const carrierData = (await carrierResponse.json()) as {
          carriers: { issuer_id: string; marketing_names: unknown[] }[];
        };
        records = rows.map((row) => ({
          id: null,
          name: row.network_name,
          carriers: [
            {
              id: row.issuer_id,
              name:
                carrierData.carriers
                  .find((c) => c.issuer_id === row.issuer_id)
                  ?.marketing_names.find((n) => typeof n === "string" && n) ??
                null,
            },
          ],
          source: "cms_puf",
          last_imported_at: null,
        }));
        reasons.push(
          "vendor_network_ids_unavailable",
          "network_import_dates_unavailable",
        );
      }
      if (!rows.length) reasons.push("no_loaded_catalog_for_state_and_year");
      gaps(c, reasons);
      return c.json({
        meta: { total: records.length },
        [kind]: records.slice(start, start + size),
      });
    });

  // Unsupported detail/product routes never fall back to a medical product.
  const unsupported = ["plans/vision/*", "plans/medadv/*"];
  for (const path of unsupported)
    app.all(`/${path}`, (c) => {
      gaps(c, [
        `unsupported_route:${path.split("/")[0] === "plans" ? path.split("/")[1] : path.split("/")[0]}`,
      ]);
      return c.json({ error: "Not implemented" }, 501);
    });
  return app;
}
