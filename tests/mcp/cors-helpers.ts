import { expect } from "vitest";
import { metadata, post } from "./transport-helpers.js";

export const allowedOrigin = "https://allowed.example";

export function expectCorsHeaders(response: Response, origin = allowedOrigin) {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(
    response.headers
      .get("vary")
      ?.toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  ).toContain("origin");
  const exposed = response.headers
    .get("access-control-expose-headers")
    ?.toLowerCase()
    .split(",")
    .map((s) => s.trim());
  expect(exposed).toEqual(
    expect.arrayContaining([
      "mcp-session-id",
      "mcp-protocol-version",
      "www-authenticate",
      "retry-after",
    ]),
  );
  expect(exposed).not.toContain("*");
}

export async function corsRequest(kind: "JSON" | "SSE" | "error") {
  if (kind === "JSON")
    return post("server/discover", {}, { origin: allowedOrigin });
  if (kind === "error")
    return post(
      "server/discover",
      {},
      { origin: allowedOrigin, "content-type": "text/plain" },
    );
  const request = post(
    "tools/call",
    { name: "get_data_status", arguments: {} },
    { origin: allowedOrigin },
  );
  const body = JSON.parse(await request.text());
  body.params._meta = { ...metadata, progressToken: "synthetic-cors-progress" };
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  });
}
