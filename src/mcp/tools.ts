import { applicationVersion } from "./version.js";
import { cmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { sharedResponseCache } from "../api/cache/index.js";
import type { ResponseCache, CacheOutcome } from "../api/cache/index.js";
import type { SqlSession } from "../db/database.js";
import { dataGeneration } from "../api/cache/generation.js";
import { countyState } from "../api/repository.js";
import { InputError } from "../api/validation.js";
import * as v from "../api/validation.js";
import { ReadError } from "../services/errors.js";
import * as catalog from "../services/catalog.js";
import * as providers from "../services/providers.js";
import * as drugs from "../services/drugs.js";
import * as quotes from "../services/quotes.js";
import { searchMedicarePlans } from "../services/medicare.js";
import { ichraAffordability } from "../services/ichra.js";
import { getDataStatus, getSnapshot } from "../services/provenance.js";
import {
  discoverDrugs,
  discoverPlans,
  nativeWindow,
  entityId,
  parseEntityId,
} from "../services/discovery.js";
import {
  assertHonest,
  HonestyError,
  parseToolInput,
  PERSONALIZED_TOOLS,
  planRefSchema,
  QUOTING_TOOLS,
  quoteBody,
} from "./schemas.js";
import type {
  HonestyContext,
  ToolInput,
  ToolName,
  ToolOutput,
} from "./schemas.js";
import { cursorCodec, ToolError } from "./cursor.js";
import type { CursorBinding } from "./cursor.js";
import { projector, row, rows } from "./projection.js";
import type { Row } from "./projection.js";
import { ZodError } from "zod";

export interface McpPrincipal {
  id: string;
}
/** Transport verifies credentials; this hook authorizes already-verified principals. Default denies. */
export interface McpPolicy {
  canEstimate(principal: McpPrincipal | undefined): boolean;
}
export interface McpDependencies {
  db: SqlSession;
  cache?: ResponseCache;
  onCache?: (outcome: CacheOutcome) => void;
  principal?: McpPrincipal;
  policy?: McpPolicy;
  /** Anonymous quotes by age and ZIP; on unless explicitly false (OPENPLANS_PUBLIC_QUOTING=off). */
  publicQuoting?: boolean;
  /** Share across processes if cursors must survive load balancing/restarts. Never log this value. */
  cursorSecret?: string | Uint8Array;
  now?: () => number;
}
export const mayEstimate = (deps: McpDependencies) =>
  Boolean(deps.principal && deps.policy?.canEstimate(deps.principal));
export const mayQuotePublic = (deps: McpDependencies) =>
  deps.publicQuoting !== false;
/** Personalized names need a grant; the public quote tool needs the tier on. */
export function mayCall(deps: McpDependencies, tool: ToolName) {
  if (PERSONALIZED_TOOLS.has(tool)) return mayEstimate(deps);
  if (tool === "quote_plans") return mayQuotePublic(deps);
  return true;
}
export const MAX_OUTPUT_BYTES = 128 * 1024;
// Discovery includes every output schema, so it has a separate transport budget.
export const MAX_TOOL_LIST_BYTES = 512 * 1024;
export const TOOL_LIST_PAGE_SIZE = 15;
export const MAX_INPUT_ELEMENTS = 512;
export const limits = {
  input_bytes: 64 * 1024,
  output_bytes: MAX_OUTPUT_BYTES,
  default_page: 10,
  max_page: 25,
  max_plans: 10,
  max_members: 20,
  max_quote_members: v.PUBLIC_QUOTE_LIMITS.members,
  max_quote_providers: v.PUBLIC_QUOTE_LIMITS.providers,
  max_quote_drugs: v.PUBLIC_QUOTE_LIMITS.drugs,
  max_coverage_pairs: 100,
  max_tool_input_elements: MAX_INPUT_ELEMENTS,
  cursor_ttl_ms: 15 * 60_000,
} as const;

interface CatalogResult {
  output: Row;
  drugs: readonly Row[];
  snapshotIds: string[];
}
const honestyContext = (dto: CatalogResult): HonestyContext => ({
  drugs: dto.drugs,
  snapshotIds: new Set(dto.snapshotIds),
});

interface Answer {
  data: Row;
  p: Awaited<ReturnType<typeof projector>>;
  list?: string;
  total?: number | null;
  more?: boolean;
  status?: "ok" | "unknown" | "ambiguous" | "unsupported";
  notes?: string[];
  context?: HonestyContext;
}
const params = (value: Row): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
      .map(([k, v]) => [k, String(v)]),
  );
const slice = <T>(items: T[], offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit),
  total: items.length,
  more: offset + limit < items.length,
});
const status = (native: unknown) => {
  if (native === "ambiguous") {
    return "ambiguous" as const;
  } else if (native === "unknown") {
    return "unknown" as const;
  } else {
    return "ok" as const;
  }
};

async function planAnswer(
  db: SqlSession,
  input: ToolInput<"get_plan">,
  offset: number,
): Promise<Answer> {
  const native = await catalog.getPlan(
    db,
    input.plan_ref,
    params({ year: input.year, csr_variant: input.csr_variant }),
  );
  const p = await projector(db, native);
  let records: Row[] = [];
  if (input.section === "benefits")
    records = rows(native.benefits).map((b) => p.benefit(b, native));
  if (input.section === "provenance")
    records = [...p.metadata.keys()].map(p.snapshot);
  // Document URLs are not yet exposed by the canonical detail service. Never infer URL patterns.
  const page = slice(records, offset, input.limit);
  return {
    data: { plan: p.plan(native), section: input.section, records: page.items },
    p,
    list: "records",
    ...page,
    notes:
      input.section === "documents" ? ["DOCUMENT_EVIDENCE_UNAVAILABLE"] : [],
  };
}

async function datasets(
  db: SqlSession,
  input: ToolInput<"get_data_status">,
  offset: number,
  capability?: string,
) {
  const native = await getDataStatus(db, params(input));
  const candidates = native.entries.flatMap((entry) =>
    (capability
      ? [capability]
      : ["catalog", "premiums", "drugs", "providers"]
    ).map((cap) => ({ entry, cap })),
  );
  candidates.sort((a, b) =>
    JSON.stringify([
      a.entry.state,
      a.entry.plan_year,
      a.entry.issuer_id,
      a.cap,
    ]).localeCompare(
      JSON.stringify([
        b.entry.state,
        b.entry.plan_year,
        b.entry.issuer_id,
        b.cap,
      ]),
    ),
  );
  const page = slice(candidates, offset, input.limit),
    p = await projector(
      db,
      page.items.map((item) => item.entry),
    );
  return {
    native,
    p,
    records: page.items.map(({ entry, cap }) => p.dataset(entry, cap)),
    total: page.total,
    more: page.more,
  };
}

function hit(record: Row, id: string, title: string, summary = ""): Row {
  return {
    kind: record.kind,
    id,
    title,
    url:
      record.kind === "plan"
        ? `openplans://plan/${record.year}/${encodeURIComponent(String(record.plan_ref))}`
        : `openplans://entity/${encodeURIComponent(id)}`,
    summary,
    evidence_refs: record.evidence_refs,
    gaps: record.gaps,
  };
}

async function searchAnswer(
  db: SqlSession,
  input: ToolInput<"search">,
  offset: number,
): Promise<Answer> {
  const groups: Row[][] = [],
    gaps: string[] = [];
  const requested = (kind: string) =>
    input.entity === "all" || input.entity === kind;
  let state: string | null = null;
  if (input.location) {
    const loc = await catalog.lookupGeography(db, input.location);
    if (loc.status === "available" && loc.county)
      state = countyState(loc.county);
  }
  if (requested("plan")) {
    if (input.year && planRefSchema.safeParse(input.query).success) {
      try {
        groups.push([
          await catalog.getPlan(db, input.query, { year: String(input.year) }),
        ]);
      } catch (error) {
        if (
          !(error instanceof ReadError) ||
          error.error.code !== "PLAN_NOT_FOUND"
        )
          throw error;
      }
    } else if (!input.year || !input.location)
      gaps.push("PLAN_SEARCH_REQUIRES_YEAR_AND_LOCATION");
    else {
      const found = await discoverPlans(
        db,
        params({ ...input.location, year: input.year }),
        input.query,
      );
      groups.push(found);
    }
  }
  // Global identity search requires a literal name of at least three characters, or an exact NPI.
  let providerRecords: Row[] = [];
  if (requested("provider")) {
    if (/^[12]\d{9}$/.test(input.query)) {
      try {
        const detail = await providers.getProvider(
          db,
          input.query,
          input.year?.toString(),
        );
        providerRecords = rows(
          detail.identity ? [detail.identity] : detail.issuer_records,
        );
      } catch (e) {
        if (!(e instanceof ReadError) || e.error.code !== "PROVIDER_NOT_FOUND")
          throw e;
      }
    } else if (input.query.trim().length >= 3 && !/^\d+$/.test(input.query)) {
      for (let page = 1; page <= 20; page++) {
        const found = await providers.findProviders(
          db,
          params({ name: input.query, year: input.year, page }),
        );
        providerRecords.push(...rows(found.providers));
        if (!found.next_page) break;
        if (page === 20)
          gaps.push("PROVIDER_RESULTS_REQUIRE_SEARCH_PROVIDERS_FOR_MORE");
      }
    } else gaps.push("PROVIDER_SEARCH_REQUIRES_LITERAL_NAME_OR_NPI");
    providerRecords = providerRecords.filter((r) => typeof r.npi === "string");
  }
  let drugRecords: Row[] = [];
  if (requested("drug")) {
    if (/^\d{1,20}$/.test(input.query)) {
      try {
        drugRecords = rows(
          (await drugs.getDrug(db, input.query)).concepts,
        ).slice(0, 1);
      } catch (e) {
        if (!(e instanceof ReadError) || e.error.code !== "DRUG_NOT_FOUND")
          throw e;
      }
    } else {
      const found = await discoverDrugs(db, { query: input.query }, 0, 1000);
      drugRecords = found.items;
      if (found.more) gaps.push("DRUG_RESULTS_REQUIRE_SEARCH_DRUGS_FOR_MORE");
    }
  }
  let counties: Row[] = [];
  if (requested("geography")) {
    if (/^\d{5}$/.test(input.query))
      counties = (await catalog.lookupZip(db, input.query)).counties;
    else gaps.push("GEOGRAPHY_SEARCH_REQUIRES_ZIP");
  }
  const directories: { kind: "carriers" | "networks"; rows: Row[] }[] = [];
  for (const [entity, kind] of [
    ["carrier", "carriers"],
    ["network", "networks"],
  ] as const)
    if (requested(entity)) {
      if (!state)
        gaps.push(`${entity.toUpperCase()}_SEARCH_REQUIRES_RESOLVED_LOCATION`);
      else {
        const found = await catalog.listCarriersNetworks(
          db,
          kind,
          params({ state, year: input.year }),
        );
        const items = rows(found[kind]).filter((r) =>
          JSON.stringify([
            r.marketing_names,
            r.network_name,
            r.issuer_id,
            r.network_id,
          ])
            .toLowerCase()
            .includes(input.query.toLowerCase()),
        );
        directories.push({ kind, rows: items });
      }
    }
  let datasetRecords: Row[] = [];
  if (requested("dataset")) {
    datasetRecords = (
      await getDataStatus(db, params({ state, year: input.year }))
    ).entries.filter((r) =>
      JSON.stringify([r.state, r.plan_year, r.issuer_id])
        .toLowerCase()
        .includes(input.query.toLowerCase()),
    );
  }
  type Candidate = {
    kind:
      | "plan"
      | "provider"
      | "drug"
      | "geography"
      | "dataset"
      | "carriers"
      | "networks";
    value: Row;
  };
  const candidates: Candidate[][] = groups.map((group) =>
    group.map((value) => ({ kind: "plan", value })),
  );
  for (const [kind, values] of [
    ["provider", providerRecords],
    ["drug", drugRecords],
    ["geography", counties],
    ["dataset", datasetRecords],
  ] as const) {
    candidates.push(values.map((value) => ({ kind, value })));
  }
  for (const dir of directories)
    candidates.push(dir.rows.map((value) => ({ kind: dir.kind, value })));
  const interleaved: Candidate[] = [];
  for (let i = 0; candidates.some((group) => group.length > i); i++)
    for (const group of candidates) if (group[i]) interleaved.push(group[i]!);
  const page = slice(interleaved, offset, input.limit);
  const p = await projector(
    db,
    page.items.map((candidate) => candidate.value),
  );
  const results = page.items.map(({ kind, value }) => {
    if (kind === "plan") {
      const r = p.plan(value);
      return hit(
        r,
        entityId("plan", Number(r.year), String(r.plan_ref)),
        String(r.name),
      );
    }
    if (kind === "provider") {
      const r = p.provider(value, !value.source_set_id),
        id = value.source_set_id
          ? entityId(
              "provider",
              Number(value.plan_year),
              String(r.npi),
              String(value.snapshot_id),
              String(value.record_id),
            )
          : entityId("provider", String(r.npi));
      return hit(r, id, String(r.name ?? r.npi));
    }
    if (kind === "drug") {
      const r = p.drug(value);
      return hit(r, entityId("drug", String(r.rxcui)), String(r.name));
    }
    if (kind === "geography") {
      const r = p.geography(value);
      return hit(
        r,
        entityId("geography", input.query, String(r.county_fips)),
        String(r.name ?? r.county_fips),
      );
    }
    if (kind === "dataset") {
      const r = p.dataset(value, "catalog");
      return hit(
        r,
        entityId(
          "dataset",
          String(r.state ?? "_"),
          String(r.year ?? "_"),
          String(r.issuer_id ?? "_"),
          "catalog",
        ),
        `${r.state} ${r.year} ${r.issuer_id}`,
      );
    }
    const r = p.directory(value, kind);
    return hit(r, String(r.id), String(r.name ?? r.issuer_id));
  });
  return {
    data: { results, scope_gaps: gaps },
    p,
    list: "results",
    total: page.total,
    more: page.more,
    context: p.context,
  };
}

async function fetchAnswer(
  db: SqlSession,
  input: ToolInput<"fetch">,
  offset: number,
): Promise<Answer> {
  const { kind, parts } = parseEntityId(input.id);
  if (
    !["plan", "provider", "drug"].includes(kind) &&
    !["summary", "provenance"].includes(input.section)
  )
    throw new ToolError("UNSUPPORTED_SECTION", "section");
  let records: Row[] = [],
    title = input.id,
    p: Awaited<ReturnType<typeof projector>>,
    total: number | null,
    more: boolean;
  if (kind === "plan") {
    if (["addresses", "associations"].includes(input.section))
      throw new ToolError("UNSUPPORTED_SECTION", "section");
    const answer = await planAnswer(
      db,
      {
        plan_ref: parts[1]!,
        year: Number(parts[0]),
        section: input.section as ToolInput<"get_plan">["section"],
        limit: input.limit,
      },
      offset,
    );
    const plan = row(answer.data.plan);
    title = String(plan.name);
    p = answer.p;
    if (input.section === "summary") {
      if (offset === 0) {
        records = [plan];
      } else {
        records = [];
      }
    } else {
      records = rows(answer.data.records);
    }
    total = input.section === "summary" ? 1 : (answer.total ?? null);
    more = Boolean(answer.more);
  } else if (kind === "drug") {
    const native = await drugs.getDrug(db, parts[0]);
    p = await projector(db, native);
    if (input.section === "summary")
      records = rows(native.concepts).map(p.drug);
    else if (input.section === "associations")
      records = [
        ...rows(native.ingredients),
        ...rows(native.brand_generic_links),
      ].map((r) => ({
        kind: "association",
        relation: r.rela ?? "ingredient",
        target_id: entityId("drug", String(r.rxcui)),
        ...p.evidence(r, native),
      }));
    else if (input.section === "provenance")
      records = [...p.metadata.keys()].map(p.snapshot);
    else throw new ToolError("UNSUPPORTED_SECTION", "section");
    title = String(rows(native.concepts)[0]?.name ?? input.id);
    const page = slice(records, offset, input.limit);
    ({ items: records, total, more } = page);
  } else if (kind === "provider") {
    const native = await providers.getProvider(
      db,
      parts.length === 1 ? parts[0] : parts[1],
      parts.length === 4 ? parts[0] : undefined,
    );
    const selected =
      parts.length === 4
        ? rows(native.issuer_records).filter(
            (r) => r.snapshot_id === parts[2] && r.record_id === parts[3],
          )
        : rows(native.identity ? [native.identity] : native.issuer_records);
    if (!selected.length) throw new ToolError("PROVIDER_NOT_FOUND");
    p = await projector(db, selected);
    title = String(
      p.provider(selected[0], parts.length === 1).name ?? input.id,
    );
    if (input.section === "summary")
      records = selected.map((r) => p.provider(r, parts.length === 1));
    else if (input.section === "addresses")
      records = selected.flatMap((r) =>
        rows(r.addresses).map((a) => p.address(a, r)),
      );
    else if (input.section === "associations")
      records = selected.flatMap((r) =>
        rows(r.plan_participations).map((e) => ({
          kind: "association",
          relation: "published_plan_record",
          target_id: entityId(
            "plan",
            Number(e.plan_year),
            String(e.base_hios_id),
          ),
          ...p.evidence(e, r),
        })),
      );
    else if (input.section === "provenance")
      records = [...p.metadata.keys()].map(p.snapshot);
    else throw new ToolError("UNSUPPORTED_SECTION", "section");
    ({ items: records, total, more } = slice(records, offset, input.limit));
  } else if (kind === "snapshot") {
    const native = await getSnapshot(db, parts[0]);
    if (!native) throw new ToolError("SNAPSHOT_NOT_FOUND");
    p = await projector(db, native);
    records = [p.snapshot(parts[0]!)];
    title = native.publisher;
    ({ items: records, total, more } = slice(records, offset, input.limit));
  } else if (kind === "geography") {
    const native = await catalog.lookupZip(db, parts[0]),
      found = native.counties.filter((c) => c.county_fips === parts[1]);
    if (!found.length) throw new ToolError("GEOGRAPHY_NOT_FOUND");
    p = await projector(db, found);
    records = found.map(p.geography);
    title = String(found[0]!.county_name);
    ({ items: records, total, more } = slice(records, offset, input.limit));
  } else if (kind === "carrier" || kind === "network") {
    const dirKind = kind === "carrier" ? "carriers" : "networks";
    const native = await catalog.listCarriersNetworks(db, dirKind, {
      state: parts[0]!,
      year: parts[1]!,
    });
    p = await projector(db, native);
    records = rows(native[dirKind])
      .map((r) => p.directory(r, dirKind))
      .filter((r) => r.id === input.id);
    if (!records.length) throw new ToolError("ENTITY_NOT_FOUND");
    title = String(records[0]!.name ?? input.id);
    ({ items: records, total, more } = slice(records, offset, input.limit));
  } else {
    const found = await datasets(
      db,
      {
        state: parts[0] === "_" ? undefined : parts[0],
        year: parts[1] === "_" ? undefined : Number(parts[1]),
        issuer_id: parts[2] === "_" ? undefined : parts[2],
        limit: input.limit,
      },
      offset,
      parts[3],
    );
    p = found.p;
    records = found.records;
    if (!records.length) throw new ToolError("ENTITY_NOT_FOUND");
    total = found.total;
    more = found.more;
  }
  if (
    input.section === "provenance" &&
    !["plan", "provider", "drug", "snapshot"].includes(kind)
  ) {
    const page = slice(
      [...p.metadata.keys()].map(p.snapshot),
      offset,
      input.limit,
    );
    records = page.items;
    total = page.total;
    more = page.more;
  }
  return {
    data: {
      id: input.id,
      title,
      url:
        kind === "plan"
          ? `openplans://plan/${parts[0]}/${encodeURIComponent(parts[1]!)}`
          : `openplans://entity/${encodeURIComponent(input.id)}`,
      text: "",
      entity: kind,
      section: input.section,
      records,
    },
    p,
    list: "records",
    total,
    more,
    context: p.context,
  };
}

export type Completeness = (
  planId: string,
  kind: "drug_coverage" | "provider_coverage",
) => unknown;
/** Issuer source completeness from the manifest, as the coverage tools report it. */
async function sourceCompleteness(
  db: SqlSession,
  year: number,
): Promise<Completeness> {
  const manifest = await getDataStatus(db, { year: String(year) });
  return (planId, kind) =>
    row(
      manifest.entries.find(
        (e) =>
          e.issuer_id === planId.slice(0, 5) && e.state === planId.slice(5, 7),
      )?.[kind],
    ).status;
}

/** Native pages hold QUOTE_PAGE_SIZE plans; a truncated page resumes inside it. */
async function quoteAnswer(
  db: SqlSession,
  input: ToolInput<"quote_plans">,
  offset: number,
): Promise<Answer> {
  const size = quotes.QUOTE_PAGE_SIZE;
  const native = await quotes.quotePlans(
    db,
    quoteBody(input, Math.floor(offset / size) + 1),
  );
  const items = native.quotes.slice(offset % size);
  const completeness = await sourceCompleteness(db, input.year);
  const p = await projector(db, items);
  return {
    data: {
      quotes: items.map((q) => p.quote(q, completeness)),
      bindable_quote: false,
      tier: native.tier,
      location_status: native.location.status,
      tobacco_rating: native.tobacco_rating,
      subsidy_status: "not_evaluated",
      data_availability: native.data_availability,
    },
    p,
    list: "quotes",
    total: native.total,
    more: offset + items.length < native.total,
    status: status(native.location.status),
    context: { ...p.context, estimates: items },
    notes: [
      "Quotes by age and ZIP are not bindable. Income and subsidies are not evaluated.",
    ],
  };
}

const medicareStatus: Record<string, "ok" | "ambiguous"> = {
  available: "ok",
  multiple_counties: "ambiguous",
};
const ICHRA_ENVELOPE: Readonly<Record<string, Answer["status"]>> = {
  calculated: "ok",
  ambiguous_lcsp: "ambiguous",
  location_requires_zip: "ambiguous",
  requires_state_rules: "unsupported",
  unsupported_state: "unsupported",
  unsupported_rating_method: "unsupported",
};
/** Projects a calculated LCSP with its rate evidence; any other LCSP is left out (see status). */
function ichraLcsp(
  value: unknown,
  use: "premium_tax_credit" | "employer",
  p: Awaited<ReturnType<typeof projector>>,
): Row[] {
  const r = row(value);
  if (r.status !== "calculated") return [];
  const location = row(r.location),
    byBasis = row(r.by_basis);
  const pickOf = (basis: unknown) => {
    const b = row(basis);
    return b.status === "calculated"
      ? { plan_ids: b.plan_ids, monthly_cents: b.monthly_cents }
      : null;
  };
  return [
    {
      use,
      status: "calculated",
      basis_used: r.basis_used,
      plan_ids: r.plan_ids,
      monthly_cents: r.monthly_cents,
      by_basis: {
        gross: pickOf(byBasis.gross),
        ehb_portion: pickOf(byBasis.ehb_portion),
      },
      location_source: location.source,
      county_fips: location.county_fips,
      zip: location.zip,
      rating_area_id: location.rating_area_id,
      coverage_month: r.coverage_month,
      identified_at_age: r.identified_at_age,
      priced_at_age: r.priced_at_age,
      silver_plan_count: r.silver_plan_count,
      ...p.evidence(r.provenance),
    },
  ];
}
async function ichraAnswer(db: SqlSession, input: Row): Promise<Answer> {
  const native = row(await ichraAffordability(db, v.ichraRequest(input)));
  const p = await projector(db, [native.lcsp, native.employer_lcsp]);
  return {
    data: {
      status: native.status,
      reason: native.reason ?? null,
      plan_start: native.plan_start,
      applicable_age: native.applicable_age ?? null,
      basis_sensitive: native.basis_sensitive ?? null,
      lcsps: [
        ...ichraLcsp(native.lcsp, "premium_tax_credit", p),
        ...ichraLcsp(native.employer_lcsp, "employer", p),
      ],
      monthly_hra_cents: native.monthly_hra_cents ?? null,
      required_contribution_percentage_bp:
        native.required_contribution_percentage_bp ?? null,
      verdicts: rows(native.verdicts),
      safe_harbors_applied: native.safe_harbors_applied ?? [],
      rules: rows(native.rules).map((rule) => ({
        id: rule.id,
        status: rule.status,
        citations: rows(rule.citations).map((c) => c.url),
      })),
      bindable_quote: false,
    },
    p,
    status: ICHRA_ENVELOPE[String(native.status)] ?? "unknown",
    context: { ...p.context, ichra: native },
    notes: [
      "Not a bindable quote; affordability is an estimate from public filed rates, not tax or legal advice.",
      "Employer safe-harbor verdicts apply to section 4980H only; rules marked proposed_reliance_permitted come from a proposed rule.",
    ],
  };
}

async function dispatch(
  deps: McpDependencies,
  tool: ToolName,
  value: unknown,
  offset: number,
): Promise<Answer> {
  const db = deps.db;
  switch (tool) {
    case "search":
      return searchAnswer(db, parseToolInput(tool, value), offset);
    case "fetch":
      return fetchAnswer(db, parseToolInput(tool, value), offset);
    case "get_plan":
      return planAnswer(db, parseToolInput(tool, value), offset);
    case "search_plans": {
      const input = parseToolInput(tool, value);
      let location: Row = {},
        nativeStatus: unknown;
      const page = await nativeWindow(offset, input.limit, async (page) => {
        const found = await catalog.searchPlans(
          db,
          params({
            ...input.location,
            year: input.year,
            metal: input.metal,
            csr_variant: input.csr_variant,
            page,
          }),
        );
        location = row(found.location);
        nativeStatus = found.status;
        return { items: found.plans, total: found.total };
      });
      const p = await projector(db, [page.items, location]);
      return {
        data: {
          plans: page.items.map(p.plan),
          location_status: location.status,
          counties: rows(location.counties).map(p.geography),
        },
        p,
        list: "plans",
        total: page.total,
        more: page.more,
        status: status(nativeStatus),
      };
    }
    case "quote_premiums": {
      if (!mayEstimate(deps)) throw new ToolError("AUTH_REQUIRED");
      const input = parseToolInput(tool, value),
        tax = input.household;
      const native = await catalog.estimatePremiums(db, {
        ...input.location,
        plan_ids: input.plan_refs.filter((id) => !id.includes(":")),
        plan_keys: input.plan_refs.filter((id) => id.includes(":")),
        coverage_start: input.coverage_start,
        members: input.members,
        csr_variant: input.csr_variant,
        ...(tax
          ? {
              household_income_annual: tax.income_annual,
              household_size: tax.size,
              tax_filing: tax.tax_filing,
            }
          : {}),
      });
      const p = await projector(db, native);
      const projected = native.estimates.map(p.estimate);
      return {
        data: { quotes: projected, bindable_quote: false },
        p,
        context: { ...p.context, estimates: native.estimates },
        notes: ["Quotes are not bindable. CSR eligibility is not evaluated."],
      };
    }
    case "quote_plans":
      return quoteAnswer(db, parseToolInput(tool, value), offset);
    case "check_ichra_affordability":
      if (!mayEstimate(deps)) throw new ToolError("AUTH_REQUIRED");
      return ichraAnswer(db, parseToolInput(tool, value));
    case "search_providers": {
      const input = parseToolInput(tool, value);
      if (input.npi) {
        const native = await providers.getProvider(
          db,
          input.npi,
          input.year?.toString(),
        );
        const found = rows(
            native.identity ? [native.identity] : native.issuer_records,
          ),
          p = await projector(db, found),
          page = slice(found, offset, input.limit);
        return {
          data: {
            providers: page.items.map((r) => p.provider(r, true)),
            unlocated: null,
          },
          p,
          list: "providers",
          total: page.total,
          more: page.more,
        };
      }
      let unlocated: unknown = null,
        nativeStatus: unknown;
      const page = await nativeWindow(offset, input.limit, async (page) => {
        const found = await providers.findProviders(
          db,
          params({ ...input, page }),
        );
        unlocated = found.meta.unlocated;
        nativeStatus = found.status;
        return { items: found.providers, total: found.total };
      });
      const p = await projector(db, page.items);
      return {
        data: {
          providers: page.items.map((r) => p.provider(r, !input.plan_id)),
          unlocated,
        },
        p,
        list: "providers",
        total: page.total,
        more: page.more,
        status: status(nativeStatus),
      };
    }
    case "search_drugs": {
      const input = parseToolInput(tool, value),
        page = await discoverDrugs(db, input, offset, input.limit),
        terminology = await drugs.drugTerminology(db);
      const p = await projector(db, page.items);
      return {
        data: {
          candidates: page.items.map(p.drug),
          exact_concept_required: true,
          terminology_status: terminology ? "available" : "unknown",
        },
        p,
        list: "candidates",
        total: page.total,
        more: page.more,
        status: terminology ? "ok" : "unknown",
        context: p.context,
      };
    }
    case "check_drug_coverage":
    case "check_provider_network": {
      const input = parseToolInput(tool, value),
        native =
          tool === "check_drug_coverage"
            ? await drugs.checkDrugCoverages(
                db,
                input,
                cmsFallbackContext(db, undefined),
              )
            : await providers.checkProviderNetworks(
                db,
                input,
                cmsFallbackContext(db, undefined),
              );
      const completeness = await sourceCompleteness(db, input.year);
      const p = await projector(db, native);
      const results = native.results.map((value) => {
        const id = String(row(value).requested_plan_id);
        return tool === "check_drug_coverage"
          ? p.coverage(value, completeness(id, "drug_coverage"))
          : p.participation(value, completeness(id, "provider_coverage"));
      });
      return { data: { results }, p };
    }
    case "lookup_geography": {
      const input = parseToolInput(tool, value),
        native = await catalog.lookupGeography(db, input),
        p = await projector(db, native);
      return {
        data: {
          zip: input.zip,
          resolution: native.status,
          counties: native.counties.map(p.geography),
        },
        p,
        status: status(native.status),
      };
    }
    case "search_medicare_plans": {
      const input = parseToolInput(tool, value);
      let native: Awaited<ReturnType<typeof searchMedicarePlans>> | undefined;
      const page = await nativeWindow(offset, input.limit, async (page) => {
        native = await searchMedicarePlans(
          db,
          params({
            ...(input.location.county
              ? { county_fips: input.location.county }
              : {}),
            ...(input.location.zip && !input.location.county
              ? { zip: input.location.zip }
              : {}),
            year: input.year,
            type: input.type,
            page,
          }),
        );
        return { items: native.plans, total: native.total };
      });
      const found = native!;
      const p = await projector(db, page.items);
      const cents = (cell: { status: string; cents: number | null }) =>
        cell.status === "value" ? cell.cents : null;
      return {
        data: {
          location_status:
            found.location.status === "multiple_counties"
              ? "multiple_counties"
              : found.location.status,
          county_fips: found.location.county_fips,
          contract_year: found.contract_year,
          as_of: "as_of" in found ? (found.as_of ?? null) : null,
          plans: page.items.map((plan) => ({
            kind: "medicare_plan" as const,
            plan_key: plan.plan_key,
            name: plan.name,
            plan_type: plan.plan_type,
            contract_category: plan.contract_category,
            organization: plan.organization.marketing_name,
            parent_organization: plan.organization.parent,
            consolidated_premium_cents: cents(
              plan.premiums_monthly.consolidated,
            ),
            part_d_deductible_cents: cents(plan.part_d.deductible),
            moop_in_network_cents: cents(plan.moop_in_network),
            overall_stars: plan.stars.overall.stars,
            star_status: plan.stars.overall.status,
            snp_type: plan.snp?.type ?? null,
            provider_network: "unknown" as const,
            ...p.evidence(plan.provenance),
          })),
          part_d_drug_data:
            found.part_d_drug_data.status === "available"
              ? "available"
              : (found.part_d_drug_data.reason ?? "unknown"),
        },
        p,
        list: "plans",
        total: page.total,
        more: page.more,
        status: medicareStatus[found.status] ?? "unknown",
      };
    }
    case "get_data_status": {
      const input = parseToolInput(tool, value),
        found = await datasets(db, input, offset);
      return {
        data: {
          datasets: found.records,
          personalized_access: mayEstimate(deps)
            ? "authorized"
            : "authentication_required",
          public_quoting: mayQuotePublic(deps) ? "enabled" : "disabled",
          loaded: found.native.entries.length > 0,
        },
        p: found.p,
        list: "datasets",
        total: found.total,
        more: found.more,
        status: found.native.entries.length ? "ok" : "unknown",
      };
    }
    case "list_carriers_networks": {
      const input = parseToolInput(tool, value),
        native = await catalog.listCarriersNetworks(
          db,
          input.kind,
          params(input),
        );
      const page = slice(rows(native[input.kind]), offset, input.limit),
        p = await projector(db, page.items);
      return {
        data: { rows: page.items.map((r) => p.directory(r, input.kind)) },
        p,
        list: "rows",
        total: page.total,
        more: page.more,
        status: status(native.status),
      };
    }
  }
}

export function toolResult(output: ToolOutput<ToolName>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
    ...(output.status === "error" ? { isError: true } : {}),
  };
}
/** Include both representations, modern metadata, framing and a bounded request-id reserve. */
export function messageBytes(
  output: ToolOutput<ToolName>,
  requestId: string | number = 0,
) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          ...toolResult(output),
          resultType: "complete",
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "openplans",
              version: applicationVersion,
            },
          },
        },
      }),
    ) + 512
  );
}
function pruneSources(output: Row, available: Map<string, Row>) {
  const refs = new Set<string>();
  function walk(value: unknown) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object")
      for (const [key, v] of Object.entries(value)) {
        if (key === "evidence_refs" && Array.isArray(v))
          for (const ref of v) refs.add(String(ref));
        else walk(v);
      }
  }
  walk(output.data);
  output.provenance = [...refs].map((id) => available.get(id)).filter(Boolean);
}
export function errorResult(
  tool: ToolName,
  error: unknown,
  generation: string,
  checkedAt: string,
) {
  let code;
  if (error instanceof ToolError) {
    code = error.code;
  } else if (error instanceof InputError) {
    code = error.code;
  } else if (error instanceof ReadError) {
    code = error.error.code;
  } else if (error instanceof ZodError) {
    code = "INVALID_INPUT";
  } else if (error instanceof HonestyError) {
    code = error.code;
  } else {
    code = "DATA_UNAVAILABLE";
  }
  let field;
  if (error instanceof ToolError) {
    field = error.field;
  } else if (error instanceof InputError) {
    field = error.field;
  } else if (error instanceof ReadError) {
    field = error.error.field ?? null;
  } else {
    field = null;
  }
  const output = {
    schema_version: "1" as const,
    status: "error" as const,
    data_generation: generation,
    data: null,
    provenance: [],
    notes: [],
    truncated: false,
    freshness: { checked_at: checkedAt, status: "unknown" as const },
    page: null,
    error: {
      code,
      field,
      retryable: [
        "DATA_UNAVAILABLE",
        "CURSOR_EXPIRED",
        "DATA_CHANGED",
      ].includes(code),
    },
  };
  assertHonest(tool, output);
  return toolResult(output);
}

export async function callTool(
  deps: McpDependencies,
  tool: ToolName,
  value: unknown,
  requestId: string | number = 0,
) {
  const now = deps.now ?? Date.now,
    checkedAt = new Date(now()).toISOString();
  let generation = "unknown";
  deps.onCache?.("bypass");
  try {
    if (PERSONALIZED_TOOLS.has(tool) && !mayEstimate(deps))
      throw new ToolError("AUTH_REQUIRED");
    if (tool === "quote_plans" && !mayQuotePublic(deps))
      throw new ToolError("QUOTING_DISABLED");
    const input = parseToolInput(tool, value),
      { cursor, ...filters } = input as Row;
    generation = await dataGeneration(deps.db);
    const codec = cursorCodec(deps.cursorSecret, now),
      binding: CursorBinding = {
        tool,
        filters,
        generation,
        scope: deps.principal?.id ?? "anonymous",
      };
    const offset = codec.read(cursor as string | undefined, binding);
    let context: HonestyContext = {};
    const load = async (): Promise<CatalogResult> => {
      const answer = await dispatch(deps, tool, input, offset);
      if ((await dataGeneration(deps.db)) !== generation)
        throw new ToolError("DATA_CHANGED");
      const data = answer.data,
        list = answer.list ? (data[answer.list] as unknown[]) : undefined;
      if (tool === "get_data_status") {
        data.personalized_access = "authentication_required";
        data.public_quoting = "disabled";
      }
      const output: Row = {
        schema_version: "1",
        status: answer.status ?? "ok",
        data_generation: generation,
        data,
        provenance: [],
        notes: answer.notes ?? [],
        truncated: false,
        freshness: { checked_at: checkedAt, status: "unknown" },
        page: null,
        error: null,
      };
      function complete() {
        pruneSources(output, answer.p.sources);
        const provenance = rows(output.provenance);
        output.freshness = {
          checked_at: checkedAt,
          status:
            provenance.length && provenance.every((s) => s.retrieved_at)
              ? "current_local"
              : "unknown",
        };
        if (list) {
          const more = Boolean(answer.more) || output.truncated === true;
          output.page = {
            next_cursor: more
              ? codec.issue(binding, offset + list.length)
              : null,
            returned: list.length,
            total: answer.total ?? null,
          };
          output.truncated = more;
        }
      }
      complete();
      while (
        rows(output.provenance).length > 100 ||
        messageBytes(output as ToolOutput<ToolName>, requestId) >
          MAX_OUTPUT_BYTES
      ) {
        if (!list || list.length <= 1) throw new ToolError("RESULT_TOO_LARGE");
        list.pop();
        output.truncated = true;
        complete();
      }
      context = answer.context ?? answer.p.context;
      assertHonest(tool, output, context);
      // Cursor signatures and caller access are request data, never shared cache data.
      if (output.page) row(output.page).next_cursor = null;
      return {
        output,
        snapshotIds: [...(context.snapshotIds ?? [])],
        drugs: (context.drugs ?? []).map(({ rxcui, name, tty, suppress }) => ({
          rxcui,
          name,
          tty,
          suppress,
        })),
      };
    };
    const cacheable = !QUOTING_TOOLS.has(tool);
    const dto = cacheable
      ? await (deps.cache ?? sharedResponseCache(deps.db)).catalog(
          {
            namespace: `mcp:${tool}`,
            version: `${applicationVersion}:mcp-dto-v1`,
            generation,
            query: {
              filters,
              offset,
              request_id_bytes: Buffer.byteLength(JSON.stringify(requestId)),
            },
            authorized: () => cacheable,
            ttlSeconds: tool === "lookup_geography" ? 300 : 60,
            accept: (value): value is CatalogResult => {
              try {
                const dto = value as CatalogResult;
                assertHonest(tool, dto.output, honestyContext(dto));
                return (
                  dto.output.status !== "error" &&
                  dto.output.data_generation === generation &&
                  (!dto.output.page ||
                    row(dto.output.page).next_cursor === null)
                );
              } catch {
                return false;
              }
            },
            outcome: deps.onCache,
          },
          load,
        )
      : await load();
    const output = dto.output;
    // Recheck publication even on a hit; never return a page straddling two generations.
    if ((await dataGeneration(deps.db)) !== generation)
      throw new ToolError("DATA_CHANGED");
    row(output.freshness).checked_at = checkedAt;
    if (tool === "get_data_status") {
      row(output.data).personalized_access = mayEstimate(deps)
        ? "authorized"
        : "authentication_required";
      row(output.data).public_quoting = mayQuotePublic(deps)
        ? "enabled"
        : "disabled";
    }
    if (output.page && output.truncated)
      row(output.page).next_cursor = codec.issue(
        binding,
        offset + Number(row(output.page).returned),
      );
    assertHonest(tool, output, { ...context, ...honestyContext(dto) });
    if (messageBytes(output, requestId) > MAX_OUTPUT_BYTES)
      throw new ToolError("RESULT_TOO_LARGE");
    return toolResult(output);
  } catch (error) {
    return errorResult(tool, error, generation, checkedAt);
  }
}
