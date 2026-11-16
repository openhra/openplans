import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { HostAvailabilityEntry, OperatorHost, OperatorObservation, PluginRouteEnv } from "@openplans/plugin-sdk";
import type { AdminPageDependencies } from "../../src/contracts.js";
import { registerCoverage } from "../../src/coverage/index.js";

const fixture = (index: number): HostAvailabilityEntry => ({
  state: index % 2 ? "NY" : "CA",
  year: 2026,
  market: index % 2 ? "on_exchange" : "off_exchange",
  issuer_id: `issuer-${index}`,
  catalog: "available",
  premium: index === 1 ? "unknown" : "available",
  provider: "unknown",
  formulary: "missing",
  snapshot_id: `snapshot-${index}`,
});

function setup(entries: readonly HostAvailabilityEntry[]) {
  let readFailure = false;
  const availability = vi.fn(async (): Promise<OperatorObservation<readonly HostAvailabilityEntry[]>> =>
    readFailure
      ? { state: "unavailable", reason: "read_failed", observedAt: "2026-11-15T12:00:00.000Z" }
      : { state: "available", observedAt: "2026-11-15T12:00:00.000Z", value: entries },
  );
  const catalog = vi.fn(async () => ({
    state: "available" as const,
    observedAt: "2026-11-15T12:00:01.000Z",
    value: { generation: "generation-7", providerSearch: "unavailable_or_stale" as const },
  }));
  const routes: Parameters<AdminPageDependencies["routes"]["add"]>[0][] = [];
  const operator = { availability, catalog } as unknown as OperatorHost;
  const dependencies = {
    routes: { add: (spec: (typeof routes)[number]) => routes.push(spec) },
    operator,
    status: { dataAvailability: vi.fn() },
    now: () => new Date("2026-11-15T12:00:00.000Z"),
  } satisfies AdminPageDependencies;
  registerCoverage(dependencies);
  const route = routes[0]!;
  const app = new Hono<PluginRouteEnv>();
  app.use("*", (c, next) => {
    c.set("pluginDb", {} as never);
    c.set("pluginSignal", new AbortController().signal);
    return next();
  });
  app.get(route.path, route.handler);
  return { app, availability, catalog, status: dependencies.status, failAvailability: () => { readFailure = true; } };
}

it("filters canonical availability, paginates in bounded pages, and counts against filtered denominators", async () => {
  const service = setup(Array.from({ length: 31 }, (_, index) => fixture(index)));
  const first = await service.app.request("/admin/coverage");
  const firstHtml = await first.text();
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(firstHtml).toContain("31 matching of 31 returned scopes");
  expect(firstHtml).toContain("unknown of 31 returned scopes");
  expect(firstHtml).toContain("Snapshot identifiers");
  expect(firstHtml).toContain("Retrieval and publisher dates are unknown");
  expect(firstHtml).toContain("Provider search index: unavailable_or_stale");
  expect(firstHtml).toContain("generation-7");
  expect(firstHtml).toContain("Next page");
  expect(firstHtml).toContain("issuer-0");
  expect(firstHtml).not.toContain("issuer-25");

  const second = await service.app.request("/admin/coverage?offset=25");
  const secondHtml = await second.text();
  expect(secondHtml).toContain("Showing 26–31 of 31 matching scopes");
  expect(secondHtml).toContain("issuer-30");
  expect(secondHtml).toContain("Previous page");
  expect(service.availability).toHaveBeenCalledTimes(2);
  expect(service.catalog).toHaveBeenCalledTimes(2);
  expect(service.status.dataAvailability).not.toHaveBeenCalled();
});

it("keeps unsupported and malformed availability values unknown and rejects unbounded queries", async () => {
  const entry = { ...fixture(1), market: null, premium: "mystery" } as unknown as HostAvailabilityEntry;
  const service = setup([entry]);
  const response = await service.app.request("/admin/coverage?offset=5001");
  expect(response.status).toBe(400);
  expect(service.availability).not.toHaveBeenCalled();

  const page = await service.app.request("/admin/coverage");
  const html = await page.text();
  expect(html).toContain("unknown channel");
  expect(html).toContain("<td>unknown</td>");
  expect(html).not.toContain("mystery");
  expect(html).toContain("1 unknown of 1 returned scopes");
});

it("renders availability read failures as unknown without inventing zero coverage", async () => {
  const service = setup([]);
  service.failAvailability();
  const response = await service.app.request("/admin/coverage");
  const html = await response.text();
  expect(html).toContain("Coverage availability is unknown: read_failed");
  expect(html).not.toContain("0 available");
});
