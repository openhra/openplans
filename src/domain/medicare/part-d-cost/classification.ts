import { readFileSync } from "node:fs";
import type { Citation, DrugProgram } from "./program-rules.js";
import type { Flag, Package, RowRef } from "./repository.js";

/**
 * Evidence for the facts the cost engine needs about a plan and a drug beyond its tier and cost
 * rows: the plan's drug benefit type, and whether a drug is a selected drug, a covered insulin or
 * an ACIP-recommended adult vaccine. Each fact comes from a cached, admitted CMS file with its
 * source row and the pinned document that defines the field. A fact no cached file settles stays
 * unknown with its reason. Nothing here is inferred from a name, a tier or a price.
 *
 * - Benefit type: PBP `pbp_mrx.mrx_benefit_type`, decoded with the codes of the pinned PBP data
 *   dictionary (C13 for 2026, C14 for 2027).
 * - Selected drug: the Basic Drugs Formulary file's `SELECTED_DRUG_YN` flag for the NDC (C1, C2),
 *   checked against the CMS selected-drug NDC list for the same year (C16, drug-lists.json). Either
 *   source settles the program when the other is silent; when they disagree it stays open. Not
 *   selected does not say whether the drug is an applicable drug under the manufacturer discount
 *   program, so that stays open: the CMS labeler code list names companies, not NDA or BLA
 *   approval. Name-only lists (the CMS fact sheets) are never matched to a drug.
 * - Covered insulin and ACIP vaccine status: no cached file lists them by drug, so both stay
 *   unknown. A plan's insulin cost row covers a tier, not every drug on it.
 */

export type BenefitType = "DS" | "AE" | "BA" | "EA";

/** One stored PBP row; `fields` names the raw columns the figure was read from. */
export interface PbpRowRef {
  snapshot_id: string;
  table: "pbp_mrx";
  source_row: number;
  fields: string[];
}

export interface PbpRelease {
  snapshot_id: string;
  contract_year: number;
  as_of: string;
  sha256: string;
  url: string;
}

export type BenefitTypeEvidence =
  | {
      status: "value";
      type: BenefitType;
      code: string;
      label: string;
      release: PbpRelease;
      evidence: PbpRowRef[];
      citations: Citation[];
    }
  | {
      status: "unknown";
      reason: string;
      raw: string | null;
      release: PbpRelease | null;
      evidence: PbpRowRef[];
      citations: Citation[];
    };

export interface ClassificationFile {
  schemaVersion: number;
  years: Record<
    string,
    {
      benefitType: {
        table: string;
        field: string;
        codes: Record<
          string,
          { type: BenefitType; label: string; citations: Citation[] }
        >;
      };
      selectedDrugFlag: {
        table: string;
        field: string;
        yes: string;
        no: string;
        citations: Citation[];
      };
      unsourced: Record<
        | "insulin"
        | "acip_vaccine"
        | "manufacturer_discount"
        | "selected_drug_list",
        { reason: string; note: string }
      >;
    }
  >;
}

/** One NDC-11 on a year's selected-drug list, with the data rows of the CMS file it rests on. */
export interface SelectedListEntry {
  ndc11: string;
  drug: string;
  ipay: number;
  rows: number[];
}

/** The pinned CMS drug lists (data/medicare-part-d/drug-lists.json); only the parts read here. */
export interface DrugListFile {
  schemaVersion: number;
  selectedDrugs: {
    document: string;
    member: string;
    citations: Citation[];
    years: Record<
      string,
      { listed: SelectedListEntry[]; partial: SelectedListEntry[] }
    >;
  };
  nameOnlyLists: {
    document: string;
    year: number;
    reason: string;
    names: string[];
  }[];
}

let listCache: DrugListFile | null = null;
export function loadDrugListFile(): DrugListFile {
  listCache ??= JSON.parse(
    readFileSync(
      new URL(
        "../../../../data/medicare-part-d/drug-lists.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as DrugListFile;
  return listCache;
}

export type SelectedListStatus =
  | {
      status: "listed" | "partial";
      entry: SelectedListEntry;
      citations: Citation[];
    }
  | { status: "not_listed"; citations: Citation[] }
  | { status: "not_pinned" | "ndc_unreadable"; citations: [] };

/**
 * Looks a package's NDC up on the year's selected-drug list. Only an exact 11-digit NDC matches;
 * another year's list is never consulted.
 */
export function selectedListStatus(
  year: number,
  ndc: string,
  lists: DrugListFile = loadDrugListFile(),
): SelectedListStatus {
  const pinned = lists.selectedDrugs.years[String(year)];
  if (!pinned) return { status: "not_pinned", citations: [] };
  if (!/^\d{11}$/.test(ndc)) return { status: "ndc_unreadable", citations: [] };
  const { document, member } = lists.selectedDrugs;
  const rowCitations = (entry: SelectedListEntry): Citation[] =>
    entry.rows.map((row) => ({
      document,
      member,
      row,
      section: `Selected drug list, NDC-11 ${entry.ndc11} (${entry.drug}), contract year ${year}`,
    }));
  for (const status of ["listed", "partial"] as const) {
    const entry = pinned[status].find((item) => item.ndc11 === ndc);
    if (entry)
      return {
        status,
        entry,
        citations: [...rowCitations(entry), ...lists.selectedDrugs.citations],
      };
  }
  return {
    status: "not_listed",
    citations: [
      {
        document,
        member,
        section: `Selected drug list: NDC-11 ${ndc} has no row in effect for contract year ${year}`,
      },
      ...lists.selectedDrugs.citations,
    ],
  };
}

/**
 * A drug name never settles selected-drug status. The CMS fact sheets list the selected drugs by
 * name only, and a name does not identify an NDC or RxCUI, so a lookup by name returns unknown
 * with the reason recorded for those lists (or `no_identifier` when the year has none).
 */
export function selectedByName(
  year: number,
  _name: string,
  lists: DrugListFile = loadDrugListFile(),
): { status: "unknown"; reason: string; documents: string[] } {
  const found = lists.nameOnlyLists.filter((list) => list.year === year);
  return {
    status: "unknown",
    reason: found[0]?.reason ?? "no_identifier",
    documents: found.map((list) => list.document),
  };
}

let fileCache: ClassificationFile | null = null;
export function loadClassificationFile(): ClassificationFile {
  fileCache ??= JSON.parse(
    readFileSync(
      new URL(
        "../../../../data/medicare-part-d/drug-classes.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ClassificationFile;
  return fileCache;
}

export interface StoredPbpRow {
  /** Non-empty cells as filed, keyed by lower-case column name. */
  fields: Record<string, string>;
  source_row: number;
}

const normalise = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * Decodes a plan's `mrx_benefit_type` from its PBP rows. `releaseCodes` are the code labels the
 * release's own dictionary carries for the field, when it was loaded; a label there that disagrees
 * with the pinned dictionary leaves the type unknown.
 */
export function decodeBenefitType(
  release: PbpRelease,
  rows: StoredPbpRow[],
  releaseCodes: Record<string, string> | null,
  file: ClassificationFile = loadClassificationFile(),
): BenefitTypeEvidence {
  const pins = file.years[String(release.contract_year)]?.benefitType;
  const field = pins?.field ?? "mrx_benefit_type";
  const evidence = [...rows]
    .sort((a, b) => a.source_row - b.source_row)
    .map((row): PbpRowRef => ({
      snapshot_id: release.snapshot_id,
      table: "pbp_mrx",
      source_row: row.source_row,
      fields: [field],
    }));
  const unknown = (reason: string, raw: string | null) => ({
    status: "unknown" as const,
    reason,
    raw,
    release,
    evidence,
    citations: [],
  });
  if (!pins) return unknown("benefit_type_codes_not_pinned", null);
  if (!rows.length) return unknown("plan_not_in_pbp_files", null);
  const values = [
    ...new Set(rows.map((row) => (row.fields[field] ?? "").trim())),
  ];
  if (values.length > 1) return unknown("pbp_rows_disagree", values.join("|"));
  const code = values[0]!;
  if (!code) return unknown("benefit_type_not_reported", "");
  const pinned = Object.hasOwn(pins.codes, code) ? pins.codes[code]! : null;
  if (!pinned) return unknown("unknown_benefit_type_code", code);
  // The importer keeps only the code on a dictionary field's first row (continuation rows leave
  // the field name blank), so only a code the release does carry is compared.
  const releaseLabel =
    releaseCodes && Object.hasOwn(releaseCodes, code)
      ? releaseCodes[code]!
      : null;
  if (
    releaseLabel !== null &&
    normalise(releaseLabel) !== normalise(pinned.label)
  )
    return unknown("benefit_type_codes_differ_from_pinned_dictionary", code);
  return {
    status: "value",
    type: pinned.type,
    code,
    label: pinned.label,
    release,
    evidence,
    citations: pinned.citations,
  };
}

export type BenefitTypeOrigin = "pbp_filing" | "caller_assertion" | "unknown";
export interface ResolvedBenefitType {
  type: BenefitType | "unknown";
  origin: BenefitTypeOrigin;
  reason: string | null;
  evidence: PbpRowRef[];
  citations: Citation[];
}

/**
 * The benefit type the engine uses. A filed type wins; a caller's value that disagrees with it is
 * a conflict. Without a filing the caller's value is kept as an assertion, never as CMS evidence.
 */
export function resolveBenefitType(
  caller: BenefitType | "unknown",
  filed: BenefitTypeEvidence | undefined,
): ResolvedBenefitType | { conflict: string } {
  if (filed?.status === "value") {
    if (caller !== "unknown" && caller !== filed.type)
      return { conflict: "benefit_type_conflicts_with_plan_filing" };
    return {
      type: filed.type,
      origin: "pbp_filing",
      reason: null,
      evidence: filed.evidence,
      citations: filed.citations,
    };
  }
  if (caller !== "unknown")
    return {
      type: caller,
      origin: "caller_assertion",
      reason: null,
      evidence: [],
      citations: [],
    };
  return {
    type: "unknown",
    origin: "unknown",
    reason: filed?.reason ?? "benefit_type_unknown",
    evidence: filed?.evidence ?? [],
    citations: [],
  };
}

export type ClassOrigin =
  | "formulary_flag"
  | "cms_selected_drug_list"
  | "formulary_flag_and_cms_selected_drug_list"
  | "caller_assertion"
  | "caller_assertion_within_formulary_flag"
  | "caller_assertion_within_cms_selected_drug_list"
  | "unknown";
export interface DrugClassification {
  program: {
    /** Programs still admissible for the drug; one entry means it is settled. */
    options: DrugProgram[];
    origin: ClassOrigin;
    reason: string | null;
    evidence: RowRef[];
    citations: Citation[];
  };
  insulin: {
    value: Flag;
    origin: ClassOrigin;
    reason: string | null;
  };
  acip_vaccine: {
    value: Flag;
    origin: ClassOrigin;
    reason: string | null;
  };
}

const allPrograms: DrugProgram[] = ["selected", "applicable", "not_applicable"];

/**
 * Classifies one listed package. The formulary flag and the CMS selected-drug list for the year
 * settle the selected-drug program: one source is enough when the other is silent, and a
 * disagreement leaves every program open. The caller may narrow what the evidence leaves open
 * but never contradict it. Insulin and vaccine status come only from the caller, since no cached
 * file gives them; left open, they stay unknown.
 */
export function classifyDrug(
  year: number,
  pkg: Package,
  caller: {
    insulin: Flag;
    acip_vaccine: Flag;
    program: DrugProgram | "unknown";
  },
  file: ClassificationFile = loadClassificationFile(),
  lists: DrugListFile = loadDrugListFile(),
): DrugClassification | { conflict: string } {
  const pins = file.years[String(year)];
  const flag = pins ? pkg.selected_drug : "unknown";
  const listed = selectedListStatus(year, pkg.proxy_ndc, lists);
  // The list's answer, or unknown when it has none for the whole year.
  const answers: Partial<Record<SelectedListStatus["status"], boolean>> = {
    listed: true,
    not_listed: false,
  };
  const onList: Flag = answers[listed.status] ?? "unknown";
  let options = allPrograms;
  let origin: ClassOrigin = "unknown";
  let reason: string | null = null;
  const evidence: RowRef[] = [];
  const citations: Citation[] = [];
  const notSelectedReason =
    pins?.unsourced.manufacturer_discount.reason ??
    "classification_sources_not_pinned";
  if (flag !== "unknown") {
    evidence.push({ ...pkg.evidence, fields: [pins!.selectedDrugFlag.field] });
    citations.push(...pins!.selectedDrugFlag.citations);
  }
  if (onList !== "unknown") citations.push(...listed.citations);
  if (flag !== "unknown" && onList !== "unknown" && flag !== onList)
    reason = "selected_drug_flag_disagrees_with_cms_list";
  else if (flag !== "unknown" || onList !== "unknown") {
    const selected = flag !== "unknown" ? flag : onList === true;
    options = selected ? ["selected"] : ["applicable", "not_applicable"];
    if (flag === "unknown") origin = "cms_selected_drug_list";
    else if (onList === "unknown") origin = "formulary_flag";
    else origin = "formulary_flag_and_cms_selected_drug_list";
    if (!selected) reason = notSelectedReason;
  } else if (listed.status === "partial")
    reason = "selected_drug_list_partial_year";
  else
    reason = pins
      ? "selected_drug_flag_unknown"
      : "classification_sources_not_pinned";
  if (caller.program !== "unknown") {
    if (!options.includes(caller.program))
      return { conflict: "drug_program_conflicts_with_formulary" };
    const narrowed = options.length > 1 && origin !== "unknown";
    options = [caller.program];
    if (origin === "unknown") origin = "caller_assertion";
    else if (narrowed)
      origin =
        origin === "cms_selected_drug_list"
          ? "caller_assertion_within_cms_selected_drug_list"
          : "caller_assertion_within_formulary_flag";
    reason = null;
  }
  const special = (
    value: Flag,
    key: "insulin" | "acip_vaccine",
  ): DrugClassification["insulin"] =>
    value === "unknown"
      ? {
          value,
          origin: "unknown",
          reason:
            pins?.unsourced[key].reason ?? "classification_sources_not_pinned",
        }
      : { value, origin: "caller_assertion", reason: null };
  return {
    program: { options, origin, reason, evidence, citations },
    insulin: special(caller.insulin, "insulin"),
    acip_vaccine: special(caller.acip_vaccine, "acip_vaccine"),
  };
}
