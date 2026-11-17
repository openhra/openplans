import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import type { Database, RouteSpec, WorkerContext } from "@openplans/plugin-sdk";
import { createApp } from "../../../src/api/app.js";
import { coreConfigView, loadConfig } from "../../../src/config/index.js";
import {
  freezeRegistries,
  ADMIN_PLUGIN,
} from "../../../src/plugins/registries.js";
import { OperatorCommandRefused } from "../../../src/operator/commands/scope.js";
import { createOperatorCommandClient } from "../../../src/operator/commands/service.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { runPluginCommand } from "../../../src/plugins/worker.js";
import { migratedTemplate } from "../../pglite.js";
import {
  login,
  csrf,
  request,
  post,
  ORIGIN,
  TOKEN,
} from "../session/helpers.js";
import { authority, envelope, register, setup, unchanged } from "./fixture.js";

let template: Awaited<ReturnType<typeof migratedTemplate>>;
let db: Database;
beforeAll(async () => {
  template = await migratedTemplate();
});
afterAll(async () => {
  await template?.close();
});
beforeEach(async () => {
  db = await template.fresh();
  await setup(db);
});
afterEach(async () => {
  await db?.close();
});
function app(writable?: () => boolean) {
  const registries = register();
  const routes: RouteSpec[] = [
    {
      method: "GET",
      path: "/admin/customizations/result",
      exposure: "operator",
      adminSession: true,
      contentType: "application/json",
      handler: async (c) => {
        await expect(
          c.get("pluginOperatorCommands")!.execute(envelope()),
        ).rejects.toThrow("operator_command_read_only");
        return c.json(
          await c.get("pluginOperatorCommands")!.result({
            command: envelope().command,
            source_id: envelope().source_id,
            idempotency_key: envelope().idempotency_key,
          }),
        );
      },
    },
    {
      method: "GET",
      path: "/admin",
      exposure: "operator",
      adminSession: true,
      contentType: "text/html",
      handler: (c) =>
        c.html(
          `<input name="csrf" value="${c.get("pluginAdminSession")?.csrfToken ?? ""}">`,
        ),
    },
    {
      method: "POST",
      path: "/admin/customizations/draft",
      exposure: "operator",
      adminSession: true,
      contentType: "application/json",
      handler: async (c) => {
        expect(c.get("pluginPassThroughWriter")).toBeUndefined();
        expect(c.get("pluginDb")).not.toHaveProperty("transaction");
        try {
          return c.json(
            await c.get("pluginOperatorCommands")!.execute(envelope()),
          );
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof OperatorCommandRefused ? error.code : "failed",
            },
            409,
          );
        }
      },
    },
  ];
  registries.routes.push(
    ...routes.map((spec) => ({ plugin: ADMIN_PLUGIN, spec })),
  );
  const config = loadConfig(
    { OPENPLANS_OPERATOR_TOKEN: TOKEN },
    { version: 1, admin: { origin: ORIGIN, ingressReviewed: true } },
  );
  freezeRegistries(registries);
  const projection = {
    routes: registries.routes,
    cacheStores: registries.cacheStores,
    sources: registries.sources,
  };
  return createApp(
    db,
    {},
    { config, plugins: projection },
    undefined,
    writable ? { writable } : undefined,
  );
}
it("binds commands only after private session and CSRF checks; host supplies the actor", async () => {
  const api = app(() => true);
  const before = await unchanged(db);
  const path = "/admin/customizations/draft";
  expect((await post(api, path, "", { csrf: "forged" })).status).toBe(401);
  const signed = await login(api);
  const page = await request(api, "/admin", {
    headers: { cookie: signed.cookie },
  });
  const token = csrf(await page.text());
  for (const fields of [{}, { csrf: "forged" }] as Record<string, string>[])
    expect((await post(api, path, signed.cookie, fields)).status).toBe(401);
  expect(
    (
      await post(
        api,
        path,
        signed.cookie,
        { csrf: token },
        { origin: "https://foreign.test" },
      )
    ).status,
  ).toBe(401);
  expect(await unchanged(db)).toEqual(before);
  const result = await post(
    api,
    path,
    signed.cookie,
    { csrf: token },
    { "x-operator-actor": "forged" },
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  const output = (await result.json()) as unknown;
  const stored = await unchanged(db);
  expect((stored.audit[0]!.entry as Record<string, unknown>).actor).toEqual({
    class: "shared_operator",
  });
  const worker = createOperatorCommandClient(
    { db, commands: register().operatorCommands, writable: () => true },
    authority(),
  );
  expect(await worker.execute(envelope())).toEqual(output);
  expect(await unchanged(db)).toEqual(stored);
});
it("defaults to read-only even with a signed session and registered handler", async () => {
  const api = app();
  const signed = await login(api);
  const page = await request(api, "/admin", {
    headers: { cookie: signed.cookie },
  });
  const before = await unchanged(db);
  const response = await post(
    api,
    "/admin/customizations/draft",
    signed.cookie,
    { csrf: csrf(await page.text()) },
  );
  expect(await response.json()).toEqual({
    error: "operator_command_read_only",
  });
  expect(await unchanged(db)).toEqual(before);
});
it("provides no general HTTP or MCP command endpoint", async () => {
  const api = app(() => true);
  for (const path of [
    "/operator/commands",
    "/admin/commands",
    "/admin/customizations/publish",
  ]) {
    expect(
      (
        await request(api, path, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  }
});

it("runs a loaded worker adapter through the same registry as the API", async () => {
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: [
        { package: new URL("./plugin-fixture.ts", import.meta.url).pathname },
      ],
    },
  );
  const loaded = await loadPlugins(config, "worker", {
    env: {},
    exit: () => {
      throw new Error("fixture refused");
    },
  });
  try {
    const registered = loaded.registries.workerCommands[0]!;
    const logs: string[] = [];
    const code = await runPluginCommand(
      {
        ...registered,
        writer: true,
        emits: true,
        config: coreConfigView(config) as unknown as WorkerContext["config"],
      },
      [],
      () => ({ ...db, close: async () => {} }),
      { out: (line) => logs.push(line), error: (line) => logs.push(line) },
    );
    expect(code).toBe(0);
    const record = logs
      .map((line) => JSON.parse(line) as { command_result?: string })
      .find((entry) => entry.command_result);
    const expected = JSON.parse(record!.command_result!) as unknown;
    const api = app(() => true);
    const signed = await login(api);
    const page = await request(api, "/admin", {
      headers: { cookie: signed.cookie },
    });
    const response = await post(
      api,
      "/admin/customizations/draft",
      signed.cookie,
      { csrf: csrf(await page.text()) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    const saved = await unchanged(db);
    expect(saved.audit).toHaveLength(1);
    expect((saved.audit[0]!.entry as Record<string, unknown>).actor).toEqual({
      class: "worker",
    });
  } finally {
    await loaded.teardown();
  }
});

it("allows authorized GET result lookup while refusing GET execution", async () => {
  const api = app(() => true);
  const signed = await login(api);
  const page = await request(api, "/admin", {
    headers: { cookie: signed.cookie },
  });
  await post(api, "/admin/customizations/draft", signed.cookie, {
    csrf: csrf(await page.text()),
  });
  const before = await unchanged(db);
  const result = await request(api, "/admin/customizations/result", {
    headers: { cookie: signed.cookie },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ allowed: true });
  expect(await unchanged(db)).toEqual(before);
});
