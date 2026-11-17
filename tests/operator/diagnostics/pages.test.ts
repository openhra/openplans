import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import * as fieldsModule from "../../../plugins/admin/src/customizations/fields.js";
import type { PluginContext, RouteSpec } from "@openplans/plugin-sdk";
import { createAdminPlugin } from "../../../plugins/admin/src/index.js";
import { formsAvailable } from "../../../plugins/admin/src/customizations/forms.js";
import { fieldsAvailable } from "../../../plugins/admin/src/customizations/fields.js";
import { overridesAvailable } from "../../../plugins/admin/src/customizations/overrides.js";
import { renderUnavailable } from "../../../plugins/admin/src/render.js";
import { pluginRoutes } from "../../../src/plugins/routes.js";
import { ADMIN_PLUGIN } from "../../../src/plugins/registries.js";
import { db, fixture, login, post, request, csrf } from "../session/helpers.js";
import { responseDigest } from "../../plugins/admin-support/digests.js";

const frozenRoutes = [
  "GET /admin",
  "GET /admin/configuration",
  "POST /admin/configuration/proposal",
  "GET /admin/coverage",
  "GET /admin/metrics",
  "GET /admin/releases",
  "GET /admin/customizations",
  "POST /admin/customizations/inspect",
  "POST /admin/customizations/draft",
  "POST /admin/customizations/validate",
  "POST /admin/customizations/preview",
  "POST /admin/customizations/publish",
  "POST /admin/customizations/reactivate",
  "GET /admin/customizations/result",
  "GET /admin/customizations/versions",
  "GET /admin/customizations/audit",
];

function routes() {
  const routes: RouteSpec[] = [];
  createAdminPlugin().setup({
    routes: { add: (spec: RouteSpec) => routes.push(spec) },
  } as unknown as PluginContext);
  return routes;
}

it("freezes exact page/action registrations and leaves every unimplemented capability unavailable", async () => {
  const specs = routes();
  expect(specs.map((spec) => `${spec.method} ${spec.path}`)).toEqual(
    frozenRoutes,
  );
  expect(
    specs.every(
      (spec) =>
        spec.exposure === "operator" && spec.adminSession && !spec.cache,
    ),
  ).toBe(true);
  const deps = {
    routes: { add: () => {} },
    status: {},
    now: () => new Date(0),
  };
  expect(formsAvailable(deps)).toBe(false);
  expect(fieldsAvailable(deps)).toBe(false);
  expect(overridesAvailable(deps)).toBe(false);
  const f = fixture();
  const signedIn = await login(f.app);
  const overview = await request(f.app, "/admin", {
    headers: { cookie: signedIn.cookie },
  });
  const token = csrf(await overview.text());
  expect(token).not.toBe("");
  for (const spec of specs.slice(1)) {
    let response: Response;
    if (spec.method === "POST") {
      expect(
        (await post(f.app, spec.path, signedIn.cookie, {})).status,
        spec.path,
      ).toBe(401);
      response = await post(f.app, spec.path, signedIn.cookie, { csrf: token });
    } else
      response = await request(f.app, spec.path, {
        headers: { cookie: signedIn.cookie },
      });
    if (spec.path === "/admin/coverage") {
      expect(response.status, spec.path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Coverage availability is unknown: not_supported");
      expect(html).toContain('aria-label="Admin sections"');
      expect(html).not.toContain("<script");
      continue;
    }
    if (spec.path === "/admin/configuration" && spec.method === "GET") {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Configuration is unknown");
      expect(html).toContain("Proposal preparation is unavailable");
      expect(html).toContain('aria-label="Admin sections"');
      expect(html).not.toContain("<script");
      expect(html).not.toContain('action="/admin/customizations/publish"');
      continue;
    }
    if (
      spec.path === "/admin/configuration/proposal" &&
      spec.method === "POST"
    ) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "invalid_proposal" });
      continue;
    }
    if (spec.path === "/admin/releases") {
      expect(response.status, spec.path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Releases and recovery");
      expect(html).toContain("No receipt is present.");
      expect(html).not.toContain("<script");
      continue;
    }
    if (spec.path === "/admin/customizations/inspect") {
      expect(response.status, spec.path).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        state: "unavailable",
        reason: "not_supported",
      });
      continue;
    }
    expect(response.status, spec.path).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    assertUnavailable(html, response.status);
    expect(html).toContain('aria-label="Admin sections"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('action="/admin/customizations/publish"');
  }
});

function assertUnavailable(html: string, status: number) {
  expect(status).toBe(503);
  expect(html).toContain(
    "This feature is not installed. No changes were made.",
  );
  expect(html).not.toContain("Changes saved");
}

it("removes all page and action paths when absent, disabled or credential-free", async () => {
  for (const enabled of [false, true]) {
    const app = new Hono();
    const router = pluginRoutes(
      {
        routes: enabled
          ? routes().map((spec) => ({ plugin: ADMIN_PLUGIN, spec }))
          : [],
      },
      { db, operatorToken: () => undefined, trustedProxies: [] },
    );
    router.guard(app);
    router.mount(app);
    for (const spec of routes())
      expect(
        (await app.request(spec.path, { method: spec.method })).status,
      ).toBe(404);
  }
});

it("prewires independent field views behind their capability predicate", async () => {
  const handler = vi.fn(() => new Response("synthetic-installed-fields"));
  const available = vi
    .spyOn(fieldsModule, "fieldsAvailable")
    .mockReturnValue(false);
  vi.spyOn(fieldsModule, "fieldsHandler").mockReturnValue(handler);
  try {
    const f = fixture();
    const signedIn = await login(f.app);
    const init = { headers: { cookie: signedIn.cookie } };
    expect(
      (await request(f.app, "/admin/customizations?view=fields", init)).status,
    ).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    // Disposable capability fixture proves later modules can dispatch without editing the inspector.
    available.mockReturnValue(true);
    const response = await request(
      f.app,
      "/admin/customizations?view=fields",
      init,
    );
    expect(await response.text()).toBe("synthetic-installed-fields");
    expect(handler).toHaveBeenCalledOnce();
    expect(
      (await request(f.app, "/admin/customizations?view=unknown", init)).status,
    ).toBe(400);
  } finally {
    vi.restoreAllMocks();
  }
});

it("accepts only a configured fixed evidence mount, without reading or rendering its path", () => {
  const options = createAdminPlugin().manifest.options!;
  const mount = {
    evidenceMount: {
      directory: "/synthetic-private-mount",
      deploymentId: "synthetic-installation",
    },
  };
  expect(options.safeParse(mount).success).toBe(true);
  expect(
    options.safeParse({
      evidenceMount: { ...mount.evidenceMount, directory: "../request-path" },
    }).success,
  ).toBe(false);
  expect(
    options.safeParse({ ...mount, arbitraryCallback: () => {} }).success,
  ).toBe(false);
});

it("rejects working-write, escaping, one-byte body and stable-header mutants", async () => {
  const html = renderUnavailable("<synthetic-markup>", "synthetic-time");
  expect(html).toContain("&lt;synthetic-markup&gt;");
  expect(html).not.toContain("<synthetic-markup>");
  assertUnavailable(html, 503);
  expect(() =>
    assertUnavailable(
      html.replace(
        "This feature is not installed. No changes were made.",
        "Changes saved",
      ),
      200,
    ),
  ).toThrow();
  const expected = await responseDigest(
    new Response(html, {
      status: 503,
      headers: { "cache-control": "no-store" },
    }),
  );
  const body = await responseDigest(
    new Response(`${html} `, {
      status: 503,
      headers: { "cache-control": "no-store" },
    }),
  );
  const header = await responseDigest(
    new Response(html, { status: 503, headers: { "cache-control": "public" } }),
  );
  expect(() => expect(body).toEqual(expected)).toThrow();
  expect(() => expect(header).toEqual(expected)).toThrow();
});
