import { escapeHtml } from "./html.js";

/** Core supplies this context only after authorizing the scoped browser session. */
export function withSessionControls(
  html: string,
  session: { csrfToken: string; authenticatedAt: number } | undefined,
): string {
  if (!session) return html;
  return html.replace(
    "</main>",
    `<section aria-label="Session"><a href="/admin/reauth">Authenticate again</a><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><button type="submit">Sign out</button></form></section></main>`,
  );
}
