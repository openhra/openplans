import type { Hono } from "hono";
import { contract } from "./public-contract.js";

const { rest, jsonrpc } = contract.errors;

/**
 * A REST error body carries the response's request id in `error.request_id`, the same value as
 * the header (docs/public-contract.json `request_id`). JSON-RPC errors carry the header only.
 */
export function assertRequestId(response: Response, body: unknown): void {
  const { header, error_member, accepted_pattern } = contract.request_id;
  const id = response.headers.get(header);
  if (!id || !new RegExp(accepted_pattern).test(id))
    throw new Error(`Response is missing a valid ${header}`);
  if (!body || typeof body !== "object" || "jsonrpc" in body) return;
  const error = (body as Record<string, unknown>)[rest.envelope] as
    Record<string, unknown> | undefined;
  if (error?.[error_member] !== id)
    throw new Error(`REST error.${error_member} must equal the ${header}`);
}

/** REST errors carry a code; JSON-RPC keeps its numeric protocol codes (docs/public-contract.json). */
export function assertErrorShape(body: unknown): void {
  if (!body || typeof body !== "object" || !(rest.envelope in body))
    throw new Error("Error response is missing error.code");
  const error = (body as Record<string, unknown>)[rest.envelope];
  if (!error || typeof error !== "object" || !("code" in error))
    throw new Error("Error response requires an error object with a code");
  const fields = error as Record<string, unknown>;
  if ("jsonrpc" in body) {
    if (
      body.jsonrpc !== "2.0" ||
      jsonrpc.required.code !== "integer" ||
      !Number.isInteger(fields.code) ||
      !Object.entries(jsonrpc.required).every(
        ([key, type]) =>
          key in fields &&
          (type === "integer"
            ? Number.isInteger(fields[key])
            : typeof fields[key] === type),
      )
    )
      throw new Error("Invalid JSON-RPC error");
  } else {
    if (
      rest.required.code !== "string" ||
      typeof fields.code !== "string" ||
      !fields.code.trim()
    )
      throw new Error("REST error.code must be a nonempty string");
    if (!new RegExp(rest.code_pattern ?? ".").test(fields.code))
      throw new Error(
        `REST error.code is not lower snake case: ${fields.code}`,
      );
    for (const key of Object.keys(rest.optional ?? {}))
      if (key in fields && typeof fields[key] !== "string")
        throw new Error(`REST error.${key} must be a string`);
  }
}

/**
 * Every unknown the body names without a reason, as JSON paths. A `status: "unknown"` object
 * needs `reason`; a `<x>_status: "unknown"` member needs `<x>_reason` or an `<x>_coverage`
 * object with its own reason. Empty when every unknown says why.
 */
export function unknownsWithoutReason(body: unknown, path = "$"): string[] {
  if (Array.isArray(body))
    return body.flatMap((item, i) =>
      unknownsWithoutReason(item, `${path}[${i}]`),
    );
  if (!body || typeof body !== "object") return [];
  const object = body as Record<string, unknown>;
  const found: string[] = [];
  const named = (value: unknown) => typeof value === "string" && value !== "";
  if (object.status === "unknown" && !named(object.reason)) found.push(path);
  for (const [key, value] of Object.entries(object)) {
    if (value === "unknown" && key.endsWith("_status")) {
      const stem = key.slice(0, -"_status".length);
      const coverage = object[`${stem}_coverage`] as {
        reason?: unknown;
      } | null;
      if (!named(object[`${stem}_reason`]) && !named(coverage?.reason))
        found.push(`${path}.${key}`);
    }
    found.push(...unknownsWithoutReason(value, `${path}.${key}`));
  }
  return found;
}

/** Every mounted route with its path parameters filled, one entry per method and path. */
export function mountedRoutes(app: Hono): { method: string; path: string }[] {
  const seen = new Set<string>();
  const routes: { method: string; path: string }[] = [];
  for (const { method, path } of app.routes) {
    if (path.includes("*") || path === "/admin" || path.startsWith("/admin/"))
      continue;
    const filled = path.replace(/:([A-Za-z_]+)(\{[^}]*\})?\??/g, "x");
    const key = `${method} ${filled}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: method === "ALL" ? "GET" : method, path: filled });
  }
  return routes;
}
