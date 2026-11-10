import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { BASE, headers, searchBody, setup } from "./helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
// Synthetic marker: one fixture plan is relabelled catastrophic to exercise the filter.
const CATASTROPHIC = "20069TX0100006";
beforeAll(async () => {
  h = await setup();
  await h.db.query(
    "UPDATE plan SET metal='Catastrophic' WHERE base_plan_id=$1",
    [CATASTROPHIC],
  );
});
afterAll(async () => {
  await h?.close();
});
afterEach(() => {
  delete process.env.OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE;
});

const search = async (extra: Record<string, unknown>) => {
  const response = await h.app.request(`${BASE}/plans/medical/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody(extra)),
  });
  const body = (await response.json()) as { plans?: { id: string }[] };
  return {
    status: response.status,
    ids: (body.plans ?? []).map((plan) => plan.id),
    gaps: response.headers.get("x-openplans-gaps") ?? "",
  };
};
const applicants = (...ages: number[]) => ({
  applicants: ages.map((age) => ({ age, smoker: false })),
});

it("keeps catastrophic plans for every age while the owner-gated rule is off", async () => {
  const result = await search(applicants(45));
  expect(result.ids).toContain(CATASTROPHIC);
  expect(result.gaps).not.toContain("catastrophic_requires_exemption");
});

it("excludes catastrophic plans for applicants aged 30 or older without a stated exemption", async () => {
  process.env.OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE = "on";
  const under = await search(applicants(29));
  expect(under.ids).toContain(CATASTROPHIC);
  expect(under.gaps).not.toContain("catastrophic_requires_exemption");
  for (const household of [applicants(30), applicants(25, 30)]) {
    const result = await search(household);
    expect(result.ids).not.toContain(CATASTROPHIC);
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.gaps).toContain("catastrophic_requires_exemption");
  }
  const exempt = await search({
    ...applicants(45),
    catastrophic_exemption: true,
  });
  expect(exempt.ids).toContain(CATASTROPHIC);
  expect(exempt.gaps).not.toContain("catastrophic_requires_exemption");
  expect(
    (await search({ ...applicants(45), catastrophic_exemption: "yes" })).status,
  ).toBe(400);
});

it("negative control: requesting the catastrophic plan by id at age 30 reports it unavailable, never a substitute", async () => {
  process.env.OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE = "on";
  const result = await search({ ...applicants(30), ids: [CATASTROPHIC] });
  expect(result.ids).toEqual([]);
  expect(result.gaps).toContain(`public_plan_unavailable:${CATASTROPHIC}`);
  expect(result.gaps).toContain("catastrophic_requires_exemption");
});
