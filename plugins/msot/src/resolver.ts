import { createHash } from "node:crypto";
import type {
  CanonicalReader,
  CatalogPolicyInput,
  McpToolContext,
  CanonicalPlan,
} from "@openplans/plugin-sdk";
import { MARKETABLE, resolveInput, sourceSchema } from "./schema.js";
import type {
  Source,
  Rule,
  Scope,
  Resolution,
  FieldResolution,
} from "./schema.js";

const dimensions = ["issuer_id", "state", "market_segment"] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const rank = (scope: Scope) => Object.keys(scope).length;
const indexKey = (scope: Scope) => canonical(scope);
const active = (rule: Rule, date: string) =>
  rule.valid_from <= date &&
  (rule.valid_until === null || date < rule.valid_until);

export function compileSource(raw: unknown, reader: CanonicalReader) {
  const source: Source = sourceSchema.parse(raw);
  const definitions = new Map(source.fields.map((f) => [f.name, f]));
  if (definitions.size !== source.fields.length)
    throw new Error("msot_duplicate_definition");
  const ids = new Set<string>();
  let comparisons = 0;
  for (const rule of source.rules) {
    if (!definitions.has(rule.field)) throw new Error("msot_field_undefined");
    for (const dimension of dimensions)
      if (rule.scope[dimension] === "*") delete rule.scope[dimension];
    if (ids.has(rule.id)) throw new Error("msot_duplicate_rule");
    ids.add(rule.id);
    if (rule.valid_until !== null && rule.valid_until <= rule.valid_from)
      throw new Error("msot_invalid_window");
  }
  for (let i = 0; i < source.rules.length; i++) {
    const a = source.rules[i]!;
    for (let j = i + 1; j < source.rules.length; j++) {
      if (++comparisons > 100000) throw new Error("msot_validation_budget");
      const b = source.rules[j]!;
      if (a.field !== b.field || rank(a.scope) !== rank(b.scope)) continue;
      const overlap = dimensions.every(
        (d) =>
          a.scope[d] === undefined ||
          b.scope[d] === undefined ||
          a.scope[d] === b.scope[d],
      );
      if (
        overlap &&
        (a.valid_until === null || b.valid_from < a.valid_until) &&
        (b.valid_until === null || a.valid_from < b.valid_until)
      )
        throw new Error("msot_equal_rank_overlap");
    }
  }
  source.rules.sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash("sha256").update(canonical(source)).digest("hex");
  freeze(source);
  const index = new Map<string, Rule[]>();
  for (const rule of source.rules) {
    const key = `${rule.field}:${indexKey(rule.scope)}`;
    const group = index.get(key) ?? [];
    group.push(rule);
    index.set(key, group);
  }
  function choose(
    plan: CanonicalPlan,
    segment: string,
    date: string,
    field: string,
  ) {
    const facts = {
      issuer_id: plan.issuer_id,
      state: plan.state,
      market_segment: segment === "unknown" ? null : segment,
    };
    const candidates = new Set<Rule>();
    // Eight equality/wildcard masks. Unknown facts use bounded metadata candidates.
    if (Object.values(facts).some((v) => v === null)) {
      for (const rule of source.rules)
        if (
          rule.field === field &&
          dimensions.every(
            (d) =>
              rule.scope[d] === undefined ||
              facts[d] === null ||
              rule.scope[d] === facts[d],
          )
        )
          candidates.add(rule);
    } else {
      for (let mask = 0; mask < 8; mask++) {
        const scope: Record<string, string> = {};
        dimensions.forEach((d, bit) => {
          if (mask & (1 << bit)) scope[d] = facts[d]!;
        });
        for (const rule of index.get(`${field}:${indexKey(scope)}`) ?? [])
          candidates.add(rule);
      }
    }
    return [...candidates]
      .filter((r) => active(r, date))
      .sort(
        (a, b) =>
          rank(b.scope) - rank(a.scope) ||
          Number(
            dimensions.some(
              (d) => b.scope[d] !== undefined && facts[d] === null,
            ),
          ) -
            Number(
              dimensions.some(
                (d) => a.scope[d] !== undefined && facts[d] === null,
              ),
            ),
      );
  }
  return Object.freeze({
    source,
    hash,
    async resolve(
      rawInput: CatalogPolicyInput,
      scope: McpToolContext,
    ): Promise<Resolution> {
      const input = resolveInput.parse(rawInput);
      if (input.source_id !== source.source_id)
        throw new Error("msot_source_not_readable");
      if (input.version !== undefined && input.version !== source.version)
        throw new Error("msot_version_unavailable");
      const date = input.as_of ?? new Date().toISOString().slice(0, 10);
      const batch = await reader.plans(
        { plan_ids: input.plan_ids, year: input.year },
        scope,
      );
      scope.signal.throwIfAborted();
      const provenance = new Map<
        string,
        Resolution["msot"]["provenance"][number]
      >();
      // Retained versions keep their hash; absent built-in decisions stay unknown.
      const effectiveDefinitions = [...source.fields];
      for (const name of ["custom_payment_allowed", MARKETABLE] as const) {
        if (!effectiveDefinitions.some((f) => f.name === name))
          effectiveDefinitions.push({
            ...source.fields[0]!,
            name,
            filterable: name === MARKETABLE,
            visibility: {
              audience: "answer",
              rest: true,
              compat: name === MARKETABLE,
              mcp: true,
            },
            set_by: "openplans",
            description: "Operator decision",
          });
      }
      const plans = batch.plans.map((plan) => {
        if (
          !source.product_families.includes(plan.product_family) ||
          !source.business_markets.some((m) => m === plan.business_market)
        )
          throw new Error("msot_scope_unsupported");
        let segments: string[] = input.market_segment
          ? [input.market_segment]
          : ["on_exchange", "off_exchange"].filter(
              (s) => plan[s as "on_exchange" | "off_exchange"] === true,
            );
        if (
          !input.market_segment &&
          (plan.on_exchange === null || plan.off_exchange === null)
        )
          segments.push("unknown");
        if (!segments.length) segments = ["unknown"];
        const channels: Resolution["plans"][number]["msot"]["by_market_segment"] =
          {};
        for (const segment of segments) {
          const flag =
            segment === "unknown"
              ? null
              : plan[segment as "on_exchange" | "off_exchange"];
          const fields = {} as Record<
            "custom_payment_allowed" | "marketable",
            FieldResolution
          >;
          for (const definition of effectiveDefinitions) {
            const candidates =
              flag === false
                ? []
                : choose(plan, segment, date, definition.name);
            const rule = candidates[0];
            const missing =
              !!rule &&
              dimensions.some(
                (d) =>
                  rule.scope[d] !== undefined &&
                  (d === "market_segment" ? flag === null : plan[d] === null),
              );
            let reason = "no_matching_rule";
            if (flag === false) reason = "channel_inapplicable";
            else if (missing) reason = "insufficient_scope_evidence";
            const selected = missing ? undefined : rule;
            const unresolved = dimensions.filter(
              (d) =>
                rule?.scope[d] !== undefined &&
                (d === "market_segment" ? flag === null : plan[d] === null),
            );
            const candidateIds = missing
              ? candidates
                  .filter((r) => rank(r.scope) === rank(rule!.scope))
                  .map((r) => r.id)
              : [];
            const origin = selected ? "msot" : "msot_default";
            const ref = selected
              ? `rule:${selected.id}:matched`
              : `default:${definition.name}:${reason}:${candidateIds.join(",")}:${unresolved.join(",")}`;
            const value = rule && !missing ? rule.value : definition.default;
            provenance.set(ref, {
              id: ref,
              origin,
              source_id: source.source_id,
              version: source.version,
              definition: `${definition.name}@${definition.definition_version}`,
              rule_id: selected?.id ?? null,
              matched_scope: selected?.scope ?? null,
              set_by: selected?.set_by ?? definition.set_by,
              set_at: selected?.set_at ?? definition.set_at,
              valid_from: selected?.valid_from ?? null,
              valid_until: selected?.valid_until ?? null,
              reason_code: rule && !missing ? rule.reason_code : reason,
              ...(missing
                ? {
                    unresolved_dimensions: unresolved,
                    candidate_rule_ids: candidateIds,
                  }
                : {}),
            });
            fields[definition.name] = {
              ...value,
              origin,
              provenance_ref: ref,
              public: { state: "not_defined", value: null },
            };
          }
          let applicability: "unknown" | "applicable" | "inapplicable" =
            "unknown";
          if (flag === true) applicability = "applicable";
          else if (flag === false) applicability = "inapplicable";
          channels[segment as keyof typeof channels] = {
            applicability,
            fields,
          };
        }
        return {
          id: plan.id,
          public: plan,
          msot: { by_market_segment: channels },
        };
      });
      return {
        msot: {
          source_id: source.source_id,
          version: source.version,
          version_hash: hash,
          as_of: date,
          catalog_generation: batch.catalog_generation,
          evaluator_version: 1,
          dimension_schema_version: 1,
          provenance: [...provenance.values()],
          field_definitions: effectiveDefinitions.map(
            ({ name, filterable, visibility }) => ({
              name,
              filterable,
              visibility,
            }),
          ),
        },
        plans,
      };
    },
  });
}
