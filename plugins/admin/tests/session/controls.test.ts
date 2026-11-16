import { expect, it } from "vitest";
import { withSessionControls } from "../../src/session.js";

it("renders ordinary no-JS session controls and escapes the core CSRF value", () => {
  const html = "<main><h1>Admin</h1></main>";
  expect(withSessionControls(html, undefined)).toBe(html);
  const session = withSessionControls(html, {
    csrfToken: 'synthetic"><img src=x>',
    authenticatedAt: 0,
  });
  expect(session).toContain('method="post" action="/admin/logout"');
  expect(session).toContain('href="/admin/reauth"');
  expect(session).toContain("&quot;&gt;&lt;img src=x&gt;");
  expect(session).not.toContain("<img");
  expect(session).not.toContain("<script");
});
