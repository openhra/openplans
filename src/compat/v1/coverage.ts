import type { SqlSession } from "../../db/database.js";
import type { CmsFallbackContext } from "../../ingest/cms-api/fallback.js";
import {
  applyQuoteFallback,
  readQuoteCoverage,
} from "../../services/quote-coverage.js";
import * as v from "../../api/validation.js";

function entries(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) return v.fail(field);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return v.fail(field);
    return item as Record<string, unknown>;
  });
}

/** Uses explicit RxCUIs only. Package IDs are echoed, never translated into drug identities. */
export async function compatQuoteCoverage(
  db: SqlSession,
  plans: Record<string, unknown>[],
  body: Record<string, unknown>,
  year: number,
  cms: CmsFallbackContext,
  reasons: Set<string>,
) {
  const npis = entries(body.providers, "providers").map((p) => {
    const npi = String(p.npi);
    if (!/^\d{10}$/.test(npi)) return v.fail("providers.npi");
    return npi;
  });
  const packages = entries(body.drug_packages, "drug_packages").map((p) => {
    const id = p.id ?? p.med_id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))
    )
      return v.fail("drug_packages.id");
    if (
      p.rx_cui_id !== undefined &&
      (typeof p.rx_cui_id !== "string" || !/^\d+$/.test(p.rx_cui_id))
    )
      return v.fail("drug_packages.rx_cui_id");
    return { id, rxcui: p.rx_cui_id as string | undefined };
  });
  if (
    plans.length * (npis.length + packages.length) >
    v.PUBLIC_QUOTE_LIMITS.pairs
  )
    return v.fail("providers", "TOO_MANY_PAIRS");
  const rxcuis = [
    ...new Set(packages.flatMap((p) => (p.rxcui ? [p.rxcui] : []))),
  ];
  const local = [];
  for (const plan of plans)
    local.push(
      await readQuoteCoverage(db, String(plan.id), npis, rxcuis, year),
    );
  const coverage = await applyQuoteFallback(local, cms);
  const coverages = [];
  for (const [index, cells] of coverage.entries()) {
    const plan = plans[index]!;
    const label = (
      kind: string,
      id: string,
      answer: (typeof cells.providers)[number] | (typeof cells.drugs)[number],
    ) => {
      const source = answer.cms_api;
      reasons.add(
        `coverage:${String(plan.id)}:${kind}:${id}:${answer.status}${answer.reason ? `:${answer.reason}` : ""}${source ? `:sourced_by=${source.sourced_by}:freshness=${source.freshness}` : ""}`,
      );
    };
    plan.providers = cells.providers.map((answer) => {
      label("provider", answer.identity, answer);
      let inNetwork: boolean | null = null;
      if (answer.status === "listed_participating") inNetwork = true;
      if (answer.status === "explicitly_not_participating") inNetwork = false;
      return {
        npi: Number(answer.identity),
        in_network: inNetwork,
        addresses: [],
      };
    });
    for (const pkg of packages) {
      const answer = cells.drugs.find((d) => d.rxcui === pkg.rxcui);
      if (answer) label("drug", String(pkg.id), answer);
      else
        reasons.add(
          `coverage:${String(plan.id)}:drug:${String(pkg.id)}:unknown:drug_identity_requires_rxnorm`,
        );
      coverages.push({
        plan_id: plan.id,
        drug_package_id: pkg.id,
        tier:
          answer?.status === "explicitly_not_covered"
            ? "not_covered"
            : (answer?.drug_tier ?? null),
        prior_authorization: answer?.prior_authorization ?? null,
        step_therapy: answer?.step_therapy ?? null,
        quantity_limit: answer?.quantity_limit ?? null,
      });
    }
  }
  reasons.delete("provider_and_drug_coverage_unavailable");
  if (packages.length) reasons.add("drug_coverage_flag_does_not_supply_tier");
  return coverages;
}
