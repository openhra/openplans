// An RxCUI on compatibility drug search. Terminology comes from the public RxNorm fixture cut; the
// identity stages here are synthetic stand-ins with no network, labelled synthetic.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type {
  PassThroughAnswer,
  PassThroughScope,
} from "@openplans/plugin-sdk";
import * as RxnavPackage from "@openplans/source-rxnav-identity";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DrugIdentityStage } from "../../../src/domain/drugs/repository.js";
import { importRxnorm } from "../../../src/ingest/rxnorm/import.js";
import * as drugService from "../../../src/services/drugs.js";
import type * as DrugIdentityModule from "../../../src/compat/v1/drug-identity.js";
import {
  drugByRxcui,
  optionalRxcui,
  RXCUI_CONFIRMED_UPSTREAM,
} from "../../../src/compat/v1/drug-identity.js";
import { fixture, metadata, zip } from "../../ingest/rxnorm/helpers.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { importMutant, withMutantFile } from "../../mutant-file.js";
import { BASE, headers, TOKEN } from "./helpers.js";

type ByRxcui = typeof DrugIdentityModule.drugByRxcui;
type Optional = typeof DrugIdentityModule.optionalRxcui;
interface DrugSearch {
  meta: { total: number };
  drugs: {
    id: string;
    proprietary_name: string | null;
    non_proprietary_name: string | null;
    drug_package_ids: string[];
  }[];
  drug_packages: { id: string; rx_cui_id: string }[];
  rxnorm_identity?: { source_id: string; source: string; terms_url: string };
}

/** Synthetic RxCUI the stand-in identity stages are asked about before a release is loaded. */
const ASKED = "7000001";
/** Synthetic RxCUI that is no concept of the fixture release. */
const NOT_A_CONCEPT = "999999999999";
const YEAR = 2026;
const source = new URL(
  "../../../src/compat/v1/drug-identity.ts",
  import.meta.url,
);

const db = testDatabase(new PGlite()),
  app = createApp(db);
let directory: string;
let asked: string[] = [];

/** Synthetic identity stage: confirms, declines or cannot answer, and records what it was asked. */
function stage(
  outcome: "confirmed" | "not_confirmed" | "unavailable",
): DrugIdentityStage {
  return {
    scope: {} as PassThroughScope,
    api: {
      apply: <T extends PassThroughAnswer>(_kind: string, answers: T[]) => {
        asked.push(
          ...answers.map(
            (answer) => (answer as { identity?: string }).identity ?? "",
          ),
        );
        return Promise.resolve(
          answers.map((answer) => {
            if (outcome === "confirmed")
              return {
                ...answer,
                status: "confirmed",
                reason: null,
                synthetic_identity: {
                  source_id: "rxnav",
                  served_from: "live",
                  source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
                  terms_url: RxnavPackage.RXNAV_TERMS_URL,
                },
              };
            return {
              ...answer,
              reason:
                outcome === "not_confirmed"
                  ? "passthrough_identity_not_confirmed"
                  : "passthrough_source_unavailable",
            };
          }),
        );
      },
    },
  };
}

beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  const core = await coreMigrations();
  try {
    await migrate(db, core.directory);
  } finally {
    await core.cleanup();
  }
  directory = await mkdtemp(join(tmpdir(), "openplans-drug-rxcui-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  asked = [];
});
afterAll(async () => {
  await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function get(query: string) {
  const response = await app.request(`${BASE}/drugs?${query}`, { headers });
  return {
    status: response.status,
    body: (await response.json()) as DrugSearch & {
      error?: { code: string; field: string };
    },
    gaps: (response.headers.get("x-openplans-gaps") ?? "").split(", "),
  };
}
async function loadRelease() {
  const archive = zip(await fixture()),
    path = join(directory, "rxnorm-real-cut.zip");
  await writeFile(path, archive);
  await importRxnorm(db, {
    version: "2026-11-02",
    path,
    metadata: metadata(archive),
  });
}

/** Both spellings name the drug; nothing else does. */
function aliasContract(read: Optional) {
  expect(read({ rxcui: "860975" }, "")).toBe("860975");
  expect(read({ rx_cui_id: "860975" }, "")).toBe("860975");
  expect(read({ rxcui: 860975 }, "drug_packages.")).toBe("860975");
  expect(read({ rxcui: "860975", rx_cui_id: "860975" }, "")).toBe("860975");
  expect(read({ id: "00093-1048-01" }, "drug_packages.")).toBeUndefined();
}
/** The NLM statement the compat body carries when the identity source confirmed the RxCUI. */
const NLM = {
  source_id: "rxnav",
  source: RxnavPackage.NLM_ACKNOWLEDGEMENT,
  terms_url: RxnavPackage.RXNAV_TERMS_URL,
};
/** Without a loaded release, only a confirmation identifies the RxCUI. */
async function confirmationContract(byRxcui: ByRxcui) {
  const confirmed = await byRxcui(db, ASKED, YEAR, stage("confirmed"));
  expect(confirmed.attribution).toEqual(NLM);
  for (const outcome of ["not_confirmed", "unavailable"] as const) {
    const found = await byRxcui(db, ASKED, YEAR, stage(outcome));
    expect(found.drugs, outcome).toEqual([]);
    expect(found.drug_packages, outcome).toEqual([]);
  }
  expect((await byRxcui(db, ASKED, YEAR)).drugs).toEqual([]);
}

it("reads rxcui and rx_cui_id, and rejects malformed or disagreeing values", () => {
  aliasContract(optionalRxcui);
  expect(() => optionalRxcui({ rxcui: "86x" }, "")).toThrow();
  expect(() => optionalRxcui({ rxcui: -1 }, "")).toThrow();
  expect(() => optionalRxcui({ rxcui: "1", rx_cui_id: "2" }, "")).toThrow();
});

it("kills: rxcui ignored", async () => {
  const text = await readFile(source, "utf8"),
    before = `export const RXCUI_FIELDS = ["rxcui", "rx_cui_id"] as const;`;
  expect(text.split(before)).toHaveLength(2);
  await withMutantFile(
    source,
    text.replace(before, `export const RXCUI_FIELDS = ["rx_cui_id"] as const;`),
    async (file) => {
      const mutant = await importMutant<typeof DrugIdentityModule>(
        file,
        "optionalRxcui",
      );
      expect(() => aliasContract(mutant.optionalRxcui)).toThrow();
    },
  );
});

it("without a release, returns an RxCUI only when the identity stage confirms it", async () => {
  await confirmationContract(drugByRxcui);
  const notConfirmed = await drugByRxcui(
    db,
    ASKED,
    YEAR,
    stage("not_confirmed"),
  );
  expect(notConfirmed.gaps).toEqual(["rxcui_not_in_rxnorm"]);
  const unavailable = await drugByRxcui(db, ASKED, YEAR, stage("unavailable"));
  expect(unavailable.gaps).toEqual(["rxnorm_terminology_unavailable"]);
  const confirmed = await drugByRxcui(db, ASKED, YEAR, stage("confirmed"));
  expect(confirmed).toEqual({
    drugs: [
      {
        id: `rxnorm:${ASKED}`,
        active_ingredient_strength: null,
        proprietary_name: null,
        non_proprietary_name: null,
        drug_package_ids: [],
      },
    ],
    drug_packages: [],
    gaps: [RXCUI_CONFIRMED_UPSTREAM],
    attribution: NLM,
  });
});

it("kills: the NLM statement missing from a confirmed answer", async () => {
  const text = await readFile(source, "utf8"),
    before = `attribution: identityAttribution(identity.evidence),`;
  expect(text.split(before)).toHaveLength(2);
  await withMutantFile(
    source,
    text.replace(before, `attribution: undefined,`),
    async (file) => {
      const mutant = await importMutant<typeof DrugIdentityModule>(
        file,
        "drugByRxcui",
      );
      await expect(confirmationContract(mutant.drugByRxcui)).rejects.toThrow();
    },
  );
});

it("kills: an RxCUI used without identity confirmation", async () => {
  const text = await readFile(source, "utf8"),
    before = `if (identity.status !== "confirmed")`;
  expect(text.split(before)).toHaveLength(2);
  await withMutantFile(
    source,
    text.replace(before, `if (identity.status === "rxcui_suppressed")`),
    async (file) => {
      const mutant = await importMutant<typeof DrugIdentityModule>(
        file,
        "drugByRxcui",
      );
      await expect(confirmationContract(mutant.drugByRxcui)).rejects.toThrow();
    },
  );
});

it("routes an RxCUI through the request's identity stage when no release is loaded", async () => {
  const off = await get(`rxcui=${ASKED}`);
  expect(off.status).toBe(200);
  expect(off.body).toEqual({
    meta: { total: 0 },
    drugs: [],
    drug_packages: [],
  });
  expect(off.gaps).toEqual(
    expect.arrayContaining([
      "rxnorm_terminology_unavailable",
      "rxcui_not_in_rxnorm",
    ]),
  );
  vi.spyOn(drugService, "identityStage").mockReturnValue(stage("confirmed"));
  const confirmed = await get(`rx_cui_id=${ASKED}`);
  expect(confirmed.body.drugs.map((drug) => drug.id)).toEqual([
    `rxnorm:${ASKED}`,
  ]);
  expect(confirmed.gaps).toContain(RXCUI_CONFIRMED_UPSTREAM);
  expect(confirmed.body.rxnorm_identity).toEqual(NLM);
  expect(off.body).not.toHaveProperty("rxnorm_identity");
  expect(asked).toEqual([ASKED]);
});

it("with a release loaded, an RxCUI returns its concept and packages and never asks upstream", async () => {
  await loadRelease();
  const spy = vi
    .spyOn(drugService, "identityStage")
    .mockReturnValue(stage("confirmed"));
  const search = await get("search_term=metformin");
  const listed = search.body.drugs[0]!,
    rxcui = listed.id.replace("rxnorm:", "");
  for (const query of [
    `rxcui=${rxcui}`,
    `rx_cui_id=${rxcui}`,
    `rxcui=${rxcui}&rx_cui_id=${rxcui}`,
  ]) {
    const found = await get(query);
    expect(found.status, query).toBe(200);
    expect(found.body.meta.total).toBe(1);
    expect(found.body.drugs[0]!.id).toBe(listed.id);
    expect(found.body.drugs[0]!.drug_package_ids).toEqual(
      listed.drug_package_ids,
    );
    expect(found.body.drug_packages).toEqual(
      search.body.drug_packages.filter((p) => p.rx_cui_id === rxcui),
    );
    expect(found.gaps).not.toContain("rxnorm_terminology_unavailable");
  }
  const withTerm = await get(`search_term=lipitor&rxcui=${rxcui}`);
  expect(withTerm.body.drugs[0]!.id).toBe(listed.id);
  expect(withTerm.gaps).toContain("search_term_ignored_for_rxcui");
  const unknown = await get(`rxcui=${NOT_A_CONCEPT}`);
  expect(unknown.body).toEqual({
    meta: { total: 0 },
    drugs: [],
    drug_packages: [],
  });
  expect(unknown.gaps).toContain("rxcui_not_in_rxnorm");
  // A loaded release wins: the confirming stand-in is never asked.
  expect(asked).toEqual([]);
  expect(spy).toHaveBeenCalled();
});

it("keeps search_term searches unchanged and rejects bad RxCUIs", async () => {
  const plain = await get("search_term=metformin");
  expect(plain.body.drugs.length).toBeGreaterThan(0);
  expect(plain.gaps).not.toContain("search_term_ignored_for_rxcui");
  expect((await get("")).status).toBe(400);
  const malformed = await get("rxcui=abc");
  expect(malformed.status).toBe(400);
  expect(malformed.body.error).toMatchObject({ field: "rxcui" });
  const conflict = await get("rxcui=1&rx_cui_id=2");
  expect(conflict.status).toBe(400);
  expect(conflict.body.error).toMatchObject({
    code: "conflicting_rxcui",
    field: "rx_cui_id",
  });
});
