import { expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { loadConfig } from "../../../src/config/index.js";
import { pluginRoutes } from "../../../src/plugins/routes.js";
import {
  emptyRegistries,
  emptySeen,
  stagingRegistrar,
} from "../../../src/plugins/registries.js";
import type { RouteSpec } from "@openplans/plugin-sdk";
import { db, fixture, login, ORIGIN, request, TOKEN } from "./helpers.js";

it("never accepts admin cookies for operator status, another plugin, protected API or MCP", async () => {
  const f = fixture();
  const routes = [
    ...f.routes,
    ...["/status/operator.json", "/synthetic/operator"].map((path, i) => ({
      plugin: i === 0 ? "@openplans/plugin-status" : "@synthetic/other",
      spec: {
        method: "GET" as const,
        path: path as `/${string}`,
        exposure: "operator" as const,
        contentType: "application/json" as const,
        handler: () => Response.json({ ok: true }),
      },
    })),
  ];
  const app = createApp(
    db,
    { premiumToken: TOKEN },
    {
      config: loadConfig(
        {
          OPENPLANS_OPERATOR_TOKEN: TOKEN,
          OPENPLANS_PUBLIC_QUOTING: "off",
          OPENPLANS_MCP: "off",
        },
        { version: 1, admin: { origin: ORIGIN, ingressReviewed: true } },
      ),
      plugins: { routes },
    },
  );
  const signed = await login(app);
  expect(
    (await request(app, "/admin", { headers: { cookie: signed.cookie } }))
      .status,
  ).toBe(200);
  for (const path of ["/status/operator.json", "/synthetic/operator"]) {
    expect(
      (await request(app, path, { headers: { cookie: signed.cookie } })).status,
    ).toBe(401);
    expect(
      (
        await request(app, path, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
  }
  for (const path of [
    "/v1/quotes",
    "/compat/v1/plans/medical/search",
    "/mcp",
  ]) {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const plain = await request(app, path, init);
    const withCookie = await request(app, path, {
      ...init,
      headers: { ...init.headers, cookie: signed.cookie },
    });
    expect(withCookie.status).toBe(plain.status);
    expect(withCookie.status).not.toBe(200);
    expect(await withCookie.text()).toBe(await plain.text());
  }
});

it("rejects cookie/form policy opt-in outside the admin package and reserves core session routes", () => {
  const base: RouteSpec = {
    method: "GET",
    path: "/admin",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: (c) => c.html("safe"),
  };
  for (const [plugin, spec] of [
    ["@synthetic/other", base],
    ["@openplans/plugin-admin", { ...base, path: "/synthetic" }],
    ["@openplans/plugin-admin", { ...base, exposure: "public" }],
    ["@openplans/plugin-admin", { ...base, cache: { ttlSeconds: 60 } }],
    ["@openplans/plugin-admin", { ...base, path: "/admin/login" }],
  ] as const) {
    const registrar = stagingRegistrar(
      emptyRegistries(),
      {
        name: plugin,
        version: "0.0.1",
        apiVersion: "0.2",
        kinds: ["routes"],
        capabilities: { operatorRoutes: true },
      },
      "api",
      emptySeen(),
    );
    expect(() => registrar.context.routes.add(spec)).toThrow();
    expect(() =>
      pluginRoutes(
        { routes: [{ plugin, spec }] },
        { db, operatorToken: () => TOKEN, trustedProxies: [] },
      ),
    ).toThrow();
  }
});
