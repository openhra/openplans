/** One base plan of an issuer's active catalog for a plan year. */
export interface CatalogPlan {
  basePlanId: string;
  planName: string;
}

export type PlanLinkStatus =
  "attached" | "plan_mapping_ambiguous" | "plan_not_in_catalog";

export interface PlanLink {
  coverName: string;
  status: PlanLinkStatus;
  /** Set only when `status` is `attached`. */
  basePlanId: string | null;
  candidates: number;
}

/**
 * The comparable form of a marketing name: trailing parenthetical notes dropped ("(2 Free PCP
 * Visits)"), whitespace collapsed, case folded. Nothing else is rewritten: "Plus" never becomes
 * "+", and no word is dropped, so "Bronze Plus" and "Bronze + Dental & Vision" stay different.
 */
export function nameKey(name: string): string {
  let key = name.replace(/\s+/g, " ").trim();
  for (let last = ""; last !== key;) {
    last = key;
    key = key.replace(/\s*\([^()]*\)$/, "").trim();
  }
  return key.toLowerCase();
}

/**
 * Benefit add-ons a catalog name can append to a medical plan's name, joined by one of
 * `ADD_ON_JOINS`. The list is fixed: extend it only for an add-on an issuer prints, never with
 * a word that names a plan (a metal level, "Plus", "Essential", "Limited", a CSR number).
 */
export const ADD_ONS = Object.freeze([
  "dental & vision",
  "dental and vision",
  "dental",
  "vision",
  "fitness",
] as const);
export const ADD_ON_JOINS = Object.freeze([
  "+",
  "plus",
  "with",
  "&",
  "and",
] as const);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ADD_ON_SUFFIX = new RegExp(
  ` (?:${ADD_ON_JOINS.map(escape).join("|")}) (?:${ADD_ONS.map(escape).join("|")})$`,
);

/**
 * `nameKey` with trailing add-on suffixes removed, repeatedly: "Bronze + Dental & Vision",
 * "Bronze Plus Dental & Vision" and "Gold + Dental & Vision + Fitness" become "bronze" and
 * "gold". A join word alone is never removed, so "Bronze Plus" stays "bronze plus".
 */
export function baseNameKey(name: string): string {
  let key = nameKey(name);
  for (let last = ""; last !== key;) {
    last = key;
    key = key.replace(ADD_ON_SUFFIX, "");
  }
  return key;
}

/**
 * The words every catalog name of the issuer starts with (an issuer brand such as "Example"),
 * which covers usually leave out. Empty when the issuer has fewer than two plans.
 */
function sharedPrefix(keys: readonly string[]): string[] {
  if (keys.length < 2) return [];
  const split = keys.map((key) => key.split(" "));
  const prefix: string[] = [];
  for (let at = 0; split.every((words) => words.length > at + 1); at++) {
    const word = split[0]![at]!;
    if (!split.every((words) => words[at] === word)) break;
    prefix.push(word);
  }
  return prefix;
}

/** Catalog plans by comparable name, with the issuer's shared leading words removed. */
function indexCatalog(
  catalog: readonly CatalogPlan[],
  key: (name: string) => string,
): { lookup: (name: string) => CatalogPlan[] } {
  const keys = catalog.map((plan) => key(plan.planName));
  const prefix = sharedPrefix(keys).join(" ");
  const strip = (value: string) =>
    prefix && value.startsWith(`${prefix} `)
      ? value.slice(prefix.length + 1)
      : value;
  const byName = new Map<string, CatalogPlan[]>();
  catalog.forEach((plan, index) => {
    const name = strip(keys[index]!);
    byName.set(name, [...(byName.get(name) ?? []), plan]);
  });
  return { lookup: (name) => byName.get(strip(key(name))) ?? [] };
}

/**
 * Match the plan names printed on a document's cover to one issuer's catalog for the plan year.
 * A cover name matches a catalog name when their `nameKey`s are equal, ignoring the issuer's
 * shared leading words. Only a name with no plan of that exact name is tried again with
 * `baseNameKey` on both sides. Either way it is attached only when exactly one catalog plan matches; two or
 * more is `plan_mapping_ambiguous`, none is `plan_not_in_catalog`. Unattached names leave those
 * plans `unknown`.
 */
export function matchCoverPlans(
  coverNames: readonly string[],
  catalog: readonly CatalogPlan[],
): PlanLink[] {
  const exact = indexCatalog(catalog, nameKey);
  const base = indexCatalog(catalog, baseNameKey);
  const links = new Map<string, PlanLink>();
  for (const coverName of coverNames) {
    if (links.has(coverName)) continue;
    let candidates = exact.lookup(coverName);
    if (!candidates.length) candidates = base.lookup(coverName);
    let status: PlanLinkStatus = "plan_not_in_catalog";
    if (candidates.length === 1) status = "attached";
    else if (candidates.length > 1) status = "plan_mapping_ambiguous";
    links.set(coverName, {
      coverName,
      status,
      basePlanId: status === "attached" ? candidates[0]!.basePlanId : null,
      candidates: candidates.length,
    });
  }
  return [...links.values()];
}

/**
 * A plan that two documents of one run both claim for the same plan year is ambiguous for both:
 * the run cannot say which document's list applies to it.
 */
export function resolveSharedClaims(
  documents: readonly { key: string; planYear: number; links: PlanLink[] }[],
): void {
  const claim = (planYear: number, link: PlanLink) =>
    `${planYear}:${link.basePlanId}`;
  const claims = new Map<string, Set<string>>();
  for (const { key, planYear, links } of documents)
    for (const link of links)
      if (link.basePlanId) {
        const id = claim(planYear, link);
        claims.set(id, (claims.get(id) ?? new Set()).add(key));
      }
  for (const { planYear, links } of documents)
    for (const link of links)
      if (link.basePlanId && claims.get(claim(planYear, link))!.size > 1) {
        link.status = "plan_mapping_ambiguous";
        link.basePlanId = null;
      }
}
