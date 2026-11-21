// hios_ids on the compatibility provider detail. Every provider record, NPI, plan id and stored
// answer in this harness is synthetic.
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { importProviders } from "../../../src/ingest/qhp/provider.js";
import * as ProvidersModule from "../../../src/compat/v1/providers.js";
import type * as PlanListModule from "../../../src/compat/v1/provider-plans.js";
import { providerPlanList } from "../../../src/compat/v1/provider-plans.js";
import { fixture, scope, setup } from "../../ingest/qhp/provider-helpers.js";
import { importMutant, withMutantFile } from "../../mutant-file.js";
import { BASE, headers, TOKEN } from "./helpers.js";

type PlanList = typeof PlanListModule.providerPlanList;
interface SourcePlan {
  plan_id: string;
}
interface Detail {
  provider: { hios_ids: string[] };
}

/** Listed under one plan by the synthetic issuer's provider set. */
const LISTED = "1000000000";
/** Known to NPPES, absent from the synthetic issuer's provider set. */
const ABSENT = "1000000001";
/** Listed by the synthetic issuer's complete set with an explicit non-participation row. */
const NONPART = "1000000002";
/** A second synthetic issuer in the catalog with no provider set loaded. */
const OTHER_PLAN = "00020TX0010001";
const YEAR = scope.year;
const source = new URL(
  "../../../src/compat/v1/provider-plans.ts",
  import.meta.url,
);

let h: Awaited<ReturnType<typeof setup>>;
let app: ReturnType<typeof createApp>;
let plan: string;

beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  h = await setup();
  app = createApp(h.db);
  const record = (await fixture("records"))[0]!;
  plan = record.plans.find((p: SourcePlan) =>
    h.catalog.plans.some(
      (c: { base_plan_id: string }) => c.base_plan_id === p.plan_id,
    ),
  )!.plan_id;
  const plans = [record.plans.find((p: SourcePlan) => p.plan_id === plan)];
  await h.replace([
    { ...record, npi: LISTED, plans },
    { ...record, npi: NONPART, plans },
  ]);
  await importProviders(h.db, scope);
  // Synthetic fixture row: the set names this NPI under the plan as explicitly not participating.
  const marked = await h.db.query(
    `UPDATE qhp_provider_plan e SET evidence_status='explicitly_not_participating'
    FROM qhp_provider_record r WHERE r.snapshot_id=e.snapshot_id AND r.record_id=e.record_id AND r.npi=$1 RETURNING e.record_id`,
    [NONPART],
  );
  expect(marked.rows.length).toBeGreaterThan(0);
  for (const npi of [LISTED, ABSENT, NONPART])
    await h.db.query(
      `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
      VALUES ($1,'1','Synthetic','Provider',true,'TX','2026-11-07','catalog')`,
      [npi],
    );
});
afterAll(async () => h?.close());
afterEach(() => vi.useRealTimers());

async function detail(npi: string, query = `?year=${YEAR}`) {
  const response = await app.request(`${BASE}/providers/${npi}${query}`, {
    headers,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Detail;
  return {
    hiosIds: body.provider.hios_ids,
    gaps: response.headers.get("x-openplans-gaps")!.split(", "),
  };
}
const partial = (gaps: string[]) =>
  gaps.filter((gap) => gap.startsWith("provider_plan_list_partial"));

/** With the issuer's complete set loaded: only the NPI it lists, only under its own plan. */
async function completeSetContract(list: PlanList) {
  expect((await list(h.db, LISTED, YEAR)).planIds).toEqual([plan]);
  expect((await list(h.db, ABSENT, YEAR)).planIds).toEqual([]);
  expect((await list(h.db, NONPART, YEAR)).planIds).toEqual([]);
  expect((await list(h.db, LISTED, YEAR + 1)).planIds).toEqual([]);
}
/** With the set superseded by a newer, unvalidated discovery: nothing is listed. */
async function incompleteSetContract(list: PlanList) {
  expect((await list(h.db, LISTED, YEAR)).planIds).toEqual([]);
}
function mutate(text: string, before: string, after: string) {
  expect(text.split(before)).toHaveLength(2);
  return text.replace(before, after);
}
async function withMutant(
  before: string,
  after: string,
  use: (list: PlanList) => Promise<void>,
) {
  const text = mutate(await readFile(source, "utf8"), before, after);
  await withMutantFile(source, text, async (file) => {
    const mutant = await importMutant<typeof PlanListModule>(
      file,
      "providerPlanList",
    );
    await use(mutant.providerPlanList);
  });
}

it("lists the plan a complete, current, ACTIVE source set names the NPI under", async () => {
  const listed = await detail(LISTED);
  expect(listed.hiosIds).toEqual([plan]);
  expect(partial(listed.gaps)).toEqual([]);
  expect((await detail(ABSENT)).hiosIds).toEqual([]);
  // An explicit non-participation row is excluded, and the NPI is not listed under the plan.
  expect((await detail(NONPART)).hiosIds).toEqual([]);
  await completeSetContract(providerPlanList);
});

it("defaults the year to the data window's current plan year and names it", async () => {
  const now = new Date();
  const current = now.getUTCFullYear();
  const defaulted = await detail(LISTED, "");
  expect(defaulted.gaps).toContain(`plan_year_defaulted_to_${current}`);
  // The window moves with the clock: in the next calendar year the default and its label follow.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(current + 1, 2, 1)));
  const later = await detail(LISTED, "");
  expect(later.gaps).toContain(`plan_year_defaulted_to_${current + 1}`);
  expect(later.gaps).not.toContain(`plan_year_defaulted_to_${current}`);
  expect(later.hiosIds).toEqual([]);
});

it("kills: a hard-coded default year", async () => {
  const providers = new URL(
    "../../../src/compat/v1/providers.ts",
    import.meta.url,
  );
  const text = mutate(
    await readFile(providers, "utf8"),
    "(await servingPolicy(db)).calendar_year",
    "2026",
  );
  await withMutantFile(providers, text, async (file) => {
    const mutant = await importMutant<typeof ProvidersModule>(
      file,
      "defaultPlanYear",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2027, 2, 1)));
    expect(await mutant.defaultPlanYear(h.db)).toBe(2026);
    expect(await ProvidersModule.defaultPlanYear(h.db)).toBe(2027);
  });
});

it("counts unloaded issuer scopes and never lists stored CMS answers", async () => {
  await h.db.query(
    `INSERT INTO plan SELECT (jsonb_populate_record(NULL::plan,
      to_jsonb(p)||jsonb_build_object('base_plan_id',$1::text,'issuer_id','00020'))).*
    FROM plan p WHERE p.base_plan_id=$2`,
    [OTHER_PLAN, plan],
  );
  await h.db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,sha256,expected_children,fetched_children,validation_state,activated_at)
    VALUES ('synthetic-cms-stored','cms-marketplace-api','2026-11-10T00:00:00Z',repeat('a',64),0,0,'ACTIVE',now())`,
  );
  for (const [planId, npi] of [
    [OTHER_PLAN, LISTED],
    [plan, ABSENT],
  ])
    await h.db.query(
      `INSERT INTO cms_api_provider_coverage(plan_id,npi,plan_year,coverage,snapshot_id,source_row,expires_at,sourced_by,sourced_at,sourced_slug)
      VALUES ($1,$2,$3,'Covered','synthetic-cms-stored',1,now()+interval '7 days','cms-marketplace-api','2026-11-10T00:00:00Z','synthetic-cms-stored')`,
      [planId, npi, YEAR],
    );
  const listed = await detail(LISTED);
  expect(listed.hiosIds).toEqual([plan]);
  expect(partial(listed.gaps)).toEqual(["provider_plan_list_partial:1"]);
  const absent = await detail(ABSENT);
  expect(absent.hiosIds).toEqual([]);
  expect(partial(absent.gaps)).toEqual(["provider_plan_list_partial:1"]);
  await completeSetContract(providerPlanList);
});

it("kills: an NPI absent from a loaded complete set listed", async () => {
  await withMutant("r.npi=$1", "(r.npi=$1 OR r.npi IS NOT NULL)", (list) =>
    expect(completeSetContract(list)).rejects.toThrow(),
  );
});

it("kills: an excluded non-participating NPI listed", async () => {
  await withMutant(
    "bool_and(e.evidence_status='listed_participating')",
    "bool_and(e.evidence_status IN ('listed_participating','explicitly_not_participating'))",
    (list) => expect(completeSetContract(list)).rejects.toThrow(),
  );
});

it("kills: a stored CMS row listed", async () => {
  await withMutant(
    "planIds: [...new Set(planIds)].sort(),",
    `planIds: [...new Set([...planIds, ...(await db.query<{ plan_id: string }>(
      "SELECT plan_id FROM cms_api_provider_coverage WHERE npi=$1 AND plan_year=$2 AND coverage='Covered'",
      [npi, year])).rows.map((row) => row.plan_id)])].sort(),`,
    (list) => expect(completeSetContract(list)).rejects.toThrow(),
  );
});

it("lists nothing from a set a newer discovery has not validated, and counts its scope", async () => {
  const record = (await fixture("records"))[0]!;
  // A newer discovery that is not imported: the active set is no longer current.
  await h.replace([{ ...record, npi: LISTED }]);
  const listed = await detail(LISTED);
  expect(listed.hiosIds).toEqual([]);
  expect(partial(listed.gaps)).toEqual(["provider_plan_list_partial:2"]);
  await incompleteSetContract(providerPlanList);
});

it("kills: an incomplete set listed", async () => {
  await withMutant(
    'source?.status === "complete"',
    'source?.status !== "access_denied"',
    (list) => expect(incompleteSetContract(list)).rejects.toThrow(),
  );
});
