import { createApp } from "../../../src/api/app.js";
import { loadConfig } from "../../../src/config/index.js";
import type { SqlSession } from "../../../src/db/database.js";
import { createAdminPlugin } from "../../../plugins/admin/src/index.js";
import type { PluginContext, RouteSpec } from "@openplans/plugin-sdk";
import { ADMIN_PLUGIN } from "../../../src/plugins/registries.js";

export const ORIGIN = "https://admin.private.test";
export const TOKEN = "synthetic-session-credential";
export const db = {
  query: async () => ({ rows: [] }),
  exec: async () => {},
} as unknown as SqlSession;
export function fixture(
  options: {
    origin?: string;
    reviewed?: boolean;
    instances?: number;
    enabled?: boolean;
    peer?: string;
    trusted?: string[];
    extra?: RouteSpec[];
  } = {},
) {
  let time = 1_800_000_000_000;
  const routes: { plugin: string; spec: RouteSpec }[] = [];
  createAdminPlugin().setup({
    routes: {
      add: (spec: RouteSpec) => routes.push({ plugin: ADMIN_PLUGIN, spec }),
    },
  } as unknown as PluginContext);
  routes.push(
    ...(options.extra ?? []).map((spec) => ({ plugin: ADMIN_PLUGIN, spec })),
  );
  if (options.enabled === false) routes.length = 0;
  let config = loadConfig(
    { OPENPLANS_OPERATOR_TOKEN: TOKEN },
    {
      version: 1,
      admin: {
        origin: options.origin ?? ORIGIN,
        ingressReviewed: options.reviewed ?? true,
        instances: options.instances ?? 1,
      },
      trustProxy: options.trusted ?? [],
    },
  );
  const cache = {
    get config() {
      return config;
    },
    plugins: { routes },
  };
  const app = createApp(
    db,
    {
      premiumToken: undefined,
      peerAddress: () => options.peer,
      now: () => time,
    },
    cache,
  );
  return {
    app,
    routes,
    advance: (ms: number) => {
      time += ms;
    },
    credential(value?: string) {
      config = loadConfig(value ? { OPENPLANS_OPERATOR_TOKEN: value } : {}, {
        version: 1,
        admin: { origin: ORIGIN, ingressReviewed: true },
      });
    },
  };
}
export function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
) {
  return app.request(`${ORIGIN}${path}`, init);
}
export function cookie(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${name}=`))
      ?.split(";")[0] ?? ""
  );
}
export function csrf(html: string) {
  return /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
}
export function post(
  app: ReturnType<typeof createApp>,
  path: string,
  cookies: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return request(app, path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      cookie: cookies,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}
export async function login(app: ReturnType<typeof createApp>, previous = "") {
  const page = await request(app, "/admin/login");
  const nonce = csrf(await page.text());
  const response = await post(
    app,
    "/admin/login",
    [cookie(page, "__Secure-openplans_admin_login"), previous]
      .filter(Boolean)
      .join("; "),
    { csrf: nonce, credential: TOKEN },
  );
  return { response, cookie: cookie(response, "__Secure-openplans_admin") };
}
