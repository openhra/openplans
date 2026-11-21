// The RxNav identity package on its own: the recorded RxNorm API responses (public, labelled
// `recorded` in tests/fixtures/rxnav/recorded.json) and synthetic variants of them. No network.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DRUG_IDENTITY_KIND,
  DRUG_NAME_SEARCH_KIND,
  MAX_CANDIDATES,
} from "@openplans/plugin-sdk";
import type { DrugNameCandidate, Question } from "@openplans/plugin-sdk";
import plugin, {
  HOST_FLOOR_MS,
  NLM_ACKNOWLEDGEMENT,
  NLM_REQUESTS_PER_SECOND,
  RXNAV_HOST,
  RXNAV_IDENTITY_ENV,
  RXNAV_SOURCE,
  RXNAV_TERMS_URL,
  createRxnavIdentitySource,
  mapHistory,
  mapNames,
  mapProperties,
} from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

const fixtures = new URL("../../../tests/fixtures/rxnav/", import.meta.url);
const recorded = async (file: string) =>
  JSON.parse(await readFile(new URL(file, fixtures), "utf8")) as unknown;
const RECORDED_RXCUI = "860975";
const ask = (identity: string): Question[] => [{ identity, year: 2026 }];

describe("recorded fixtures", () => {
  it("are labelled recorded, and each file matches its recorded hash", async () => {
    const index = (await recorded("recorded.json")) as {
      label: string;
      terms_url: string;
      files: { file: string; label: string; url: string; sha256: string }[];
    };
    expect(index.label).toBe("recorded");
    expect(index.terms_url).toBe(RXNAV_TERMS_URL);
    expect(index.files.map((entry) => entry.file).sort()).toEqual([
      "drugs-albendazole.json",
      "drugs-metformin.json",
      "historystatus-860975.json",
      "properties-860975.json",
      "version.json",
    ]);
    for (const entry of index.files) {
      expect(entry.label).toBe("recorded");
      expect(new URL(entry.url).hostname).toBe(RXNAV_HOST);
      // Only the name searches carry a query, and its value is a public generic name.
      const searched = /^drugs-([a-z]+)\.json$/.exec(entry.file)?.[1];
      expect(new URL(entry.url).search).toBe(
        searched ? `?name=${searched}` : "",
      );
      const bytes = await readFile(new URL(entry.file, fixtures));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        entry.sha256,
      );
    }
    // The pinned API version: a later rename or schema change shows up as a fixture change.
    const version = (await recorded("version.json")) as Record<string, unknown>;
    expect(typeof version.version).toBe("string");
    expect(typeof version.apiVersion).toBe("string");
  });
});

describe("properties.json", () => {
  it("confirms the recorded current, unsuppressed concept", async () => {
    const body = await recorded("properties-860975.json");
    expect(mapProperties(body, ask(RECORDED_RXCUI))).toEqual([
      {
        question: ask(RECORDED_RXCUI)[0],
        outcome: "answer",
        answer: { confirmed: true },
        statement: "Current RxNorm concept (SCD)",
      },
    ]);
  });

  it("does not confirm a suppressed concept (synthetic variant)", async () => {
    const body = (await recorded("properties-860975.json")) as {
      properties: Record<string, string>;
    };
    body.properties.suppress = "O";
    const [entry] = mapProperties(body, ask(RECORDED_RXCUI));
    expect(entry).toMatchObject({ outcome: "no_data" });
    expect(entry).not.toHaveProperty("answer");
  });

  it("leaves an RxCUI without properties to the history lookup (synthetic empty body)", () => {
    expect(mapProperties({}, ask("999999901"))).toEqual([]);
    expect(mapProperties({ properties: null }, ask("999999901"))).toEqual([]);
  });

  it("never confirms a different RxCUI than the one asked", async () => {
    const body = await recorded("properties-860975.json");
    expect(mapProperties(body, ask("1"))).toEqual([]);
  });

  it("rejects a body that is not the documented shape", () => {
    expect(() => mapProperties([], ask("1"))).toThrow();
    expect(() => mapProperties({ properties: "x" }, ask("1"))).toThrow();
  });
});

describe("historystatus.json", () => {
  it("never confirms, even for the recorded Active history", async () => {
    const body = await recorded("historystatus-860975.json");
    const [entry] = mapHistory(body, ask(RECORDED_RXCUI));
    expect(entry).toMatchObject({
      outcome: "no_data",
      statement: "No current RxNorm properties; history status Active",
    });
  });

  it("names the RxCUIs a remapped concept now points to (synthetic body)", () => {
    const body = {
      rxcuiStatusHistory: {
        metaData: { status: "Remapped" },
        derivedConcepts: {
          remappedConcept: [{ remappedRxCui: "7000002" }],
        },
      },
    };
    expect(mapHistory(body, ask("7000001"))[0]).toMatchObject({
      outcome: "no_data",
      statement:
        "No current RxNorm properties; history status Remapped, remapped to 7000002",
    });
    expect(mapHistory({}, ask("7000001"))[0]!.statement).toBe(
      "No RxNorm history for this RxCUI",
    );
  });
});

describe("drugs.json name search", () => {
  const name = (identity: string): Question[] => [{ identity, year: 2026 }];

  it("suggests the recorded current concepts in RxNav's order, at most MAX_CANDIDATES", async () => {
    const body = (await recorded("drugs-metformin.json")) as {
      drugGroup: { conceptGroup: { conceptProperties?: unknown[] }[] };
    };
    const listed = body.drugGroup.conceptGroup.flatMap(
      (group) => group.conceptProperties ?? [],
    );
    expect(listed.length).toBeGreaterThan(MAX_CANDIDATES);
    const [entry] = mapNames(body, name("metformin"));
    expect(entry).toMatchObject({ outcome: "answer" });
    const { candidates } = (
      entry as { answer: { candidates: DrugNameCandidate[] } }
    ).answer;
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(candidates[0]).toEqual({
      rxcui: (listed[0] as { rxcui: string }).rxcui,
      name: (listed[0] as { name: string }).name,
      tty: (listed[0] as { tty: string }).tty,
    });
    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["name", "rxcui", "tty"]);
      expect(candidate.rxcui).toMatch(/^\d+$/);
    }
  });

  it("leaves out suppressed concepts (synthetic variant)", async () => {
    const body = structuredClone(
      (await recorded("drugs-metformin.json")) as {
        drugGroup: {
          conceptGroup: { conceptProperties?: { suppress: string }[] }[];
        };
      },
    );
    for (const group of body.drugGroup.conceptGroup)
      for (const concept of group.conceptProperties ?? [])
        concept.suppress = "O";
    expect(mapNames(body, name("metformin"))).toEqual([
      {
        question: name("metformin")[0],
        outcome: "no_data",
        statement: "No current RxNorm concept matches this name",
      },
    ]);
  });

  it("answers a name nothing matches with no_data, so no follow-up runs (synthetic body)", () => {
    const [entry] = mapNames(
      { drugGroup: { name: null } },
      name("zzzznotadrug"),
    );
    expect(entry!.outcome).toBe("no_data");
    expect(mapNames(null, name("zzzznotadrug"))[0]!.outcome).toBe("no_data");
  });

  it("rejects a body that is not the documented shape", () => {
    expect(() => mapNames([], name("metformin"))).toThrow();
    expect(() =>
      mapNames({ drugGroup: { conceptGroup: {} } }, name("metformin")),
    ).toThrow();
  });
});

describe("source declaration", () => {
  const source = createRxnavIdentitySource();

  it("is a memory-only drug identity source on the RxNav host", () => {
    expect(source.id).toBe(RXNAV_SOURCE);
    expect(source.kinds).toEqual([DRUG_IDENTITY_KIND, DRUG_NAME_SEARCH_KIND]);
    expect(source.cache).toEqual({
      level: "memory",
      ttl: "24 hours",
      negativeTtl: "1 hour",
      maxEntries: 100_000,
    });
    expect(source.manifest).toEqual({
      host: RXNAV_HOST,
      accessMode: "public",
      permittedPaths: ["/REST/rxcui/", "/REST/drugs.json"],
    });
    expect(RXNAV_IDENTITY_ENV).toBe("OPENPLANS_RXNAV_IDENTITY");
  });

  it("asks properties first, then history status, one RxCUI per call", () => {
    expect(source.buildRequest(ask("860975"), DRUG_IDENTITY_KIND)).toEqual({
      path: "/REST/rxcui/860975/properties.json",
      query: {},
    });
    expect(
      source.followUp!.buildRequest(ask("860975"), DRUG_IDENTITY_KIND),
    ).toEqual({ path: "/REST/rxcui/860975/historystatus.json", query: {} });
    expect(() =>
      source.buildRequest([...ask("1"), ...ask("2")], DRUG_IDENTITY_KIND),
    ).toThrow();
    expect(source.batch.maxQuestionsPerCall).toBe(1);
    expect(source.eligibility.accepts({ identity: "860975", year: 2026 })).toBe(
      true,
    );
    expect(source.eligibility.accepts({ identity: "!86975", year: 2026 })).toBe(
      false,
    );
    // A name-shaped identity is a name-search question, never an RxCUI lookup.
    expect(
      source.question(DRUG_IDENTITY_KIND, {
        status: "unknown",
        reason: "rxcui_not_in_rxnorm",
        identity: "86O975",
        plan_year: 2026,
      } as never),
    ).toBeNull();
  });

  it("asks drugs.json for one name, never a follow-up, and takes names only for that kind", () => {
    const source = createRxnavIdentitySource();
    expect(
      source.buildRequest(ask("metformin"), DRUG_NAME_SEARCH_KIND),
    ).toEqual({ path: "/REST/drugs.json", query: { name: "metformin" } });
    expect(() =>
      source.followUp!.buildRequest(ask("metformin"), DRUG_NAME_SEARCH_KIND),
    ).toThrow();
    const asked = (identity: string) => ({
      status: "unknown",
      reason: "rxnorm_terminology_unavailable",
      identity,
      plan_year: 2026,
    });
    expect(
      source.question(DRUG_NAME_SEARCH_KIND, asked("metformin er")),
    ).toEqual({ identity: "metformin er", year: 2026 });
    expect(source.question(DRUG_IDENTITY_KIND, asked("metformin"))).toBeNull();
    expect(source.question(DRUG_NAME_SEARCH_KIND, asked("a"))).toBeNull();
    expect(
      source.question(DRUG_NAME_SEARCH_KIND, asked("metformin<script>")),
    ).toBeNull();
    expect(source.evidence!.limits!(DRUG_NAME_SEARCH_KIND)).toContain(
      "suggestions only",
    );
  });

  it("stays far under NLM's published rate and never under the 5 s host floor", () => {
    expect(source.budget.minIntervalMs).toBeGreaterThanOrEqual(HOST_FLOOR_MS);
    // Two lookups per call at most.
    expect((2 * 1000) / source.budget.minIntervalMs).toBeLessThan(
      NLM_REQUESTS_PER_SECOND,
    );
    expect(source.budget.dailyMax).toBe(5000);
  });

  it("carries NLM's acknowledgement verbatim and the terms URL", () => {
    expect(source.evidence).toMatchObject({
      key: RXNAV_SOURCE,
      source: NLM_ACKNOWLEDGEMENT,
      termsUrl: RXNAV_TERMS_URL,
    });
    expect(NLM_ACKNOWLEDGEMENT).toBe(
      "This product uses publicly available data from the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.",
    );
  });

  it("declares the same host in the plugin manifest and package.json", () => {
    expect(plugin.manifest.capabilities?.network).toEqual([RXNAV_HOST]);
    expect(packageJson.openplansPlugin.capabilities.network).toEqual([
      RXNAV_HOST,
    ]);
    expect(plugin.manifest.version).toBe(packageJson.version);
    const added: unknown[] = [];
    plugin.setup({
      sources: { add: (spec: unknown) => added.push(spec) },
    } as never);
    expect(added).toHaveLength(1);
  });
});
