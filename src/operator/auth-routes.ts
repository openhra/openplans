import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timeout } from "hono/timeout";
import { HTTPException } from "hono/http-exception";
import type { CoreConfig } from "../config/index.js";
import { credentialMatches } from "../compat/v1/auth.js";
import {
  createSourceLimiter,
  requestSource,
  sourceAdmission,
} from "../api/rate-limit.js";
import type { PeerAddress } from "../api/rate-limit.js";
import {
  adminHeaders,
  privateTransport,
  readAdminForm,
  validCsrf,
} from "./csrf.js";
import {
  adminCookie,
  createSessionStore,
  LOGIN_COOKIE,
  NONCE_MS,
  readCookie,
  SESSION_COOKIE,
  ABSOLUTE_MS,
} from "./session.js";

interface AuthOptions {
  enabled: () => boolean;
  config: () => CoreConfig;
  operatorToken: () => string | undefined;
  trustedProxies: readonly string[];
  peerAddress?: PeerAddress;
  now?: () => number;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
function page(title: string, action: string, csrf: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;max-width:36rem;margin:2rem auto;padding:1rem}label,input,button{display:block}input,button{font:inherit;min-height:44px;max-width:100%;box-sizing:border-box;margin-block:.5rem}button{padding:.5rem 1rem}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #007f79;outline-offset:3px}</style></head><body><main><h1>${title}</h1><form method="post" action="${action}"><input type="hidden" name="csrf" value="${escape(csrf)}"><label for="credential">Operator credential</label><input id="credential" name="credential" type="password" autocomplete="off" required maxlength="4096"><button type="submit">${title}</button></form><a href="/admin">Admin overview</a></main></body></html>`;
}

export function createAdminAuth(options: AuthOptions) {
  const now = options.now ?? Date.now;
  const store = createSessionStore(now);
  const signals = new WeakMap<Context, AbortSignal>();
  const sourceLimiter = createSourceLimiter(now);
  const globalLimiter = createSourceLimiter(now);
  if (
    options.enabled() &&
    options.config().admin.origin &&
    options.config().admin.instances !== 1
  )
    throw new Error("Admin browser sessions require one API instance");
  function settings() {
    const config = options.config();
    const token = options.operatorToken();
    const enabled = options.enabled();
    const available =
      enabled &&
      config.admin.origin &&
      config.admin.ingressReviewed &&
      config.admin.instances === 1 &&
      token;
    store.synchronize(
      available
        ? JSON.stringify([token, config.admin.origin, options.trustedProxies])
        : undefined,
    );
    return {
      enabled,
      token,
      origin: available ? config.admin.origin : undefined,
    };
  }
  const id = (c: Context) => readCookie(c.req.header("cookie"), SESSION_COOKIE);
  const failure = (c: Context) =>
    c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  function cookie(c: Context, name: string, value: string, age: number) {
    c.header("Set-Cookie", adminCookie(name, value, age), { append: true });
  }
  function transport(c: Context, origin: string) {
    return privateTransport(
      c,
      origin,
      options.trustedProxies,
      options.peerAddress,
    );
  }
  async function authorize(c: Context): Promise<Response | undefined> {
    const { origin } = settings();
    if (!origin) return failure(c);
    if (!transport(c, origin)) return failure(c);
    const session = store.read(id(c));
    if (!session)
      return c.req.method === "GET"
        ? c.redirect("/admin/login", 303)
        : failure(c);
    c.set("pluginAdminSession", session);
  }
  return {
    authorize,
    signal: (c: Context) => signals.get(c),
    async authorizeForm(c: Context): Promise<Response | undefined> {
      const { origin } = settings();
      const session = store.read(id(c));
      if (!origin || !session) return failure(c);
      const form = await readAdminForm(c, signals.get(c));
      if (signals.get(c)?.aborted)
        return c.json({ error: { code: "admin_unavailable" } }, 503);
      if (
        !form ||
        !validCsrf(c, origin, form.get("csrf") ?? undefined, session.csrfToken)
      )
        return failure(c);
    },
    protect(app: Hono) {
      // Precedes schema/cache/admission so failures and unknown admin paths are private too.
      const headers = async (c: Context, next: () => Promise<void>) => {
        if (!settings().enabled) return next();
        if (!signals.has(c)) signals.set(c, AbortSignal.timeout(15_000));
        adminHeaders(c);
        try {
          await next();
        } catch {
          c.res = c.json({ error: { code: "admin_unavailable" } }, 503);
        }
        adminHeaders(c);
      };
      app.use("/admin", headers);
      app.use("/admin/*", headers);
      const deadline = timeout(
        15_000,
        () => new HTTPException(503, { message: "admin_unavailable" }),
      );
      app.use("/admin", deadline);
      app.use("/admin/*", deadline);
    },
    mount(app: Hono) {
      const paths = ["/admin/login", "/admin/logout", "/admin/reauth"];
      for (const path of paths) {
        app.use(path, async (c: Context, next) => {
          const { origin } = settings();
          if (!origin) return c.notFound();
          if (!transport(c, origin) || new URL(c.req.url).search)
            return failure(c);
          await next();
        });
        app.use(
          path,
          sourceAdmission({
            limits: { perMinute: 60, activePerSource: 2, activeTotal: 8 },
            trustedProxies: options.trustedProxies,
            peerAddress: options.peerAddress,
            now,
          }),
        );
        app.use(
          path,
          bodyLimit({
            maxSize: 65_536,
            onError: (c) => c.json({ error: { code: "invalid_form" } }, 400),
          }),
        );
      }
      app.get("/admin/login", (c) => {
        const nonce = store.nonce();
        if (!nonce)
          return c.json({ error: { code: "admin_unavailable" } }, 503);
        cookie(c, LOGIN_COOKIE, nonce, NONCE_MS / 1000);
        return c.html(page("Sign in", "/admin/login", nonce));
      });
      app.get("/admin/reauth", (c) => {
        const session = store.read(id(c));
        if (!session) return c.redirect("/admin/login", 303);
        return c.html(
          page("Authenticate again", "/admin/reauth", session.csrfToken),
        );
      });
      for (const path of paths)
        app.post(path, async (c) => {
          const { origin, token } = settings();
          if (!origin || !token) return c.notFound();
          const source = requestSource(
            c,
            options.trustedProxies,
            options.peerAddress,
          );
          if (
            !sourceLimiter.take(source, 10).allowed ||
            !globalLimiter.take("all", 120).allowed
          )
            return c.json({ error: { code: "RATE_LIMITED" } }, 429);
          const form = await readAdminForm(c, signals.get(c));
          if (signals.get(c)?.aborted)
            return c.json({ error: { code: "admin_unavailable" } }, 503);
          const fields =
            path === "/admin/logout" ? ["csrf"] : ["csrf", "credential"];
          if (
            !form ||
            [...form.keys()].some((key) => !fields.includes(key)) ||
            (form.get("credential")?.length ?? 0) > 4096
          )
            return failure(c);
          const submitted = form.get("csrf") ?? "";
          const previous = id(c);
          if (path === "/admin/login") {
            const nonce = readCookie(c.req.header("cookie"), LOGIN_COOKIE);
            const consumed = store.consumeNonce(nonce, submitted);
            cookie(c, LOGIN_COOKIE, "", 0);
            if (
              !consumed ||
              !validCsrf(c, origin, submitted, nonce) ||
              !credentialMatches(form.get("credential") ?? undefined, token)
            )
              return failure(c);
          } else {
            const session = store.read(previous);
            if (!session || !validCsrf(c, origin, submitted, session.csrfToken))
              return failure(c);
            if (path === "/admin/logout") {
              store.revoke(previous);
              cookie(c, SESSION_COOKIE, "", 0);
              return c.redirect("/admin/login", 303);
            }
            if (!credentialMatches(form.get("credential") ?? undefined, token))
              return failure(c);
          }
          const next =
            path === "/admin/login"
              ? store.issue(previous)
              : store.renew(previous);
          if (!next)
            return c.json({ error: { code: "admin_unavailable" } }, 503);
          cookie(c, SESSION_COOKIE, next, ABSOLUTE_MS / 1000);
          return c.redirect("/admin", 303);
        });
    },
  };
}
export type AdminAuth = ReturnType<typeof createAdminAuth>;
