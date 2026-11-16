import { Hono } from "hono";
import { expect, it } from "vitest";
import * as csrf from "../../../src/operator/csrf.js";
import * as sessions from "../../../src/operator/session.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import { ORIGIN } from "./helpers.js";

it("the login Origin check detects a disposable CSRF bypass", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/csrf.ts", import.meta.url),
    'return (c.req.header("origin") === origin && credentialMatches(submitted, expected));',
    "return true;",
  );
  try {
    const broken = (await import(mutant.path)) as typeof csrf;
    const check = async (guard: typeof csrf.validCsrf) => {
      const app = new Hono();
      app.post("/admin/login", (c) =>
        c.json({
          allowed: guard(c, ORIGIN, "synthetic-nonce", "synthetic-nonce"),
        }),
      );
      const response = await app.request(`${ORIGIN}/admin/login`, {
        method: "POST",
        headers: { origin: "https://foreign.test" },
      });
      return (await response.json()) as { allowed: boolean };
    };
    expect((await check(csrf.validCsrf)).allowed).toBe(false);
    expect((await check(broken.validCsrf)).allowed).toBe(true);
  } finally {
    await mutant.cleanup();
  }
});

it("the transport check detects an insecure HTTP mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/csrf.ts", import.meta.url),
    'return url.origin === origin && url.protocol === "https:";',
    "return true;",
  );
  try {
    const broken = (await import(mutant.path)) as typeof csrf;
    const check = async (guard: typeof csrf.privateTransport) => {
      const app = new Hono();
      app.get("/admin/login", (c) => c.json({ allowed: guard(c, ORIGIN, []) }));
      return (await (
        await app.request("http://admin.private.test/admin/login")
      ).json()) as { allowed: boolean };
    };
    expect((await check(csrf.privateTransport)).allowed).toBe(false);
    expect((await check(broken.privateTransport)).allowed).toBe(true);
  } finally {
    await mutant.cleanup();
  }
});

it("the fixed-cookie check detects an authorization bypass mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/session.ts", import.meta.url),
    "const state = sessions.get(key);",
    "const state = sessions.get(key) ?? { createdAt: now(), seenAt: now(), authenticatedAt: now() };",
  );
  try {
    const broken = (await import(mutant.path)) as typeof sessions;
    const check = (make: typeof sessions.createSessionStore) => {
      const store = make();
      store.synchronize("synthetic-authority");
      return store.read("x".repeat(43)) === undefined;
    };
    expect(check(sessions.createSessionStore)).toBe(true);
    expect(check(broken.createSessionStore)).toBe(false);
  } finally {
    await mutant.cleanup();
  }
});
