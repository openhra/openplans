import { describe, expect, it } from "vitest";
import { ADMIN_CSP } from "../../../src/operator/csrf.js";
import {
  ABSOLUTE_MS,
  IDLE_MS,
  NONCE_MS,
  SESSION_COOKIE,
} from "../../../src/operator/session.js";
import {
  csrf,
  fixture,
  login,
  ORIGIN,
  post,
  request,
  TOKEN,
} from "./helpers.js";

function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(ADMIN_CSP);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

describe("private admin browser sessions", () => {
  it("signs in, navigates, rotates recent authentication, and revokes on logout using ordinary forms", async () => {
    const { app, advance } = fixture();
    const redirect = await request(app, "/admin");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("/admin/login");
    privateResponse(redirect);
    const signed = await login(app);
    expect(signed.response.status).toBe(303);
    privateResponse(signed.response);
    const header = signed.response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!;
    expect(header).toContain(
      "Path=/admin; Max-Age=28800; HttpOnly; Secure; SameSite=Strict",
    );
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain(TOKEN);
    const overview = await request(app, "/admin", {
      headers: { cookie: signed.cookie },
    });
    expect(overview.status).toBe(200);
    privateResponse(overview);
    const html = await overview.text();
    expect(html).toContain('method="post" action="/admin/logout"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain(TOKEN);
    advance(6 * 60_000);
    const reauth = await request(app, "/admin/reauth", {
      headers: { cookie: signed.cookie },
    });
    const renewed = await post(app, "/admin/reauth", signed.cookie, {
      csrf: csrf(await reauth.text()),
      credential: TOKEN,
    });
    expect(renewed.status).toBe(303);
    privateResponse(renewed);
    const next = renewed.headers.getSetCookie()[0]!.split(";")[0]!;
    expect(next).not.toBe(signed.cookie);
    expect(
      (await request(app, "/admin", { headers: { cookie: signed.cookie } }))
        .status,
    ).toBe(303);
    const renewedPage = await request(app, "/admin", {
      headers: { cookie: next },
    });
    const out = await post(app, "/admin/logout", next, {
      csrf: csrf(await renewedPage.text()),
    });
    expect(out.status).toBe(303);
    privateResponse(out);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      (await request(app, "/admin", { headers: { cookie: next } })).status,
    ).toBe(303);
  });

  it("expires idle/absolute sessions and login nonces; restarts and token changes revoke cookies", async () => {
    const f = fixture();
    let signed = await login(f.app);
    f.advance(IDLE_MS);
    expect(
      (await request(f.app, "/admin", { headers: { cookie: signed.cookie } }))
        .status,
    ).toBe(303);
    signed = await login(f.app);
    for (let elapsed = 0; elapsed < ABSOLUTE_MS; elapsed += 20 * 60_000) {
      f.advance(20 * 60_000);
      const r = await request(f.app, "/admin", {
        headers: { cookie: signed.cookie },
      });
      expect(r.status).toBe(elapsed + 20 * 60_000 >= ABSOLUTE_MS ? 303 : 200);
    }
    const noncePage = await request(f.app, "/admin/login");
    const nonce = csrf(await noncePage.text());
    f.advance(NONCE_MS);
    const expired = await post(
      f.app,
      "/admin/login",
      noncePage.headers.getSetCookie()[0]!.split(";")[0]!,
      { csrf: nonce, credential: TOKEN },
    );
    expect(expired.status).toBe(401);
    signed = await login(f.app);
    expect(
      (
        await request(fixture().app, "/admin", {
          headers: { cookie: signed.cookie },
        })
      ).status,
    ).toBe(303);
    f.credential("synthetic-rotated");
    expect(
      (await request(f.app, "/admin", { headers: { cookie: signed.cookie } }))
        .status,
    ).toBe(303);
    f.credential();
    expect((await request(f.app, "/admin/login")).status).toBe(404);
    expect(
      (await request(f.app, "/admin", { headers: { cookie: signed.cookie } }))
        .status,
    ).toBe(404);
    privateResponse(await request(f.app, "/admin/login"));
  });

  it("refuses login CSRF, nonce reuse, fixation, redirects, foreign/missing origin, and credential echo", async () => {
    const { app } = fixture();
    const page = await request(app, "/admin/login");
    const nonce = csrf(await page.text());
    const nonceCookie = page.headers.getSetCookie()[0]!.split(";")[0]!;
    const foreign = await post(
      app,
      "/admin/login",
      nonceCookie,
      { csrf: nonce, credential: TOKEN },
      { origin: "https://foreign.test" },
    );
    expect(foreign.status).toBe(401);
    expect(await foreign.text()).not.toContain(TOKEN);
    expect(
      (
        await post(app, "/admin/login", nonceCookie, {
          csrf: nonce,
          credential: TOKEN,
        })
      ).status,
    ).toBe(401);
    for (const headers of [{ origin: "" }, { cookie: "" }] as Record<
      string,
      string
    >[]) {
      const p = await request(app, "/admin/login");
      const r = await post(
        app,
        "/admin/login",
        p.headers.getSetCookie()[0]!.split(";")[0]!,
        { csrf: csrf(await p.text()), credential: TOKEN },
        headers,
      );
      expect(r.status).toBe(401);
    }
    const fixed = `${SESSION_COOKIE}=${"a".repeat(43)}`;
    expect(
      (await request(app, "/admin", { headers: { cookie: fixed } })).status,
    ).toBe(303);
    const signed = await login(app, fixed);
    expect(signed.cookie).not.toBe(fixed);
    const redirect = await request(
      app,
      "/admin/login?next=https://foreign.test",
    );
    expect(redirect.status).toBe(401);
    expect(redirect.headers.get("location")).toBeNull();
    expect(
      (await post(app, "/admin/login?next=//foreign.test", "", {})).status,
    ).toBe(401);
    privateResponse(redirect);
  });

  it("requires same-session CSRF and exact Origin before logout and reauthentication", async () => {
    const { app, advance } = fixture();
    const a = await login(app),
      b = await login(app);
    const html = await (
      await request(app, "/admin", { headers: { cookie: a.cookie } })
    ).text();
    const token = csrf(html);
    for (const path of ["/admin/logout", "/admin/reauth"]) {
      for (const [cookies, value, origin] of [
        [a.cookie, "", ORIGIN],
        [a.cookie, "forged", ORIGIN],
        [b.cookie, token, ORIGIN],
        [a.cookie, token, ""],
        [a.cookie, token, "https://foreign.test"],
      ]) {
        const result = await post(
          app,
          path,
          cookies!,
          {
            csrf: value!,
            ...(path === "/admin/reauth" ? { credential: TOKEN } : {}),
          },
          { origin: origin! },
        );
        expect(result.status).toBe(401);
        privateResponse(result);
      }
      expect(
        (await request(app, "/admin", { headers: { cookie: a.cookie } }))
          .status,
      ).toBe(200);
      advance(60_000);
    }
  });

  it("refuses insecure HTTP, foreign Host, untrusted proxy headers, unreviewed ingress and replicas", async () => {
    const f = fixture();
    for (const [url, headers] of [
      ["http://admin.private.test/admin/login", {}],
      [`${ORIGIN}/admin/login`, { host: "foreign.test" }],
      [
        `${ORIGIN}/admin/login`,
        {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "admin.private.test",
        },
      ],
    ] as const) {
      const r = await f.app.request(url, { headers });
      expect(r.status).toBe(401);
      privateResponse(r);
    }
    const proxy = fixture({ peer: "127.0.0.1", trusted: ["127.0.0.1"] });
    expect(
      (
        await proxy.app.request("http://admin.private.test/admin/login", {
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "admin.private.test",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await proxy.app.request("http://admin.private.test/admin/login", {
          headers: {
            "x-forwarded-proto": "http",
            "x-forwarded-host": "admin.private.test",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (await request(fixture({ reviewed: false }).app, "/admin/login")).status,
    ).toBe(404);
    expect(
      (await request(fixture({ enabled: false }).app, "/admin/login")).status,
    ).toBe(404);
    expect(() => fixture({ instances: 2 })).toThrow(/one API instance/);
    expect(() => fixture({ origin: "http://localhost" })).toThrow(
      /Invalid OpenPlans configuration/,
    );
  });
});
