// Compatibility routes that default `year` or the coverage date use the data window's current
// plan year and name it in the gap label. Synthetic clock over public fixture cuts.
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as IndexModule from "../../../src/compat/v1/index.js";
import { importMutant, withMutantFile } from "../../mutant-file.js";
import { BASE, headers, searchBody, setup } from "./helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
afterEach(() => vi.useRealTimers());

const index = new URL("../../../src/compat/v1/index.ts", import.meta.url);
const RXCUI = "197361";
type Routes = typeof IndexModule.compatRoutes;
interface Case {
  name: string;
  /** The label naming the year used. */
  label: (year: number) => string;
  call: (routes: ReturnType<Routes>) => Promise<Response> | Response;
}
const get = (path: string) => (r: ReturnType<Routes>) =>
  r.request(`${BASE}${path}`, { headers });
const cases: Case[] = [
  {
    name: "plan detail",
    label: (y) => `plan_year_defaulted_to_${y}`,
    call: get("/plans/87226TX0100013"),
  },
  {
    name: "drugs by rxcui",
    label: (y) => `plan_year_defaulted_to_${y}`,
    call: get(`/drugs?rxcui=${RXCUI}`),
  },
  {
    name: "carriers",
    label: (y) => `plan_year_defaulted_to_${y}`,
    call: get("/carriers"),
  },
  {
    name: "search coverage date",
    label: (y) => `coverage_date_defaulted_to_${y}_01_01`,
    call: (r) => {
      const body = searchBody() as Record<string, unknown>;
      delete body.enrollment_date;
      return r.request(`${BASE}/plans/medical/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    },
  },
];
const gapsOf = (response: Response) =>
  (response.headers.get("x-openplans-gaps") ?? "")
    .split(",")
    .map((g) => g.trim());

it.each(cases)("$name defaults to the current plan year", async (c) => {
  const routes = IndexModule.compatRoutes(h.db);
  for (const year of [2026, 2027]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(year, 2, 1)));
    const gaps = gapsOf(await c.call(routes));
    expect(gaps).toContain(c.label(year));
    expect(gaps).not.toContain(c.label(year === 2026 ? 2027 : 2026));
  }
});

it.each(cases)("kills: $name with a hard-coded year", async (c) => {
  const source = await readFile(index, "utf8"),
    call = "await defaultPlanYear(db)",
    position = cases.indexOf(c);
  const parts = source.split(call);
  expect(parts).toHaveLength(cases.length + 1);
  // Source order of the calls: coverage date, plan detail, drugs, carriers.
  const order = [1, 2, 3, 0];
  const hit = order[position]!;
  const text = parts
    .map((part, i) => {
      if (i === 0) return part;
      return (i - 1 === hit ? "2026" : call) + part;
    })
    .join("");
  await withMutantFile(index, text, async (file) => {
    const mutant = await importMutant<typeof IndexModule>(file, "compatRoutes");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2027, 2, 1)));
    const gaps = gapsOf(await c.call(mutant.compatRoutes(h.db)));
    expect(gaps).not.toContain(c.label(2027));
    expect(gaps).toContain(c.label(2026));
  });
});
