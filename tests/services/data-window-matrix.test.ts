import { readFile } from "node:fs/promises";
import type {
  AnnualDomain,
  CoreConfigView,
  HistoryYears,
} from "@openplans/plugin-sdk";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { coreConfigView, loadConfig } from "../../src/config/index.js";
import type { Database } from "../../src/db/database.js";
import { resolveAnnualPolicy } from "../../src/domain/data-window.js";
import type * as appModule from "../../src/api/app.js";
import * as toolsModule from "../../src/mcp/tools.js";
import type * as windowModule from "../../src/domain/data-window.js";
import { outputSchemas } from "../../src/mcp/schemas.js";
import { emptyRegistries } from "../../src/plugins/registries.js";
import { hostAvailability } from "../../src/plugins/status-host.js";
import { loadForTest } from "../../src/plugins/testing/index.js";
import { servingPolicy } from "../../src/services/data-window.js";
import {
  createStatusPlugin,
  publicStatusSchema,
} from "../../plugins/status/src/index.js";
import { connect } from "../mcp/client.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { migratedTemplate } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";
import {
  admissionStates,
  calendarPositions,
  expectedDomains,
  expectedWindow,
  fixtureYears,
  seedWindowFixture,
  setWindowAdmissions,
  syntheticPlan,
} from "./data-window-fixture.js";
import type { AdmissionState } from "./data-window-fixture.js";

let template: Awaited<ReturnType<typeof migratedTemplate>>;
let db: Database;
beforeAll(async () => {
  template = await migratedTemplate();
  db = await template.fresh();
  await seedWindowFixture(db);
});
afterAll(async () => {
  await db?.close();
  await template?.close();
});
afterEach(() => vi.useRealTimers());

function at(date: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(date));
}
const config = (historyYears: HistoryYears, cache = false) =>
  loadConfig(
    {},
    { version: 1, data: { historyYears }, cache: { enabled: cache } },
  );

async function statusApp(history: HistoryYears, cache = false) {
  const cfg = config(history, cache);
  const plugin = createStatusPlugin({
    host: { dataPolicy: servingPolicy, dataAvailability: hostAvailability },
  });
  const view = JSON.parse(
    JSON.stringify(coreConfigView(cfg)),
  ) as CoreConfigView;
  const loaded = await loadForTest(plugin, { db, config: view });
  const registries = emptyRegistries();
  registries.routes = loaded.registrations.routes.map((spec) => ({
    plugin: plugin.manifest.name,
    spec,
  }));
  const store = new MemoryCache(2 * 1024 * 1024);
  const app = createApp(db, {}, { config: cfg, plugins: registries, store });
  return { app, cfg, store, close: loaded.close };
}

function notLoaded(
  body: unknown,
  year: number,
  domain: AnnualDomain,
  allowed: number[],
  surface: string,
) {
  expect(body, `WINDOW_NOT_LOADED:${surface}`).toMatchObject({
    error: {
      code: "not_loaded",
      reason: "outside_serving_window",
      required_year: year,
      domain,
      allowed_years: allowed,
    },
  });
  expect(JSON.stringify(body)).not.toMatch(/not[_ ]covered/);
}
async function unavailable(
  response: Response,
  year: number,
  domain: AnnualDomain,
  allowed: number[],
  surface: string,
) {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  notLoaded(await response.json(), year, domain, allowed, surface);
}

async function qualify(
  history: HistoryYears,
  date: string,
  state: AdmissionState,
  missingPrevious = false,
) {
  at(date);
  const year = new Date(date).getUTCFullYear();
  await setWindowAdmissions(db, state, year);
  const expected = expectedDomains(history, year, state, missingPrevious);
  const loaded = await statusApp(history);
  const mcp = await connect({
    db,
    data: loaded.cfg.data,
    now: Date.now,
    cache: createResponseCache(db, undefined, { config: loaded.cfg }),
  });
  try {
    const policyResponse = await loaded.app.request("/v1/data-policy");
    expect(policyResponse.status).toBe(200);
    const policy: unknown = await policyResponse.json();
    expect(policy, "WINDOW_ALLOWED: policy inventories").toMatchObject({
      schema_version: 1,
      history_years: history,
      calendar_year: year,
      domains: expected,
    });
    const statusResponse = await loaded.app.request("/status.json");
    expect(statusResponse.status).toBe(200);
    const status = publicStatusSchema.parse(await statusResponse.json());
    expect(status.data.policy).toEqual(policy);
    expect(
      status.data.policy!.domains.individual.allowed_years.length,
    ).toBeLessThanOrEqual(history);
    const dataStatus = await mcp.call("get_data_status", {});
    expect(dataStatus.data!.data_policy).toEqual(policy);

    for (const requestedYear of fixtureYears) {
      const allowed = expectedWindow(
        history,
        year,
        state === "individual" || state === "both",
      );
      const allowedMedicare = expectedWindow(
        history,
        year,
        state === "medicare" || state === "both",
      );
      const admitted = allowed.includes(requestedYear);
      const rest = await loaded.app.request(
        `/v1/carriers?state=TX&year=${requestedYear}`,
      );
      const compat = await loaded.app.request(
        `/compat/v1/carriers?state=TX&year=${requestedYear}`,
      );
      const directory = await mcp.call(
        "list_carriers_networks",
        { state: "TX", year: requestedYear },
        !admitted,
      );
      if (!admitted) {
        await unavailable(rest, requestedYear, "individual", allowed, "REST");
        await unavailable(
          compat,
          requestedYear,
          "individual",
          allowed,
          "compatibility",
        );
        expect(directory.data).toBeNull();
        notLoaded(directory, requestedYear, "individual", allowed, "MCP");
      } else {
        const missing = missingPrevious && requestedYear === year - 1;
        expect(rest.status).toBe(200);
        expect(await rest.json()).toMatchObject({
          status: missing ? "unknown" : "available",
          carriers: missing
            ? []
            : [
                {
                  plan_year: requestedYear,
                  snapshot_id: `synthetic-window-${requestedYear}`,
                  marketing_names: [
                    `Synthetic qualification issuer ${requestedYear}`,
                  ],
                },
              ],
        });
        expect(compat.status).toBe(200);
        expect(await compat.json()).toMatchObject({
          meta: { total: missing ? 0 : 1 },
          carriers: missing
            ? []
            : [
                {
                  name: `Synthetic qualification issuer ${requestedYear}`,
                },
              ],
        });
        if (missing)
          expect(compat.headers.get("x-openplans-gaps")).toContain(
            "no_loaded_catalog_for_state_and_year",
          );
        expect(directory).toMatchObject({
          status: missing ? "unknown" : "ok",
          error: null,
          data: {
            rows: missing
              ? []
              : [
                  {
                    year: requestedYear,
                    name: `Synthetic qualification issuer ${requestedYear}`,
                  },
                ],
          },
        });
      }
      const medicare = await loaded.app.request(
        `/v1/medicare/plans?county_fips=48201&year=${requestedYear}`,
      );
      const medicareMcp = await mcp.call(
        "search_medicare_plans",
        { year: requestedYear, location: { county: "48201" } },
        !allowedMedicare.includes(requestedYear),
      );
      if (!allowedMedicare.includes(requestedYear)) {
        await unavailable(
          medicare,
          requestedYear,
          "medicare",
          allowedMedicare,
          "REST Medicare",
        );
        notLoaded(
          medicareMcp,
          requestedYear,
          "medicare",
          allowedMedicare,
          "MCP Medicare",
        );
      } else {
        expect(medicare.status).toBe(200);
        expect(await medicare.json()).toMatchObject({
          contract_year: requestedYear,
        });
        expect(medicareMcp).toMatchObject({
          error: null,
          data: { contract_year: requestedYear },
        });
      }
    }
    const detail = await loaded.app.request(
      `/v1/plans/${syntheticPlan}?year=${year}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      plan_year: year,
      benefits_status: "unknown",
      cost_sharing: { status: "unknown" },
    });
    const compatDetail = await loaded.app.request(
      `/compat/v1/plans/${syntheticPlan}?year=${year}`,
    );
    expect(compatDetail.status).toBe(200);
    expect(compatDetail.headers.get("x-openplans-gaps")).toContain(
      "variant_cost_sharing_unknown",
    );
    expect(await compatDetail.text()).not.toMatch(/not[_ ]covered/);
    // Real RxCUI from tests/fixtures/rxnorm/RXNCONSO.RRF; no terminology is loaded here.
    const drug = await loaded.app.request(
      `/v1/plans/${syntheticPlan}/drugs/6809?year=${year}`,
    );
    expect(drug.status).toBe(200);
    expect(await drug.json()).toMatchObject({
      status: "unknown",
      reason: "rxcui_not_in_rxnorm",
    });
    const drugMcp = await mcp.call("check_drug_coverage", {
      plan_ids: [syntheticPlan],
      rxcuis: ["6809"],
      year,
    });
    expect(drugMcp).toMatchObject({
      error: null,
      data: { results: [{ status: "unknown" }] },
    });
  } finally {
    await mcp.close();
    await loaded.close();
  }
}

const cases = ([1, 2, 3] as const).flatMap((history) =>
  calendarPositions.flatMap((date) =>
    admissionStates.map((state) => ({ history, date, state })),
  ),
);
describe("bounded annual windows through REST, compatibility, MCP and public status", () => {
  it.each(cases)(
    "history=$history at $date with admission=$state",
    async ({ history, date, state }) => {
      await qualify(history, date, state);
    },
  );
  it("keeps missing previous-year evidence unknown without shifting backward", async () => {
    await db.exec("DELETE FROM puf_active_catalog WHERE plan_year=2025");
    try {
      await qualify(3, calendarPositions[0]!, "none", true);
    } finally {
      await db.exec(
        "INSERT INTO puf_active_catalog VALUES ('TX',2025,'synthetic-window-2025')",
      );
    }
  });
  it.each([1, 2, 3] as const)(
    "refreshes warm status and catalog entries across UTC rollover with setting %i",
    async (history) => {
      at("2026-12-31T23:59:59.999Z");
      await setWindowAdmissions(db, history === 2 ? "none" : "both", 2026);
      const loaded = await statusApp(history, true);
      const mcp = await connect({
        db,
        data: loaded.cfg.data,
        now: Date.now,
        cache: createResponseCache(db, undefined, {
          config: loaded.cfg,
          store: loaded.store,
        }),
      });
      // Current year is admitted by every setting, and expires only for setting 1.
      const expires = history === 1 ? 2026 : 2025;
      const warmed = expires;
      const path = `/v1/plans?county=48201&year=${warmed}`;
      try {
        for (const url of [path, "/status.json"]) {
          expect((await loaded.app.request(url)).status).toBe(200);
          expect((await loaded.app.request(url)).headers.get("x-cache")).toBe(
            "hit",
          );
        }
        for (let i = 0; i < 2; i++)
          await mcp.call("list_carriers_networks", {
            state: "TX",
            year: warmed,
          });
        vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
        const allowed = expectedWindow(history, 2027, false);
        for (const url of [
          `/v1/plans?county=48201&year=${expires}`,
          `/compat/v1/carriers?state=TX&year=${expires}`,
        ])
          await unavailable(
            await loaded.app.request(url),
            expires,
            "individual",
            allowed,
            "UTC rollover",
          );
        notLoaded(
          await mcp.call(
            "list_carriers_networks",
            { state: "TX", year: expires },
            true,
          ),
          expires,
          "individual",
          allowed,
          "MCP UTC rollover",
        );
        const after = publicStatusSchema.parse(
          await (await loaded.app.request("/status.json")).json(),
        );
        expect(after.data.policy!.calendar_year).toBe(2027);
        expect(after.data.policy!.domains.individual.allowed_years).toEqual(
          allowed,
        );
      } finally {
        await mcp.close();
        await loaded.close();
      }
    },
  );
  it("expires cached previous-year answers when setting 2 admits next year", async () => {
    at("2026-11-19T00:00:00Z");
    await setWindowAdmissions(db, "none", 2026);
    const loaded = await statusApp(2, true);
    const mcp = await connect({
      db,
      data: loaded.cfg.data,
      now: Date.now,
      cache: createResponseCache(db, undefined, {
        config: loaded.cfg,
        store: loaded.store,
      }),
    });
    const path = "/v1/plans?county=48201&year=2025";
    try {
      expect((await loaded.app.request(path)).status).toBe(200);
      expect((await loaded.app.request(path)).headers.get("x-cache")).toBe(
        "hit",
      );
      await mcp.call("list_carriers_networks", { state: "TX", year: 2025 });
      await mcp.call("list_carriers_networks", { state: "TX", year: 2025 });
      expect((await loaded.app.request("/status.json")).status).toBe(200);
      await setWindowAdmissions(db, "individual", 2026);
      const allowed = [2026, 2027];
      for (const url of [path, "/compat/v1/carriers?state=TX&year=2025"])
        await unavailable(
          await loaded.app.request(url),
          2025,
          "individual",
          allowed,
          "next-year admission",
        );
      notLoaded(
        await mcp.call(
          "list_carriers_networks",
          { state: "TX", year: 2025 },
          true,
        ),
        2025,
        "individual",
        allowed,
        "MCP next-year admission",
      );
      expect(
        await mcp.call("list_carriers_networks", { state: "TX", year: 2027 }),
      ).toMatchObject({
        data: {
          rows: [{ year: 2027, name: "Synthetic qualification issuer 2027" }],
        },
        error: null,
      });
      const status = publicStatusSchema.parse(
        await (await loaded.app.request("/status.json")).json(),
      );
      expect(status.data.policy!.domains.individual.allowed_years).toEqual(
        allowed,
      );
      expect(status.data.policy!.domains.medicare.allowed_years).toEqual([
        2025, 2026,
      ]);
    } finally {
      await mcp.close();
      await loaded.close();
    }
  });
});

describe("annual-window planted source mutants", () => {
  it.each(["REST", "compatibility"] as const)(
    "rejects %s mapping not_loaded to not_covered",
    async (surface) => {
      at("2026-11-19T00:00:00Z");
      await setWindowAdmissions(db, "both", 2026);
      const path =
        surface === "REST"
          ? "/v1/carriers?state=TX&year=2024"
          : "/compat/v1/carriers?state=TX&year=2024";
      const contract = async (factory: typeof createApp) => {
        const response = await factory(db, {}, { config: config(3) }).request(
          path,
        );
        await unavailable(
          response,
          2024,
          "individual",
          [2025, 2026, 2027],
          surface,
        );
      };
      await contract(createApp);
      const original = new URL("../../src/api/app.ts", import.meta.url);
      const source = replaceSyntax(
        await readFile(original, "utf8"),
        "{ error: error.error },",
        `{ error: { ...error.error, code: c.req.path.startsWith(${JSON.stringify(surface === "REST" ? "/v1/" : "/compat/")}) && error.error.code === "not_loaded" ? "not_covered" : error.error.code } },`,
      );
      await withMutantFile(original, source, async (file) => {
        const mutant = await importMutant<typeof appModule>(file, "createApp");
        await expect(contract(mutant.createApp)).rejects.toThrow(
          `WINDOW_NOT_LOADED:${surface}`,
        );
      });
    },
  );
  it("rejects MCP mapping not_loaded to not_covered", async () => {
    at("2026-11-19T00:00:00Z");
    await setWindowAdmissions(db, "both", 2026);
    const contract = async (call: typeof toolsModule.callTool) => {
      const result = await call(
        { db, now: Date.now, data: { historyYears: 3 } },
        "list_carriers_networks",
        { state: "TX", year: 2024 },
      );
      notLoaded(
        outputSchemas.list_carriers_networks.parse(result.structuredContent),
        2024,
        "individual",
        [2025, 2026, 2027],
        "MCP",
      );
    };
    await contract(toolsModule.callTool);
    const original = new URL("../../src/mcp/tools.ts", import.meta.url);
    const source = replaceSyntax(
      await readFile(original, "utf8"),
      "code = error.error.code;",
      'code = error.error.code === "not_loaded" ? "not_covered" : error.error.code;',
    );
    await withMutantFile(original, source, async (file) => {
      const mutant = await importMutant<typeof toolsModule>(file, "callTool");
      await expect(contract(mutant.callTool)).rejects.toThrow(
        "WINDOW_NOT_LOADED:MCP",
      );
    });
  });
  it("rejects an off-by-one previous-year boundary", async () => {
    const contract = (resolve: typeof resolveAnnualPolicy) => {
      const policy = resolve(
        3,
        [],
        { individual: fixtureYears, medicare: fixtureYears },
        new Date("2026-11-19Z"),
      );
      expect(policy.domains.individual.allowed_years, "WINDOW_ALLOWED").toEqual(
        expectedWindow(3, 2026, false),
      );
    };
    contract(resolveAnnualPolicy);
    const original = new URL(
      "../../src/domain/data-window.ts",
      import.meta.url,
    );
    const source = replaceSyntax(
      await readFile(original, "utf8"),
      "[calendar_year - 1]",
      "[calendar_year - 2]",
    );
    await withMutantFile(original, source, async (file) => {
      const mutant = await importMutant<typeof windowModule>(
        file,
        "resolveAnnualPolicy",
      );
      expect(() => contract(mutant.resolveAnnualPolicy)).toThrow(
        "WINDOW_ALLOWED",
      );
    });
  });
});
