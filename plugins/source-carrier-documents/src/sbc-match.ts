import { nameKey } from "./match.js";
import type { PlanLinkStatus } from "./match.js";

/** One plan variant of an issuer's active catalog for a plan year. */
export interface CatalogVariant {
  variantPlanId: string;
  basePlanId: string;
  /** The variant's marketing name; the base plan's name when the catalog prints none. */
  name: string;
}

export interface SbcPlanLink {
  method: "hios_file_name" | "marketing_name" | "none";
  status: PlanLinkStatus;
  /** Set only when `status` is `attached`: every variant the document describes. */
  variantPlanIds: string[];
  /** Distinct base plans among the candidates. */
  candidates: number;
}

const STANDARD_SUFFIXES = ["-00", "-01"];

/** The words every variant name of the issuer starts with (a brand such as "Example"). */
function sharedPrefix(keys: readonly string[]): string {
  if (keys.length < 2) return "";
  const split = keys.map((key) => key.split(" "));
  const prefix: string[] = [];
  for (let at = 0; split.every((words) => words.length > at + 1); at++) {
    const word = split[0]![at]!;
    if (!split.every((words) => words[at] === word)) break;
    prefix.push(word);
  }
  return prefix.join(" ");
}

function link(
  method: SbcPlanLink["method"],
  variants: readonly CatalogVariant[],
): SbcPlanLink {
  const bases = new Set(variants.map((variant) => variant.basePlanId));
  if (bases.size === 1)
    return {
      method,
      status: "attached",
      variantPlanIds: variants.map((variant) => variant.variantPlanId).sort(),
      candidates: 1,
    };
  return {
    method,
    status: bases.size ? "plan_mapping_ambiguous" : "plan_not_in_catalog",
    variantPlanIds: [],
    candidates: bases.size,
  };
}

/**
 * Map one SBC to the variants it describes, in the issuer's active catalog for the year of its
 * printed coverage period.
 *
 * 1. **HIOS id in the file name.** When the file name carries HIOS ids, they decide, and each must
 *    also be in the catalog: a variant id names that variant; a base id names the base plan's
 *    standard variants (`-00`, `-01`). An id that is not in the catalog, or ids naming two base
 *    plans, attach nothing: the name is not tried instead.
 * 2. **Marketing name**, only without a HIOS id. The printed plan name must equal a
 *    variant's marketing name after `nameKey` (trailing notes dropped, case and spacing ignored)
 *    and without the brand words every variant name starts with. Variants of one base plan that
 *    share the name (the on- and off-exchange variants) are attached together; a name shared by
 *    variants of two or more base plans is `plan_mapping_ambiguous`; none is `plan_not_in_catalog`.
 */
export function mapSbcPlan(
  fileHiosIds: readonly string[],
  printedName: string | null,
  catalog: readonly CatalogVariant[],
): SbcPlanLink {
  if (fileHiosIds.length) {
    const named: CatalogVariant[] = [];
    for (const id of fileHiosIds) {
      const found =
        id.length === 17
          ? catalog.filter((variant) => variant.variantPlanId === id)
          : catalog.filter(
              (variant) =>
                variant.basePlanId === id &&
                STANDARD_SUFFIXES.includes(variant.variantPlanId.slice(14)),
            );
      if (!found.length)
        return {
          method: "hios_file_name",
          status: "plan_not_in_catalog",
          variantPlanIds: [],
          candidates: 0,
        };
      named.push(...found);
    }
    return link("hios_file_name", [
      ...new Map(named.map((v) => [v.variantPlanId, v])).values(),
    ]);
  }
  if (!printedName)
    return {
      method: "none",
      status: "plan_not_in_catalog",
      variantPlanIds: [],
      candidates: 0,
    };
  const keys = catalog.map((variant) => nameKey(variant.name));
  const prefix = sharedPrefix(keys);
  const strip = (key: string) =>
    prefix && key.startsWith(`${prefix} `) ? key.slice(prefix.length + 1) : key;
  const wanted = strip(nameKey(printedName));
  return link(
    "marketing_name",
    catalog.filter((_, index) => strip(keys[index]!) === wanted),
  );
}

/**
 * A variant two documents of one run both claim for the same year is ambiguous for both: the run
 * cannot say which document describes it.
 */
export function resolveSharedSbcClaims(
  documents: readonly { key: string; planYear: number; link: SbcPlanLink }[],
): void {
  const owners = new Map<string, Set<string>>();
  for (const { key, planYear, link } of documents)
    for (const id of link.variantPlanIds)
      owners.set(
        `${planYear}:${id}`,
        (owners.get(`${planYear}:${id}`) ?? new Set()).add(key),
      );
  for (const { planYear, link } of documents)
    if (
      link.variantPlanIds.some(
        (id) => owners.get(`${planYear}:${id}`)!.size > 1,
      )
    ) {
      link.status = "plan_mapping_ambiguous";
      link.candidates = Math.max(link.candidates, 2);
      link.variantPlanIds = [];
    }
}
