// The CMS drug lists behind the Part D cost engine's drug classes (data/medicare-part-d/
// drug-lists.json): the pin checks, the per-year selected-drug NDC lists, how the classifier
// combines the list with the formulary flag, and planted mutants. NDCs below come from the
// pinned CMS list; CSV rows and packages marked synthetic are made up. The last block reads the
// cached CMS files and runs only when OPENPLANS_DATA_DIR holds them; nothing is downloaded.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DrugListFile,
  SelectedListEntry,
} from "../../src/domain/medicare/part-d-cost/classification.js";
import {
  classifyDrug,
  loadDrugListFile,
  selectedByName,
  selectedListStatus,
} from "../../src/domain/medicare/part-d-cost/classification.js";
import type { Package } from "../../src/domain/medicare/part-d-cost/repository.js";
import { decodeFlag } from "../../src/domain/medicare/part-d-cost/repository.js";
import { cachedSpuf, spufTableRows } from "../../src/ingest/medicare/spuf.js";
import type { SpufKind } from "../../src/ingest/medicare/spuf.js";
import {
  documentsFile,
  pbpDocumentsFile,
} from "../../scripts/medicare-costs/check.mjs";
import {
  buildSelectedLists,
  drugListCacheErrors,
  drugListErrors,
  drugListsFile,
  selectedCsv,
} from "../../scripts/medicare-costs/drug-lists.mjs";

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const lists = loadDrugListFile();
const others = [read(documentsFile), read(pbpDocumentsFile)];
const clone = (): DrugListFile & Record<string, unknown> =>
  JSON.parse(JSON.stringify(lists));

// NDC-11s read from the pinned CMS list (C16).
const ELIQUIS = "00003089321"; // selected 2026 and 2027
const JANUMET = "00006007861"; // selected from 2027 (IPAY 2027)
const ENTRESTO = "00078065920"; // selected 2026, deselected from January 1, 2027
const OFF_LIST = "00000000001"; // synthetic, on no list

const pkg = (ndc: string, selected: Package["selected_drug"]): Package => ({
  proxy_ndc: ndc,
  tier: 1,
  prior_authorization: false,
  step_therapy: false,
  quantity_limit: false,
  quantity_limit_amount: null,
  quantity_limit_days: null,
  selected_drug: selected,
  formulary_version: "1",
  evidence: {
    snapshot_id: "synthetic",
    table: "formulary",
    source_row: 2,
    fields: [],
  },
});
const open = {
  insulin: "unknown",
  acip_vaccine: "unknown",
  program: "unknown",
} as const;

describe("drug-list pins (data/medicare-part-d/drug-lists.json)", () => {
  it("pass every offline check", () => {
    expect(drugListErrors(read(drugListsFile), others)).toEqual([]);
  });
  it("catch a name-only entry, another year's entries, a lost source and a changed reason", () => {
    const nameOnly = clone();
    nameOnly.selectedDrugs.years["2026"]!.listed.push({
      drug: "ELIQUIS",
      ipay: 2026,
      rows: [2],
    } as unknown as SelectedListEntry);
    expect(drugListErrors(nameOnly, others).join()).toContain(
      "ndc11 must be 11 digits",
    );
    const swapped = clone();
    swapped.selectedDrugs.years["2026"] = lists.selectedDrugs.years["2027"]!;
    expect(drugListErrors(swapped, others).join()).toContain(
      "ipay must be a year no later than 2026",
    );
    const missing = clone();
    delete missing.selectedDrugs.years["2027"];
    expect(drugListErrors(missing, others).join()).toContain("years must be");
    const unsourced = clone();
    unsourced.selectedDrugs.citations[0]!.document = "C99";
    expect(drugListErrors(unsourced, others).join()).toContain(
      "unknown document C99",
    );
    const reason = clone();
    reason.nameOnlyLists[0]!.reason = "matched_by_name";
    expect(drugListErrors(reason, others).join()).toContain(
      "reason must be name_only_list_needs_rxnorm",
    );
    const reused = clone() as unknown as { documents: { id: string }[] };
    reused.documents[0]!.id = "C1";
    expect(drugListErrors(reused, others).join()).toContain(
      "C1: id used by two manifests",
    );
  });
  it("lists only CMS addresses and keeps insulin and the discount program open", () => {
    for (const doc of (read(drugListsFile) as { documents: { url: string }[] })
      .documents)
      expect(new URL(doc.url).hostname).toBe("www.cms.gov");
    const raw = read(drugListsFile) as Record<
      string,
      { status: string; reason: string }
    >;
    expect(raw.insulin).toMatchObject({
      status: "unknown",
      reason: "insulin_product_list_not_cached",
    });
    expect(raw.manufacturerDiscount).toMatchObject({
      status: "unknown",
      reason: "applicable_drug_list_not_cached",
    });
  });
});

describe("selected-drug lists built from the CMS file", () => {
  // Synthetic rows in the CMS layout.
  const header =
    "IPAY,Selected Drug Name,Active Ingredient Name or Active Moiety Name,NDC-9,NDC-11,XREF NDC-11,HCPCS Code,MFP Effective Date,MFP End Date,Single MFP per 30 DES,NDC-9 MFP per Unit Price,HCPCS Code Dosage Price,As of Date,Type of Update,Remarks";
  const row = (ndc: string, from: string, to: string, name = "DRUG A") =>
    `2026,${name},X,,${ndc},,,${from},${to},"$1,000.00",$1.00,,01/01/2026,New IPAY,synthetic`;
  it("lists an NDC for a year only when its rows cover the whole year", () => {
    const csv = [
      header,
      row("11111-1111-11", "01/01/2026", "12/31/2026"),
      row("11111-1111-11", "01/01/2027", ""),
      // A deselection: the 2027 row ends before it starts and never applies.
      row("22222-2222-22", "01/01/2026", "12/31/2026", "DRUG B"),
      row("22222-2222-22", "01/01/2027", "12/31/2026", "DRUG B"),
      // Two rows that meet cover the year; a gap leaves the NDC partly listed.
      row("33333-3333-33", "01/01/2026", "05/31/2026", "DRUG C"),
      row("33333-3333-33", "06/01/2026", "12/31/2026", "DRUG C"),
      row("44444-4444-44", "03/01/2026", "12/31/2026", "DRUG D"),
    ].join("\r\n");
    const built = buildSelectedLists(csv);
    expect(built["2026"]!.listed.map((item) => item.ndc11)).toEqual([
      "11111111111",
      "22222222222",
      "33333333333",
    ]);
    expect(built["2026"]!.listed[2]!.rows).toEqual([6, 7]);
    expect(built["2026"]!.partial.map((item) => item.ndc11)).toEqual([
      "44444444444",
    ]);
    expect(built["2027"]!.listed.map((item) => item.ndc11)).toEqual([
      "11111111111",
    ]);
    expect(built["2027"]!.listed[0]!.rows).toEqual([3]);
  });
  it("refuses a file it cannot read exactly", () => {
    expect(() => buildSelectedLists("IPAY,NDC-11\n2026,1")).toThrow(
      /no Selected Drug Name column/,
    );
    expect(() =>
      buildSelectedLists(
        [header, row("1111-1111-11", "01/01/2026", "")].join("\n"),
      ),
    ).toThrow(/NDC-11/);
    expect(() =>
      buildSelectedLists(
        [header, row("11111-1111-11", "2026-01-01", "")].join("\n"),
      ),
    ).toThrow(/effective date/);
  });
});

/** Named checks a correct classifier passes; each planted mutant must fail at least one. */
function failingChecks(
  classify: typeof classifyDrug = classifyDrug,
  byName: typeof selectedByName = selectedByName,
): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };
  const options = (year: number, item: Package) => {
    const found = classify(year, item, open);
    return "conflict" in found ? found.conflict : found.program.options.join();
  };
  check(
    "a listed NDC with no readable flag is selected",
    options(2026, pkg(ELIQUIS, "unknown")) === "selected",
  );
  check(
    "a listed NDC the plan flags N is a disagreement",
    options(2026, pkg(ELIQUIS, false)) === "selected,applicable,not_applicable",
  );
  check(
    "a 2027 drug is not selected in 2026",
    options(2026, pkg(JANUMET, "unknown")) === "applicable,not_applicable",
  );
  check(
    "a 2027 drug is selected in 2027",
    options(2027, pkg(JANUMET, "unknown")) === "selected",
  );
  check(
    "a deselected drug is not selected in 2027",
    options(2027, pkg(ENTRESTO, "unknown")) === "applicable,not_applicable",
  );
  check(
    "a drug flagged Y but off the list is a disagreement",
    options(2026, pkg(OFF_LIST, true)) === "selected,applicable,not_applicable",
  );
  for (const list of lists.nameOnlyLists)
    for (const name of list.names) {
      const found = byName(list.year, name);
      check(
        "a name never settles selected-drug status",
        found.status === "unknown" &&
          found.reason === "name_only_list_needs_rxnorm",
      );
    }
  return [...new Set(failures)];
}

describe("drug classes from the formulary flag and the CMS list", () => {
  it("cites the list rows when the list settles the program alone", () => {
    const found = classifyDrug(2026, pkg(ELIQUIS, "unknown"), open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.program).toMatchObject({
      options: ["selected"],
      origin: "cms_selected_drug_list",
      reason: null,
      evidence: [],
    });
    expect(found.program.citations[0]).toMatchObject({
      document: "C16",
      member: lists.selectedDrugs.member,
      row: 2,
    });
  });
  it("names the disagreement and keeps every program open", () => {
    for (const [ndc, flag] of [
      [ELIQUIS, false],
      [OFF_LIST, true],
    ] as const) {
      const found = classifyDrug(2026, pkg(ndc, flag), open);
      if ("conflict" in found) throw new Error(found.conflict);
      expect(found.program).toMatchObject({
        options: ["selected", "applicable", "not_applicable"],
        origin: "unknown",
        reason: "selected_drug_flag_disagrees_with_cms_list",
      });
      expect(found.program.evidence).toHaveLength(1);
      expect(
        found.program.citations.some((item) => item.document === "C16"),
      ).toBe(true);
    }
  });
  it("leaves a partly listed NDC to the flag, and open without one", () => {
    const partial = clone();
    const year = partial.selectedDrugs.years["2026"]!;
    year.partial.push(year.listed.shift()!);
    expect(selectedListStatus(2026, ELIQUIS, partial).status).toBe("partial");
    const flagged = classifyDrug(
      2026,
      pkg(ELIQUIS, true),
      open,
      undefined,
      partial,
    );
    if ("conflict" in flagged) throw new Error(flagged.conflict);
    expect(flagged.program.origin).toBe("formulary_flag");
    const unflagged = classifyDrug(
      2026,
      pkg(ELIQUIS, "unknown"),
      open,
      undefined,
      partial,
    );
    if ("conflict" in unflagged) throw new Error(unflagged.conflict);
    expect(unflagged.program).toMatchObject({
      options: ["selected", "applicable", "not_applicable"],
      reason: "selected_drug_list_partial_year",
    });
  });
  it("never reads another year's list", () => {
    expect(selectedListStatus(2025, ELIQUIS).status).toBe("not_pinned");
    expect(selectedListStatus(2028, ELIQUIS).status).toBe("not_pinned");
    expect(selectedListStatus(2026, ENTRESTO).status).toBe("listed");
    expect(selectedListStatus(2027, ENTRESTO).status).toBe("not_listed");
  });
  it("refuses a caller program the list rules out, and labels a narrowing", () => {
    expect(
      classifyDrug(2026, pkg(ELIQUIS, "unknown"), {
        ...open,
        program: "applicable",
      }),
    ).toEqual({ conflict: "drug_program_conflicts_with_formulary" });
    const narrowed = classifyDrug(2026, pkg(OFF_LIST, "unknown"), {
      ...open,
      program: "not_applicable",
    });
    if ("conflict" in narrowed) throw new Error(narrowed.conflict);
    expect(narrowed.program).toMatchObject({
      options: ["not_applicable"],
      origin: "caller_assertion_within_cms_selected_drug_list",
    });
  });
  it("keeps insulin and vaccine status open: no CMS list gives them", () => {
    const found = classifyDrug(2026, pkg(ELIQUIS, true), open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.insulin.reason).toBe("insulin_product_list_not_cached");
    expect(found.acip_vaccine.reason).toBe("acip_vaccine_list_not_cached");
  });
  it("never settles a drug by name", () => {
    expect(selectedByName(2026, "Eliquis")).toEqual({
      status: "unknown",
      reason: "name_only_list_needs_rxnorm",
      documents: ["C17"],
    });
    expect(selectedByName(2025, "Eliquis").reason).toBe("no_identifier");
  });
});

describe("planted mutants (drug lists)", () => {
  it("the real classifier passes every check", () => {
    expect(failingChecks()).toEqual([]);
  });
  it("catches a drug on the list treated as off it", () => {
    const offList: typeof classifyDrug = (year, item, caller, file, given) => {
      const emptied = JSON.parse(
        JSON.stringify(given ?? lists),
      ) as DrugListFile;
      for (const entry of Object.values(emptied.selectedDrugs.years))
        entry.listed = [];
      return classifyDrug(year, item, caller, file, emptied);
    };
    expect(failingChecks(offList)).toEqual(
      expect.arrayContaining([
        "a listed NDC with no readable flag is selected",
        "a 2027 drug is selected in 2027",
      ]),
    );
  });
  it("catches the wrong year's list", () => {
    const shifted = (by: number): typeof classifyDrug => {
      return (year, item, caller, file, given) => {
        const source = given ?? lists;
        const moved = JSON.parse(JSON.stringify(source)) as DrugListFile;
        for (const key of Object.keys(source.selectedDrugs.years)) {
          const other = source.selectedDrugs.years[String(Number(key) + by)];
          if (other) moved.selectedDrugs.years[key] = other;
        }
        return classifyDrug(year, item, caller, file, moved);
      };
    };
    expect(failingChecks(shifted(1))).toContain(
      "a 2027 drug is not selected in 2026",
    );
    expect(failingChecks(shifted(-1))).toEqual(
      expect.arrayContaining([
        "a 2027 drug is selected in 2027",
        "a deselected drug is not selected in 2027",
      ]),
    );
  });
  it("catches a name-only match accepted", () => {
    const byName = ((year: number, name: string) => {
      const hit = lists.nameOnlyLists.some(
        (list) =>
          list.year === year &&
          list.names.some((item) =>
            item.toLowerCase().includes(name.toLowerCase().split(";")[0]!),
          ),
      );
      return hit
        ? { status: "selected", reason: null, documents: [] }
        : selectedByName(year, name);
    }) as unknown as typeof selectedByName;
    expect(failingChecks(classifyDrug, byName)).toContain(
      "a name never settles selected-drug status",
    );
  });
});

// ---------- cached CMS files (OPENPLANS_DATA_DIR) ----------

const dataDir = process.env.OPENPLANS_DATA_DIR;
const pinned = read(drugListsFile) as {
  cacheSource: string;
  documents: { id: string; sha256: string }[];
};
const cached = Boolean(
  dataDir &&
  pinned.documents.every((doc) =>
    existsSync(join(dataDir, "raw", pinned.cacheSource, doc.sha256, "payload")),
  ),
);
const pageText = (id: string) => {
  const doc = pinned.documents.find((item) => item.id === id)!;
  return readFileSync(
    join(dataDir!, "raw", pinned.cacheSource, doc.sha256, "payload"),
    "utf8",
  )
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");
};

describe.skipIf(!cached)("cached CMS drug lists", () => {
  it("rehash and rebuild to the committed lists", async () => {
    expect(await drugListCacheErrors(read(drugListsFile), dataDir!)).toEqual(
      [],
    );
  });
  it("quote the web pages they cite", () => {
    for (const citation of lists.selectedDrugs.citations.filter(
      (item) => item.document === "C15",
    ))
      expect(pageText("C15")).toContain(citation.quote);
  });
  it("name in the fact sheets only drugs the NDC file holds for that year", async () => {
    const built = buildSelectedLists(
      await selectedCsv(read(drugListsFile), dataDir!),
      ["2026", "2027", "2028"],
    );
    for (const list of lists.nameOnlyLists) {
      const held = new Set(
        Object.values(built)
          .flatMap((year) => [...year.listed, ...year.partial])
          .filter((entry) => entry.ipay === list.year)
          .flatMap((entry) => entry.drug.split(";").map((n) => n.trim())),
      );
      // A consistency check of the two CMS documents; names never classify a drug.
      for (const name of list.names)
        for (const part of name.split(";"))
          expect(held, `${list.year} ${part}`).toContain(
            part.trim().toUpperCase(),
          );
    }
  });
});

interface Archive {
  kind: SpufKind;
  year: number;
  sha256: string;
  /** Formulary rows by flag and list answer, counted separately with a Python split. */
  rows: Record<string, number>;
  ndcs: Record<string, number>;
}
const archives: Archive[] = [
  {
    kind: "quarterly",
    year: 2026,
    sha256: "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b",
    rows: { "N|off": 1116940, "Y|on": 11768, "Y|off": 656 },
    ndcs: { "N|off": 6124, "Y|on": 44, "Y|off": 2 },
  },
  {
    kind: "monthly",
    year: 2027,
    sha256: "5f3bbe4e9ca29bce965403f3780d66452ec446cef5bf01fa050d3c6a990f053c",
    rows: { "N|off": 937912, "Y|on": 25184, "Y|off": 570 },
    ndcs: { "N|off": 5574, "Y|on": 92, "Y|off": 2 },
  },
];
const located = await Promise.all(
  archives.map(async (expected) => {
    if (!dataDir) return null;
    const found = await cachedSpuf(expected.kind, dataDir);
    return (
      found.find(
        (entry) =>
          entry.metadata.sha256 === expected.sha256 &&
          entry.archive.year === expected.year,
      ) ?? null
    );
  }),
);
const flagNames: Record<string, string> = {
  true: "Y",
  false: "N",
  unknown: "?",
};
const answerNames: Record<string, string> = { listed: "on", not_listed: "off" };
const noLists: DrugListFile = {
  ...lists,
  selectedDrugs: { ...lists.selectedDrugs, years: {} },
};
const settled = (year: number, item: Package, given: DrugListFile) => {
  const found = classifyDrug(year, item, open, undefined, given);
  if ("conflict" in found) return "conflict";
  const options = found.program.options;
  if (options.length === 1) return options[0]!;
  return options.length === 2 ? "not_selected" : "open";
};

describe.each(archives.map((item, i) => [item.year, item, i] as const))(
  "cached %i formulary against the CMS list",
  (_year, expected, index) => {
    const archive = located[index];
    it.skipIf(!archive)(
      "counts every package by flag and list, and how its program moves",
      async () => {
        const rows: Record<string, number> = {};
        const ndcs = new Map<string, string>();
        const moves: Record<string, number> = {};
        for await (const row of spufTableRows(archive!.path, "formulary")) {
          const flag = decodeFlag(row.values.SELECTED_DRUG_YN);
          const ndc = row.values.NDC!.trim();
          const item = pkg(ndc, flag);
          const answer = selectedListStatus(expected.year, ndc).status;
          const key = `${flagNames[String(flag)]}|${answerNames[answer] ?? answer}`;
          rows[key] = (rows[key] ?? 0) + 1;
          ndcs.set(ndc, key);
          const move = `${settled(expected.year, item, noLists)}->${settled(expected.year, item, lists)}`;
          moves[move] = (moves[move] ?? 0) + 1;
        }
        expect(rows).toEqual(expected.rows);
        const byNdc: Record<string, number> = {};
        for (const key of ndcs.values()) byNdc[key] = (byNdc[key] ?? 0) + 1;
        expect(byNdc).toEqual(expected.ndcs);
        // The flag is readable on every row, so the list settles no package the flag left
        // open. It confirms the flag on agreeing rows and opens the rows where they disagree.
        expect(moves).toEqual({
          "selected->selected": expected.rows["Y|on"],
          "not_selected->not_selected": expected.rows["N|off"],
          "selected->open": expected.rows["Y|off"],
        });
      },
      600_000,
    );
  },
);
