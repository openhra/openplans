import { describe, expect, it } from "vitest";
import {
  createSessionStore,
  IDLE_MS,
  MAX_NONCES,
  MAX_SESSIONS,
} from "../../../src/operator/session.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import * as sessions from "../../../src/operator/session.js";
import { csrf, fixture, login, post, request, TOKEN } from "./helpers.js";

it("bounds allocations and frees expired records without keeping raw credentials", () => {
  let now = 1000;
  const store = createSessionStore(() => now);
  store.synchronize("synthetic-authority");
  for (let i = 0; i < MAX_NONCES; i++) expect(store.nonce()).toBeDefined();
  expect(store.nonce()).toBeUndefined();
  for (let i = 0; i < MAX_SESSIONS; i++) expect(store.issue()).toBeDefined();
  expect(store.issue()).toBeUndefined();
  now += IDLE_MS;
  expect(store.nonce()).toBeDefined();
  expect(store.issue()).toBeDefined();
});

it("reauth rotates CSRF and the ID but preserves the absolute lifetime", () => {
  let now = 1000;
  const store = createSessionStore(() => now);
  store.synchronize("synthetic-authority");
  let id = store.issue()!;
  const original = id;
  const csrfBefore = store.read(id)!.csrfToken;
  for (let i = 0; i < 23; i++) {
    now += 20 * 60_000;
    id = store.renew(id)!;
    expect(store.read(id)!.authenticatedAt).toBe(now);
  }
  expect(store.read(original)).toBeUndefined();
  expect(store.read(id)!.csrfToken).not.toBe(csrfBefore);
  now += 20 * 60_000;
  expect(store.renew(id)).toBeUndefined();
});

describe("admin form policy", () => {
  it("guards opted-in POSTs before effects, including bearer attempts; rejects wrong types, repeated fields and large bodies", async () => {
    let effects = 0;
    const { app, advance } = fixture({
      extra: [
        {
          method: "POST",
          path: "/admin/inspect",
          exposure: "operator",
          adminSession: true,
          contentType: "text/html",
          handler: async (c) => {
            effects++;
            const body = await c.req.parseBody();
            return c.html(
              `<p>${body.choice === "safe" ? "safe" : "unknown"}</p>`,
            );
          },
        },
      ],
    });
    const a = await login(app),
      b = await login(app);
    const token = csrf(
      await (
        await request(app, "/admin", { headers: { cookie: a.cookie } })
      ).text(),
    );
    for (const [cookies, submitted, origin] of [
      [a.cookie, "", ""],
      [a.cookie, "forged", "https://admin.private.test"],
      [b.cookie, token, "https://admin.private.test"],
    ]) {
      expect(
        (
          await post(
            app,
            "/admin/inspect",
            cookies!,
            { csrf: submitted! },
            { origin: origin! },
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await post(
          app,
          "/admin/inspect",
          "",
          {},
          { authorization: `Bearer ${TOKEN}` },
        )
      ).status,
    ).toBe(401);
    expect(effects).toBe(0);
    const ok = await post(app, "/admin/inspect", a.cookie, {
      csrf: token,
      choice: "safe",
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<p>safe</p>");
    expect(effects).toBe(1);
    const headers = {
      cookie: a.cookie,
      origin: "https://admin.private.test",
      "content-type": "application/json",
    };
    expect(
      (
        await request(app, "/admin/inspect", {
          method: "POST",
          headers,
          body: JSON.stringify({ csrf: token }),
        })
      ).status,
    ).toBe(401);
    headers["content-type"] = "application/x-www-form-urlencoded";
    expect(
      (
        await request(app, "/admin/inspect", {
          method: "POST",
          headers,
          body: `csrf=${token}&csrf=${token}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app, "/admin/inspect", {
          method: "POST",
          headers,
          body: "x".repeat(65_537),
        })
      ).status,
    ).toBe(400);
    expect(effects).toBe(1);
    advance(60_000);
    for (let i = 0; i < 10; i++)
      expect((await post(app, "/admin/login", "", {})).status).toBe(401);
    expect((await post(app, "/admin/login", "", {})).status).toBe(429);
  });

  it("bounds HTML and keeps failures, missing routes and credential-free redirects private", async () => {
    const { app } = fixture({
      extra: [
        {
          method: "GET",
          path: "/admin/large",
          exposure: "operator",
          adminSession: true,
          contentType: "text/html",
          handler: (c) => c.html("x".repeat(1_048_577)),
        },
      ],
    });
    const a = await login(app);
    const large = await request(app, "/admin/large", {
      headers: { cookie: a.cookie },
    });
    expect(large.status).toBe(500);
    expect(large.headers.get("cache-control")).toBe("no-store");
    const missing = await request(app, "/admin/unknown");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const p = await request(app, "/admin/login");
    const wrong = await post(
      app,
      "/admin/login",
      p.headers.getSetCookie()[0]!.split(";")[0]!,
      { csrf: csrf(await p.text()), credential: "synthetic-private-marker" },
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain("synthetic-private-marker");
  });
});

it("the stale-cookie rejection check catches a planted revoke mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/session.ts", import.meta.url),
    "return sessions.delete(digest(id));",
    "return false;",
  );
  try {
    const broken = (await import(mutant.path)) as typeof sessions;
    const check = (make: typeof sessions.createSessionStore) => {
      const store = make();
      store.synchronize("synthetic-authority");
      const id = store.issue()!;
      store.revoke(id);
      return store.read(id) === undefined;
    };
    expect(check(sessions.createSessionStore)).toBe(true);
    expect(check(broken.createSessionStore)).toBe(false);
  } finally {
    await mutant.cleanup();
  }
});
