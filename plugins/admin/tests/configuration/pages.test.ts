import { Hono } from "hono";
import { expect, it } from "vitest";
import type {
  OperatorConfiguration,
  OperatorHost,
  PluginRouteEnv,
  RouteSpec,
  SqlSession,
} from "@openplans/plugin-sdk";
import { registerConfiguration } from "../../src/configuration/index.js";
import type { AdminPageDependencies } from "../../src/contracts.js";

const timestamp = "2026-11-15T12:00:00.000Z";
const configuration: OperatorConfiguration = {
  settings: [
    {
      key: "admin.instances",
      displayValue: 2,
      source: "environment",
      appliedAt: "startup",
      process: "api",
      writable: false,
      reason: "deployment_managed",
    },
    {
      key: "tokens.operator",
      displayValue: "configured",
      source: "environment",
      appliedAt: "startup",
      process: "api",
      writable: false,
      reason: "secret_presence_only",
    },
    {
      key: "cache.url",
      displayValue: "unset",
      source: "default",
      appliedAt: "startup",
      process: "api",
      writable: false,
      reason: "secret_presence_only",
    },
    {
      key: "db.connectionString",
      displayValue: "synthetic-secret-marker",
      source: "environment",
      appliedAt: "startup",
      process: "api",
      writable: false,
      reason: "secret_presence_only",
    },
    {
      key: "cache.provider",
      displayValue: null,
      source: "unknown",
      appliedAt: "startup",
      process: "api",
      writable: false,
      reason: "unsupported_value",
    },
  ],
  plugins: [
    {
      name: "@openplans/plugin-safe",
      configured: true,
      enabled: true,
      loaded: { version: "1.2.3", sha256: "a".repeat(64) },
      approved: {
        state: "available",
        deploymentId: "installation-1",
        version: "1.2.3",
        sha256: "a".repeat(64),
        completedAt: timestamp,
      },
    },
    {
      name: "@openplans/plugin-unverified",
      configured: true,
      enabled: false,
      loaded: null,
      approved: {
        state: "available",
        deploymentId: "installation-1",
        version: "1.0.0",
        sha256: null as unknown as string,
        completedAt: timestamp,
      },
    },
    {
      name: "@openplans/plugin-mismatch",
      configured: true,
      enabled: true,
      loaded: { version: "2.0.0", sha256: "c".repeat(64) },
      approved: {
        state: "available",
        deploymentId: "installation-1",
        version: "2.0.0",
        sha256: "d".repeat(64),
        completedAt: timestamp,
      },
    },
  ],
};

function setup(host?: OperatorHost) {
  const routes: RouteSpec[] = [];
  registerConfiguration({
    routes: { add: (route) => routes.push(route) },
    operator: host,
    status: {},
    now: () => new Date(timestamp),
  } satisfies AdminPageDependencies);
  return routes;
}

function hostFor(value = configuration): OperatorHost {
  return {
    configuration: async () => ({
      state: "available",
      value,
      observedAt: timestamp,
    }),
    availability: async () => ({
      state: "unavailable",
      reason: "not_supported",
      observedAt: timestamp,
    }),
    catalog: async () => ({
      state: "unavailable",
      reason: "not_supported",
      observedAt: timestamp,
    }),
    msot: {
      inspect: async () => ({
        state: "unavailable",
        reason: "not_supported",
        observedAt: timestamp,
      }),
    },
  };
}

function appFor(spec: RouteSpec) {
  const app = new Hono<PluginRouteEnv>();
  app.on(spec.method, spec.path, async (c) => {
    c.set("pluginDb", {
      query: async () => ({ rows: [] }),
      exec: async () => {},
    } as SqlSession);
    c.set("pluginSignal", AbortSignal.timeout(1000));
    c.set("pluginAdminSession", {
      csrfToken: "synthetic-csrf",
      authenticatedAt: 1,
    });
    return spec.handler(c);
  });
  return app;
}

it("renders effective safe settings, independent plugin identities, and unverified null hashes", async () => {
  const [page] = setup(hostFor());
  const response = await appFor(page!).request(page!.path);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain("environment");
  expect(html).toContain("startup");
  expect(html).toContain("configured");
  expect(html).toContain("unset");
  expect(html).toContain("unknown");
  expect(html).not.toContain("synthetic-secret-marker");
  expect(html).toContain("@openplans/plugin-safe");
  expect(html).toContain("loaded package matches approval");
  expect(html).toContain("approval does not match loaded package");
  expect(html).toContain("unverified");
  expect(html).toContain('name="key" value="admin.instances"');
  expect(html).not.toContain('name="key" value="tokens.operator"');
  expect(html).toContain("a".repeat(64));
  expect(html).toContain("d".repeat(64));
  expect(html).not.toContain("<script");
});

it("downloads only a validated inert proposal and rejects unknown keys and values", async () => {
  const routes = setup(hostFor());
  const proposal = routes.find((route) => route.method === "POST")!;
  const valid = await appFor(proposal).request(proposal.path, {
    method: "POST",
    body: new URLSearchParams({ key: "admin.instances", value: "3" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(valid.status).toBe(200);
  expect(valid.headers.get("content-disposition")).toContain("attachment");
  expect(valid.headers.get("cache-control")).toBe("no-store");
  expect(await valid.json()).toEqual({
    schemaVersion: 1,
    status: "not_applied",
    generatedAt: timestamp,
    changes: [
      {
        key: "admin.instances",
        current: 2,
        currentSource: "environment",
        applies: "startup",
        proposed: 3,
      },
    ],
  });

  const page = routes.find((route) => route.method === "GET")!;
  const afterProposal = await appFor(page).request(page.path);
  expect(await afterProposal.text()).toContain('value="2"');

  for (const fields of [
    { key: "tokens.operator", value: "secret" },
    { key: "cache.provider", value: "unknown-plugin" },
    { key: "admin.instances", value: "0" },
    { key: "admin.instances", value: "65" },
    { key: "admin.instances", value: "1.5" },
  ]) {
    const response = await appFor(proposal).request(proposal.path, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_proposal" });
  }
});

it("shows unavailable diagnostics as unknown and refuses proposal creation", async () => {
  const routes = setup();
  const page = routes.find((route) => route.method === "GET")!;
  const response = await appFor(page).request(page.path);
  const html = await response.text();
  expect(response.status).toBe(503);
  expect(html).toContain("Configuration is unknown");
  expect(html).not.toContain("Configuration: 0");
  expect(html).toContain("Proposal preparation is unavailable");
  expect(html).not.toContain('name="value"');
});
