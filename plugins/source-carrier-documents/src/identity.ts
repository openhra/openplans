import { MAX_CANDIDATES } from "@openplans/plugin-sdk";
import type { DrugNameCandidate } from "@openplans/plugin-sdk";

/**
 * Reading a formulary row's printed drug name for the RxCUI join (plan §4, D-PDF-4). A printed
 * name reaches an RxCUI only when exactly one RxNorm candidate has the same ingredients (or brand),
 * the same strengths and the same dose form; anything else stays unresolved. Nothing here guesses:
 * a form, unit or name this module cannot read leaves the row unresolved with a reason.
 */

/** Why a row's printed name cannot be asked about, or matched to one concept. */
export const IDENTITY_UNRESOLVED = Object.freeze({
  nameUnreadable: "name_unreadable",
  formNotMapped: "dose_form_not_mapped",
  strengthMissing: "strength_missing",
  strengthUnreadable: "strength_unreadable",
  ingredientStrengthCount: "ingredient_strength_count",
  noCandidate: "no_candidate",
  truncated: "candidate_list_truncated",
  noMatch: "no_matching_candidate",
  ambiguous: "several_matching_candidates",
  notConfirmed: "rxcui_not_confirmed",
});

/** A strength in a comparable unit: masses in MG, concentrations in MG/ML. */
export interface Strength {
  value: number;
  unit: string;
}

/** A printed name read into the parts a candidate must match. */
export interface ReadName {
  kind: "generic" | "brand";
  /** What the name search is asked: the first ingredient's base name, or the brand name. */
  query: string;
  /** Generic rows: each ingredient's words and its salt words, in printed order. */
  ingredients: { base: string; salts: string[] }[];
  /** Brand rows: the brand words as printed, lower case. */
  brand: string | null;
  strengths: Strength[];
  /** The RxNorm dose form the printed form stands for. */
  doseForm: string;
}

export type NameReading =
  { ok: true; name: ReadName } | { ok: false; reason: string };

/**
 * Printed dose forms whose RxNorm dose form is certain. Anything else (extended release, injection,
 * kits, sprays, solutions with a volume) is not mapped, so its row stays unresolved.
 */
export const GENERIC_FORMS: Readonly<Record<string, string>> = Object.freeze({
  tab: "Oral Tablet",
  cap: "Oral Capsule",
  "chew tab": "Chewable Tablet",
  "orally disintegrating tab": "Disintegrating Oral Tablet",
});
export const BRAND_FORMS: Readonly<Record<string, string>> = Object.freeze({
  tab: "Oral Tablet",
  cap: "Oral Capsule",
  chw: "Chewable Tablet",
});
/** Words that start a printed dose form in a generic row. */
const GENERIC_FORM_START = new Set([
  "tab",
  "cap",
  "chew",
  "orally",
  "inj",
  "soln",
  "susp",
  "for",
  "cream",
  "oint",
  "gel",
  "lotion",
  "patch",
  "powder",
  "pack",
  "kit",
  "spray",
  "aerosol",
  "solution",
  "suspension",
  "syrup",
  "elixir",
  "drops",
  "supp",
  "nebu",
  "shampoo",
  "foam",
  "film",
  "lozenge",
  "troche",
  "pen-injector",
  "prefilled",
  "auto-injector",
  "ophth",
  "otic",
  "nasal",
  "vaginal",
  "rectal",
  "topical",
  "transdermal",
  "er",
  "dr",
  "ec",
  "sr",
  "odt",
]);

/** Salt words as printed, with RxNorm's spelling. */
const SALTS: Readonly<Record<string, string>> = Object.freeze({
  hcl: "hydrochloride",
  hydrochloride: "hydrochloride",
  hbr: "hydrobromide",
  hydrobromide: "hydrobromide",
  sodium: "sodium",
  na: "sodium",
  potassium: "potassium",
  k: "potassium",
  calcium: "calcium",
  magnesium: "magnesium",
  sulfate: "sulfate",
  phosphate: "phosphate",
  acetate: "acetate",
  citrate: "citrate",
  maleate: "maleate",
  mesylate: "mesylate",
  besylate: "besylate",
  tartrate: "tartrate",
  succinate: "succinate",
  fumarate: "fumarate",
  bromide: "bromide",
  chloride: "chloride",
  dihydrate: "dihydrate",
  monohydrate: "monohydrate",
  trihydrate: "trihydrate",
});

const MASS_IN_MG: Readonly<Record<string, number>> = Object.freeze({
  mg: 1,
  mcg: 0.001,
  g: 1000,
  gm: 1000,
});
/** Units compared as they are, never converted. */
const PLAIN_UNITS: Readonly<Record<string, string>> = Object.freeze({
  "%": "%",
  meq: "MEQ",
  unt: "UNT",
  unit: "UNT",
  units: "UNT",
});

const NUMBER = String.raw`\d+(?:\.\d+)?|\.\d+`;
const words = (text: string) => text.split(" ").filter(Boolean);

function strengthOf(
  value: number,
  unit: string,
  volume?: number,
): Strength | null {
  const key = unit.toLowerCase();
  if (MASS_IN_MG[key] !== undefined) {
    const mg = value * MASS_IN_MG[key]!;
    if (volume === undefined) return { value: mg, unit: "MG" };
    return volume > 0 ? { value: mg / volume, unit: "MG/ML" } : null;
  }
  if (volume !== undefined) return null;
  return PLAIN_UNITS[key] ? { value, unit: PLAIN_UNITS[key]! } : null;
}

/**
 * A printed strength: `10 mg`, `10-12.5 mg`, `75 mcg`, `0.05%`, `50 mg/5ml`, `500MG`, `50-20MG`,
 * `0.6MG/ML`. Several values share the unit. Null when the text is not exactly that.
 */
export function readStrengths(text: string): Strength[] | null {
  const match = new RegExp(
    String.raw`^((?:${NUMBER})(?:-(?:${NUMBER}))*)\s*(mg|mcg|gm|g|%|meq|units?)(?:/\s*(${NUMBER})?\s*ml)?$`,
    "i",
  ).exec(text.trim());
  if (!match) return null;
  const volume = match[0].toLowerCase().includes("/")
    ? Number(match[3] ?? "1")
    : undefined;
  const values = match[1]!.split("-").map(Number);
  const read = values.map((value) => strengthOf(value, match[2]!, volume));
  return read.every((s) => s !== null) ? (read as Strength[]) : null;
}

/** Parenthetical notes such as `(base equiv)` or `(trihydrate)` are not part of the name. */
const withoutNotes = (text: string) =>
  text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function ingredient(text: string) {
  const parts = words(text.toLowerCase());
  return {
    base: parts.filter((word) => !SALTS[word]).join(" "),
    salts: parts.filter((word) => SALTS[word]).map((word) => SALTS[word]!),
  };
}

function readGeneric(name: string): NameReading {
  const tokens = words(withoutNotes(name).toLowerCase());
  const formAt = tokens.findIndex((token) => GENERIC_FORM_START.has(token));
  const strengthAt = tokens.findIndex((token) => /^[.\d]/.test(token));
  if (formAt <= 0)
    return { ok: false, reason: IDENTITY_UNRESOLVED.nameUnreadable };
  if (strengthAt < 0)
    return { ok: false, reason: IDENTITY_UNRESOLVED.strengthMissing };
  if (strengthAt < formAt)
    return { ok: false, reason: IDENTITY_UNRESOLVED.nameUnreadable };
  const doseForm = GENERIC_FORMS[tokens.slice(formAt, strengthAt).join(" ")];
  if (!doseForm)
    return { ok: false, reason: IDENTITY_UNRESOLVED.formNotMapped };
  const strengths = readStrengths(tokens.slice(strengthAt).join(" "));
  if (!strengths)
    return { ok: false, reason: IDENTITY_UNRESOLVED.strengthUnreadable };
  const ingredients = tokens
    .slice(0, formAt)
    .join(" ")
    .split(/\s*(?:&|\bw\/|\/|-(?=[a-z]{3,}\b(?!-)))\s*/)
    .map(ingredient);
  if (ingredients.some((part) => !part.base))
    return { ok: false, reason: IDENTITY_UNRESOLVED.nameUnreadable };
  if (ingredients.length !== strengths.length)
    return { ok: false, reason: IDENTITY_UNRESOLVED.ingredientStrengthCount };
  return {
    ok: true,
    name: {
      kind: "generic",
      query: ingredients[0]!.base,
      ingredients,
      brand: null,
      strengths,
      doseForm,
    },
  };
}

function readBrand(name: string): NameReading {
  const tokens = words(withoutNotes(name).toLowerCase());
  const formAt = tokens.findIndex((token) => BRAND_FORMS[token] !== undefined);
  if (formAt <= 0)
    return { ok: false, reason: IDENTITY_UNRESOLVED.formNotMapped };
  const rest = tokens.slice(formAt + 1);
  if (!rest.length)
    return { ok: false, reason: IDENTITY_UNRESOLVED.strengthMissing };
  const strengths = readStrengths(rest.join(" "));
  if (!strengths)
    return { ok: false, reason: IDENTITY_UNRESOLVED.strengthUnreadable };
  const brand = tokens.slice(0, formAt).join(" ");
  return {
    ok: true,
    name: {
      kind: "brand",
      query: brand,
      ingredients: [],
      brand,
      strengths,
      doseForm: BRAND_FORMS[tokens[formAt]!]!,
    },
  };
}

/**
 * Reads a printed name. A name without lower-case letters is a brand row (`VELPHORO CHW 500MG`);
 * any other is a generic row (`metformin hcl tab 500 mg`).
 */
export function readPrintedName(name: string): NameReading {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!/[a-z]/i.test(trimmed))
    return { ok: false, reason: IDENTITY_UNRESOLVED.nameUnreadable };
  return /[a-z]/.test(trimmed) ? readGeneric(trimmed) : readBrand(trimmed);
}

/** One RxNorm clinical or branded drug name split into its parts. */
interface ConceptName {
  components: {
    ingredient: { base: string; salts: string[] };
    strength: Strength;
  }[];
  doseForm: string;
  brand: string | null;
}

const COMPONENT = new RegExp(
  String.raw`^([a-z][a-z ,'-]*?) (${NUMBER}) ([A-Z%]+(?:/[A-Z]+)?)(?: (.+))?$`,
);

/**
 * `hydrochlorothiazide 12.5 MG / lisinopril 10 MG Oral Tablet [Zestoretic]`. A name with a leading
 * quantity or release qualifier (`24 HR ...`, `2 ML ...`) does not read: its first ingredient would
 * start with a digit or a capital, and such concepts never match the mapped forms.
 */
function readConcept(name: string): ConceptName | null {
  const brandMatch = /^(.*) \[([^\]]+)\]$/.exec(name);
  const body = brandMatch ? brandMatch[1]! : name;
  const parts = body.split(" / ");
  const components: ConceptName["components"] = [];
  let doseForm = "";
  for (const [index, part] of parts.entries()) {
    const match = COMPONENT.exec(part);
    if (!match) return null;
    const last = index === parts.length - 1;
    if (last !== (match[4] !== undefined)) return null;
    const strength = strengthOf(
      Number(match[2]),
      match[3]!.split("/")[0]!,
      match[3]!.includes("/") ? 1 : undefined,
    );
    if (!strength || (match[3]!.includes("/") && !/\/ML$/.test(match[3]!)))
      return null;
    components.push({ ingredient: ingredient(match[1]!), strength });
    if (last) doseForm = match[4]!;
  }
  return {
    components,
    doseForm,
    brand: brandMatch ? brandMatch[2]!.toLowerCase() : null,
  };
}

/** Equal to a millionth of a milligram, so `0.075 MG` and `75 mcg` agree. */
const sameStrength = (a: Strength, b: Strength) =>
  a.unit === b.unit && Math.abs(a.value - b.value) < 1e-6;

/**
 * A printed ingredient and a concept ingredient are the same when their base words agree and
 * every salt the concept names is printed too. RxNorm drops the salt from some clinical drug
 * names (`quinapril 10 MG Oral Tablet`), so a printed salt the concept leaves out still agrees;
 * if RxNorm has both spellings, both match and the row stays unresolved.
 */
const sameIngredient = (
  printed: { base: string; salts: string[] },
  concept: { base: string; salts: string[] },
) =>
  printed.base === concept.base &&
  concept.salts.every((salt) => printed.salts.includes(salt));

function genericMatches(name: ReadName, concept: ConceptName): boolean {
  if (
    concept.brand !== null ||
    concept.components.length !== name.ingredients.length
  )
    return false;
  const unused = [...concept.components];
  for (const [index, printed] of name.ingredients.entries()) {
    const at = unused.findIndex(
      (component) =>
        sameIngredient(printed, component.ingredient) &&
        sameStrength(name.strengths[index]!, component.strength),
    );
    if (at < 0) return false;
    unused.splice(at, 1);
  }
  return true;
}

/** Brand rows print strengths without ingredients, so they compare as a multiset. */
function brandMatches(name: ReadName, concept: ConceptName): boolean {
  if (concept.brand !== name.brand) return false;
  if (concept.components.length !== name.strengths.length) return false;
  const unused = concept.components.map((component) => component.strength);
  for (const strength of name.strengths) {
    const at = unused.findIndex((s) => sameStrength(s, strength));
    if (at < 0) return false;
    unused.splice(at, 1);
  }
  return true;
}

/** The term types a row can match: clinical drugs for generic rows, branded drugs for brand rows. */
/** The RxNorm term type a generic or brand row must match. */
export const TERM_TYPE = { generic: "SCD", brand: "SBD" } as const;

export type CandidateMatch =
  | { status: "resolved"; rxcui: string; concept: string }
  | { status: "unresolved"; reason: string; matched: number };

/**
 * The one candidate whose name has the row's ingredients (or brand), strengths and dose form.
 * Zero or several matches leave the row unresolved; the order the search returned is never used.
 */
export function matchCandidates(
  name: ReadName,
  candidates: readonly DrugNameCandidate[],
): CandidateMatch {
  if (!candidates.length)
    return {
      status: "unresolved",
      reason: IDENTITY_UNRESOLVED.noCandidate,
      matched: 0,
    };
  // A full list may have been cut at `MAX_CANDIDATES`: one match in it does not prove there is
  // no second one beyond the cut.
  if (candidates.length >= MAX_CANDIDATES)
    return {
      status: "unresolved",
      reason: IDENTITY_UNRESOLVED.truncated,
      matched: 0,
    };
  const matches = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.tty !== TERM_TYPE[name.kind]) continue;
    const concept = readConcept(candidate.name);
    if (!concept || concept.doseForm !== name.doseForm) continue;
    const fits =
      name.kind === "generic"
        ? genericMatches(name, concept)
        : brandMatches(name, concept);
    if (fits) matches.set(candidate.rxcui, candidate.name);
  }
  if (matches.size === 1) {
    const [rxcui, concept] = [...matches][0]!;
    return { status: "resolved", rxcui, concept };
  }
  return {
    status: "unresolved",
    reason: matches.size
      ? IDENTITY_UNRESOLVED.ambiguous
      : IDENTITY_UNRESOLVED.noMatch,
    matched: matches.size,
  };
}
